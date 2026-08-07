/**
 * `task` domain — `AgentTaskPersistence`, the per-agent task
 * persistence helper.
 *
 * Persists task state (`<taskId>.json`) and raw task output (`output.log`)
 * through the `storage` access-pattern stores (`IAtomicDocumentStore` for
 * atomic whole-document state, `IFileSystemStorageService` byte primitives for ordered
 * output append), addressed under the owning agent's storage scope
 * (`<sessionScope>/agents/<agentId>/tasks/…`) so the domain never touches the
 * filesystem and each agent reads back exactly its own records — v1's
 * per-agent `<sessionDir>/agents/<id>/tasks/` layout. An optional read-only
 * fallback keeps the previous v2 session-level task root readable during the
 * layout transition; primary agent keys and output files always win, while
 * every write remains rooted at the owning agent. Task ids are validated
 * against the `{prefix}-{8 hex}` shape before use as path segments
 * (path-traversal and legacy `bg_<hex>` guard), and legacy snake_case records
 * are normalized to the current shape on read. Scope-expansion candidates
 * persist under the task's scope too: path payloads into byte storage
 * (`candidate/<side>/<relPath>`), the state-only manifest as an atomic
 * document (`<taskId>.candidate.json`), with resolutions folded back into
 * the manifest for idempotent re-resolution. A resolution is recorded in two
 * steps — first as `phase: 'pending'` before the workspace is touched, then
 * without a phase once the apply is confirmed — so a process that dies
 * mid-apply leaves a record the next process can reconcile against the
 * workspace instead of a candidate that can never be resolved. Not
 * scope-bound.
 */

import { join } from 'pathe';

import { BugIndicatingError } from '#/errors';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { AgentTaskInfo, AgentTaskStatus } from './types';

const VALID_TASK_ID: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{8}$/;

const TASKS_SCOPE = 'tasks';
const OUTPUT_LOG_KEY = 'output.log';
const JSON_SUFFIX = '.json';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type PersistedTask = AgentTaskInfo;

type DiskPersistedTask = PersistedTask | LegacyPersistedTask;

/** Path-level candidate manifest record (state only; payloads live in byte storage). */
export interface EditingCandidateManifestPath {
  readonly relPath: string;
  readonly classification: import('#/session/subagent/worktree').EditingCandidatePathClassification;
  readonly before: import('#/session/subagent/worktree').EditingCandidatePathState;
  readonly after: import('#/session/subagent/worktree').EditingCandidatePathState;
  readonly beforePayload: boolean;
  readonly afterPayload: boolean;
}

export type EditingCandidateResolutionKind = 'approved_applied' | 'denied';

export type EditingCandidateResolution = {
  readonly kind: EditingCandidateResolutionKind;
  readonly resolvedAt: string;
  readonly phase?: 'pending';
};

export type EditingCandidateResolutionReplay = 'none' | 'pending' | 'resolved';

export interface EditingCandidateResolutionIntent {
  readonly manifest: EditingCandidateManifestV1;
  readonly replay: EditingCandidateResolutionReplay;
}

export interface EditingCandidateManifestV1 {
  readonly version: 1;
  readonly taskId: string;
  readonly repoRoot: string;
  readonly commonDir: string;
  readonly headCommit: string;
  readonly originalScope: readonly string[];
  readonly requestedScope: readonly string[];
  readonly candidateHash: string;
  readonly createdAt: string;
  readonly paths: readonly EditingCandidateManifestPath[];
  readonly resolution?: EditingCandidateResolution;
}

export interface LoadedEditingCandidate {
  readonly manifest: EditingCandidateManifestV1;
  readonly draft: import('#/session/subagent/worktree').EditingCandidateDraft;
}

export interface EditingCandidateResolutionWriteResult {
  readonly manifest: EditingCandidateManifestV1;
  readonly idempotent: boolean;
}

export interface AgentTaskPersistenceRoot {
  readonly dir: string;
  readonly scope: string;
}

export interface AgentTaskStoredOutputSnapshot {
  readonly outputPath: string;
  readonly outputSizeBytes: number;
  readonly previewBytes: number;
  readonly truncated: boolean;
  readonly preview: string;
}

interface ListedTask {
  readonly keyId: string;
  readonly task: PersistedTask;
}

interface TaskOutputData {
  readonly root: AgentTaskPersistenceRoot;
  readonly data: Uint8Array;
}

function validateTaskId(taskId: string): void {
  if (!VALID_TASK_ID.test(taskId)) {
    throw new BugIndicatingError(`Invalid task id: "${taskId}"`);
  }
}

export class AgentTaskPersistence {
  constructor(
    private readonly agentDir: string,
    private readonly agentScope: string,
    private readonly docs: IAtomicDocumentStore,
    private readonly bytes: IFileSystemStorageService,
    private readonly fallbackRoot?: AgentTaskPersistenceRoot,
  ) {}

  private primaryRoot(): AgentTaskPersistenceRoot {
    return { dir: this.agentDir, scope: this.agentScope };
  }

  private tasksScope(root: AgentTaskPersistenceRoot = this.primaryRoot()): string {
    return `${root.scope}/${TASKS_SCOPE}`;
  }

  private taskOutputScope(
    taskId: string,
    root: AgentTaskPersistenceRoot = this.primaryRoot(),
  ): string {
    validateTaskId(taskId);
    return `${root.scope}/${TASKS_SCOPE}/${taskId}`;
  }

  private taskOutputFileAt(taskId: string, root: AgentTaskPersistenceRoot): string {
    validateTaskId(taskId);
    return join(root.dir, TASKS_SCOPE, taskId, OUTPUT_LOG_KEY);
  }

  taskOutputFile(taskId: string): string {
    return this.taskOutputFileAt(taskId, this.primaryRoot());
  }

  async writeTask(task: PersistedTask): Promise<void> {
    validateTaskId(task.taskId);
    await this.docs.set(this.tasksScope(), `${task.taskId}${JSON_SUFFIX}`, task);
  }

  async readTask(taskId: string): Promise<PersistedTask | undefined> {
    validateTaskId(taskId);
    const key = `${taskId}${JSON_SUFFIX}`;
    const task = await this.docs.get<DiskPersistedTask>(this.tasksScope(), key);
    if (task !== undefined) {
      return isReadablePersistedTask(task) ? normalizePersistedTask(task) : undefined;
    }
    const fallbackRoot = this.fallbackRoot;
    if (fallbackRoot === undefined) return undefined;
    const fallback = await this.docs.get<DiskPersistedTask>(this.tasksScope(fallbackRoot), key);
    if (fallback === undefined || !isReadablePersistedTask(fallback)) return undefined;
    return normalizePersistedTask(fallback);
  }

  async appendTaskOutput(taskId: string, chunk: string): Promise<void> {
    if (chunk.length === 0) return;
    await this.bytes.append(this.taskOutputScope(taskId), OUTPUT_LOG_KEY, textEncoder.encode(chunk));
  }

  async taskOutputSizeBytes(taskId: string): Promise<number> {
    const output = await this.readTaskOutputData(taskId);
    return output?.data.byteLength ?? 0;
  }

  async taskOutputExists(taskId: string): Promise<boolean> {
    return (await this.readTaskOutputData(taskId)) !== undefined;
  }

  async readTaskOutputBytes(taskId: string, offset: number, maxBytes: number): Promise<string> {
    const start = Math.max(0, Math.trunc(offset));
    const limit = Math.max(0, Math.trunc(maxBytes));
    if (limit === 0) return '';
    const output = await this.readTaskOutputData(taskId);
    if (output === undefined || start >= output.data.byteLength) return '';
    const end = Math.min(output.data.byteLength, start + limit);
    return textDecoder.decode(output.data.subarray(start, end));
  }

  async readTaskOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<AgentTaskStoredOutputSnapshot | undefined> {
    const output = await this.readTaskOutputData(taskId);
    if (output === undefined) return undefined;
    const previewLimit = Math.max(0, Math.trunc(maxPreviewBytes));
    const previewBytes = Math.min(previewLimit, output.data.byteLength);
    const previewOffset = output.data.byteLength - previewBytes;
    return {
      outputPath: this.taskOutputFileAt(taskId, output.root),
      outputSizeBytes: output.data.byteLength,
      previewBytes,
      truncated: previewOffset > 0,
      preview: textDecoder.decode(output.data.subarray(previewOffset)),
    };
  }

  async listTasks(): Promise<readonly PersistedTask[]> {
    const primary = await this.listTasksAt(this.primaryRoot());
    const tasks = [...primary.tasks];
    const fallbackRoot = this.fallbackRoot;
    if (fallbackRoot !== undefined) {
      const fallback = await this.listTasksAt(fallbackRoot);
      for (const entry of fallback.tasks) {
        if (!primary.reservedIds.has(entry.keyId)) tasks.push(entry);
      }
    }
    return tasks.map((entry) => entry.task).toSorted((a, b) => a.taskId.localeCompare(b.taskId));
  }

  async writeEditingCandidate(
    taskId: string,
    draft: import('#/session/subagent/worktree').EditingCandidateDraft,
  ): Promise<EditingCandidateManifestV1> {
    validateTaskId(taskId);
    const scope = this.taskOutputScope(taskId);
    for (const path of draft.paths) {
      await this.writeCandidatePayload(scope, taskId, 'before', path.relPath, path.before);
      await this.writeCandidatePayload(scope, taskId, 'after', path.relPath, path.after);
    }
    const manifest: EditingCandidateManifestV1 = {
      version: 1,
      taskId,
      repoRoot: draft.repoRoot,
      commonDir: draft.commonDir,
      headCommit: draft.headCommit,
      originalScope: draft.scope,
      requestedScope: draft.requestedScope,
      candidateHash: draft.candidateHash,
      createdAt: new Date().toISOString(),
      paths: draft.paths.map((path) => ({
        relPath: path.relPath,
        classification: path.classification,
        before: path.before.state,
        after: path.after.state,
        beforePayload: path.before.payload !== undefined,
        afterPayload: path.after.payload !== undefined,
      })),
    };
    await this.docs.set(this.tasksScope(), `${taskId}.candidate.json`, manifest);
    return manifest;
  }

  async readEditingCandidateManifest(
    taskId: string,
  ): Promise<EditingCandidateManifestV1 | undefined> {
    validateTaskId(taskId);
    return await this.docs.get<EditingCandidateManifestV1>(
      this.tasksScope(),
      `${taskId}.candidate.json`,
    );
  }

  async beginEditingCandidateResolution(
    taskId: string,
    candidateHash: string,
    kind: EditingCandidateResolutionKind,
  ): Promise<EditingCandidateResolutionIntent> {
    const manifest = await this.readEditingCandidateManifest(taskId);
    if (manifest === undefined) {
      throw new Error('candidate_corrupt: candidate persistence is unavailable');
    }
    if (manifest.candidateHash !== candidateHash) {
      throw new Error('candidate_identity_mismatch: candidate hash does not match');
    }
    const existing = manifest.resolution;
    if (existing !== undefined) {
      if (existing.kind !== kind) {
        throw new Error('candidate_already_resolved: candidate has an incompatible resolution');
      }
      return { manifest, replay: existing.phase === 'pending' ? 'pending' : 'resolved' };
    }
    const updated: EditingCandidateManifestV1 = {
      ...manifest,
      resolution: { kind, resolvedAt: new Date().toISOString(), phase: 'pending' },
    };
    await this.docs.set(this.tasksScope(), `${taskId}.candidate.json`, updated);
    return { manifest: updated, replay: 'none' };
  }

  async readEditingCandidate(taskId: string): Promise<LoadedEditingCandidate> {
    const manifest = await this.readEditingCandidateManifest(taskId);
    if (manifest === undefined) {
      throw new Error('candidate_corrupt: candidate persistence is unavailable');
    }
    const scope = this.taskOutputScope(taskId);
    const paths: import('#/session/subagent/worktree').EditingCandidatePath[] = [];
    for (const record of manifest.paths) {
      paths.push({
        relPath: record.relPath,
        classification: record.classification,
        before: await this.readCandidatePayload(scope, 'before', record),
        after: await this.readCandidatePayload(scope, 'after', record),
      });
    }
    const draft: import('#/session/subagent/worktree').EditingCandidateDraft = {
      version: 1,
      candidateHash: manifest.candidateHash,
      repoRoot: manifest.repoRoot,
      commonDir: manifest.commonDir,
      headCommit: manifest.headCommit,
      scope: manifest.originalScope,
      requestedScope: manifest.requestedScope,
      paths,
    };
    return { manifest, draft };
  }

  async writeEditingCandidateResolution(
    taskId: string,
    candidateHash: string,
    resolution: EditingCandidateResolution,
  ): Promise<EditingCandidateResolutionWriteResult> {
    const manifest = await this.readEditingCandidateManifest(taskId);
    if (manifest === undefined) {
      throw new Error('candidate_corrupt: candidate persistence is unavailable');
    }
    if (manifest.candidateHash !== candidateHash) {
      throw new Error('candidate_identity_mismatch: candidate hash does not match');
    }
    if (manifest.resolution !== undefined && manifest.resolution.kind !== resolution.kind) {
      throw new Error('candidate_already_resolved: candidate has an incompatible resolution');
    }
    const idempotent = manifest.resolution !== undefined && manifest.resolution.phase !== 'pending';
    const updated: EditingCandidateManifestV1 = {
      ...manifest,
      resolution: { kind: resolution.kind, resolvedAt: resolution.resolvedAt },
    };
    await this.docs.set(this.tasksScope(), `${taskId}.candidate.json`, updated);
    return { manifest: updated, idempotent };
  }

  private async writeCandidatePayload(
    scope: string,
    taskId: string,
    side: 'before' | 'after',
    relPath: string,
    snapshot: import('#/session/subagent/worktree').EditingCandidatePathSnapshot,
  ): Promise<void> {
    if (snapshot.payload === undefined) return;
    await this.bytes.write(scope, `candidate/${side}/${relPath}`, snapshot.payload);
  }

  private async readCandidatePayload(
    scope: string,
    side: 'before' | 'after',
    record: EditingCandidateManifestPath,
  ): Promise<import('#/session/subagent/worktree').EditingCandidatePathSnapshot> {
    const state = side === 'before' ? record.before : record.after;
    if (state.kind !== 'regular') return { state };
    const hasPayload = side === 'before' ? record.beforePayload : record.afterPayload;
    if (!hasPayload) return { state };
    const payload = await this.bytes.read(scope, `candidate/${side}/${record.relPath}`);
    if (payload === undefined) {
      throw new Error(`candidate_corrupt: missing ${side} payload for ${record.relPath}`);
    }
    return { state, payload };
  }

  private async listTasksAt(root: AgentTaskPersistenceRoot): Promise<{
    readonly reservedIds: ReadonlySet<string>;
    readonly tasks: readonly ListedTask[];
  }> {
    const keys = (await this.docs.list(this.tasksScope(root))).toSorted();
    const reservedIds = new Set<string>();
    const tasks: ListedTask[] = [];
    for (const key of keys) {
      if (!key.endsWith(JSON_SUFFIX)) continue;
      const id = key.slice(0, -JSON_SUFFIX.length);
      if (!VALID_TASK_ID.test(id)) continue;
      reservedIds.add(id);
      let task: DiskPersistedTask | undefined;
      try {
        task = await this.docs.get<DiskPersistedTask>(this.tasksScope(root), key);
      } catch {
        continue;
      }
      if (task === undefined || !isReadablePersistedTask(task)) continue;
      tasks.push({ keyId: id, task: normalizePersistedTask(task) });
    }
    return { reservedIds, tasks };
  }

  private async readTaskOutputData(taskId: string): Promise<TaskOutputData | undefined> {
    const primaryRoot = this.primaryRoot();
    const primary = await this.bytes.read(this.taskOutputScope(taskId, primaryRoot), OUTPUT_LOG_KEY);
    if (primary !== undefined) return { root: primaryRoot, data: primary };
    const fallbackRoot = this.fallbackRoot;
    if (fallbackRoot === undefined) return undefined;
    const fallback = await this.bytes.read(
      this.taskOutputScope(taskId, fallbackRoot),
      OUTPUT_LOG_KEY,
    );
    return fallback === undefined ? undefined : { root: fallbackRoot, data: fallback };
  }
}

function normalizePersistedTask(task: DiskPersistedTask): PersistedTask {
  if (isLegacyPersistedTask(task)) return legacyPersistedTaskToInfo(task);
  return {
    ...task,
    detached: task.detached ?? true,
  };
}

type LegacyAgentTaskStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'lost';

interface LegacyPersistedTask {
  readonly task_id: string;
  readonly command: string;
  readonly description: string;
  readonly pid: number;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly exit_code: number | null;
  readonly status: LegacyAgentTaskStatus;
  readonly timed_out?: boolean;
  readonly stop_reason?: string;
  readonly timeout_ms?: number;
  readonly agent_id?: string;
  readonly subagent_type?: string;
}

function legacyPersistedTaskToInfo(task: LegacyPersistedTask): PersistedTask {
  const status = legacyStatusToCurrent(task);
  const stopReason = optionalNonEmptyString(task.stop_reason);
  const timeoutMs = typeof task.timeout_ms === 'number' ? task.timeout_ms : undefined;
  const base = {
    taskId: task.task_id,
    description: task.description,
    status,
    detached: true,
    startedAt: task.started_at,
    endedAt: task.ended_at,
    stopReason,
    timeoutMs,
  };

  if (task.task_id.startsWith('agent-')) {
    return {
      ...base,
      kind: 'agent',
      agentId: optionalNonEmptyString(task.agent_id),
      subagentType: optionalNonEmptyString(task.subagent_type),
    };
  }

  return {
    ...base,
    kind: 'process',
    command: task.command,
    pid: task.pid,
    exitCode: task.exit_code,
  };
}

function legacyStatusToCurrent(task: LegacyPersistedTask): AgentTaskStatus {
  if (task.status === 'awaiting_approval') return 'running';
  if (task.status === 'failed' && task.timed_out === true) return 'timed_out';
  return task.status;
}

function isReadablePersistedTask(obj: unknown): obj is DiskPersistedTask {
  return (
    isRecord(obj) &&
    (typeof obj['taskId'] === 'string' || typeof obj['task_id'] === 'string')
  );
}

function isLegacyPersistedTask(task: DiskPersistedTask): task is LegacyPersistedTask {
  return 'task_id' in task;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalNonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
