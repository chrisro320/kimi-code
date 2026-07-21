/**
 * Background task persistence helpers.
 *
 * Each task lives at `<sessionDir>/tasks/<taskId>.json` so a CLI restart can
 * restore durable statuses. Only previously-running tasks become lost;
 * `input_required` tasks remain actionable with their immutable candidate
 * bundle under `<sessionDir>/tasks/<taskId>/candidate/`.
 *
 * The per-id JSON layer (write / read / list) is delegated to
 * `createPerIdJsonStore`, which centralises atomic-write +
 * path-traversal-guarded readdir for cron / background / anything else
 * that needs session-scoped per-id JSON. This class keeps the
 * background-specific shape and the output.log helpers together.
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize } from 'pathe';

import type { TokenUsage } from '@moonshot-ai/kosong';

import type { SubagentEditingCandidate } from '../../session/subagent-host';
import {
  assertSubagentWorktreeCandidateIntegrity,
  type EditingCandidateDraft,
  type EditingCandidatePathClassification,
  type EditingCandidatePathState,
} from '../../session/subagent-worktree';
import { atomicWrite } from '../../utils/fs';
import { createPerIdJsonStore, type PerIdJsonStore } from '../../utils/per-id-json-store';
import type { BackgroundTaskInfo, BackgroundTaskStatus } from './task';

/**
 * Task id format: `{prefix}-{8 chars of [0-9a-z]}`.
 *
 * Strictly enforced before deriving task paths so neither path-traversal
 * (`../`) nor a legacy `bg_<hex>` format can escape through the
 * persistence layer. The prefix is intentionally open-ended so new task
 * kinds do not need persistence-layer changes.
 */
const VALID_TASK_ID: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{8}$/;

type PersistedTask = BackgroundTaskInfo;

type DiskPersistedTask = PersistedTask | LegacyPersistedTask;

export interface EditingCandidateManifestPath {
  readonly relPath: string;
  readonly classification: EditingCandidatePathClassification;
  readonly before: EditingCandidatePathState;
  readonly after: EditingCandidatePathState;
  readonly beforePayload: boolean;
  readonly afterPayload: boolean;
}

export type EditingCandidateResolution =
  | { readonly kind: 'approved_applied'; readonly resolvedAt: string }
  | { readonly kind: 'denied'; readonly resolvedAt: string };

export interface EditingCandidateManifestV1 {
  readonly version: 1;
  readonly taskId: string;
  readonly agentId: string;
  readonly logicalRunId: string;
  readonly externalSessionId?: string;
  readonly repoRoot: string;
  readonly commonDir: string;
  readonly headCommit: string;
  readonly originalScope: readonly string[];
  readonly requestedScope: readonly string[];
  readonly candidateHash: string;
  readonly createdAt: string;
  readonly handoff: string;
  readonly usage?: TokenUsage;
  readonly validationEvidence: readonly string[];
  readonly complete: true;
  readonly errors: readonly string[];
  readonly paths: readonly EditingCandidateManifestPath[];
  readonly resolution?: EditingCandidateResolution;
}

export interface LoadedEditingCandidate {
  readonly manifest: EditingCandidateManifestV1;
  readonly draft: EditingCandidateDraft;
}

export interface EditingCandidateResolutionWriteResult {
  readonly manifest: EditingCandidateManifestV1;
  readonly idempotent: boolean;
}

function tasksDirOf(sessionDir: string): string {
  return join(sessionDir, 'tasks');
}

function taskOutputDir(sessionDir: string, taskId: string): string {
  if (!VALID_TASK_ID.test(taskId)) {
    throw new Error(`Invalid task id: "${taskId}"`);
  }
  return join(tasksDirOf(sessionDir), taskId);
}

function taskOutputFile(sessionDir: string, taskId: string): string {
  return join(taskOutputDir(sessionDir, taskId), 'output.log');
}

export class BackgroundTaskPersistence {
  private readonly store: PerIdJsonStore<DiskPersistedTask>;

  constructor(private readonly sessionDir: string) {
    this.store = createPerIdJsonStore<DiskPersistedTask>({
      rootDir: sessionDir,
      subdir: 'tasks',
      idRegex: VALID_TASK_ID,
      isValid: isReadablePersistedTask,
      entityName: 'task id',
    });
  }

  taskOutputFile(taskId: string): string {
    return taskOutputFile(this.sessionDir, taskId);
  }

  /** Atomically write a task's persisted state. Creates dirs as needed. */
  async writeTask(task: PersistedTask): Promise<void> {
    await this.store.write(task.taskId, task);
  }

  async writeEditingCandidate(
    taskId: string,
    candidate: SubagentEditingCandidate,
    handoff: string,
    usage?: TokenUsage,
  ): Promise<EditingCandidateManifestV1> {
    assertSubagentWorktreeCandidateIntegrity(candidate.draft);
    if (
      JSON.stringify(candidate.originalScope) !== JSON.stringify(candidate.draft.scope) ||
      JSON.stringify(candidate.requestedScope) !== JSON.stringify(candidate.draft.requestedScope)
    ) {
      throw new Error('candidate_identity_mismatch: candidate scope metadata does not match draft');
    }
    const candidateDir = join(taskOutputDir(this.sessionDir, taskId), 'candidate');
    await mkdir(candidateDir, { recursive: true, mode: 0o700 });
    const paths: EditingCandidateManifestPath[] = [];
    for (const path of candidate.draft.paths) {
      assertCandidateRelativePath(path.relPath);
      await writeCandidatePayload(candidateDir, 'baseline', path.relPath, path.before.payload);
      await writeCandidatePayload(candidateDir, 'worker-final', path.relPath, path.after.payload);
      paths.push({
        relPath: path.relPath,
        classification: path.classification,
        before: path.before.state,
        after: path.after.state,
        beforePayload: path.before.payload !== undefined,
        afterPayload: path.after.payload !== undefined,
      });
    }
    const manifest: EditingCandidateManifestV1 = {
      version: 1,
      taskId,
      agentId: candidate.agentId,
      logicalRunId: candidate.logicalRunId,
      externalSessionId: candidate.externalSessionId,
      repoRoot: candidate.draft.repoRoot,
      commonDir: candidate.draft.commonDir,
      headCommit: candidate.draft.headCommit,
      originalScope: candidate.originalScope,
      requestedScope: candidate.requestedScope,
      candidateHash: candidate.draft.candidateHash,
      createdAt: new Date().toISOString(),
      handoff,
      usage,
      validationEvidence: ['candidate manifest and regular payload hashes verified'],
      complete: true,
      errors: [],
      paths,
    };
    await verifyCandidatePayloads(candidateDir, manifest);
    await atomicWrite(join(candidateDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  }

  async loadEditingCandidate(taskId: string): Promise<LoadedEditingCandidate> {
    const candidateDir = join(taskOutputDir(this.sessionDir, taskId), 'candidate');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(candidateDir, 'manifest.json'), 'utf-8'));
    } catch {
      throw new Error('candidate_corrupt: manifest is missing or invalid');
    }
    if (!isEditingCandidateManifest(parsed)) {
      throw new Error('candidate_corrupt: manifest schema is invalid');
    }
    if (parsed.taskId !== taskId) {
      throw new Error('candidate_corrupt: manifest task id mismatch');
    }
    for (const path of parsed.paths) assertCandidateRelativePath(path.relPath);
    await verifyCandidatePayloads(candidateDir, parsed);
    const draft: EditingCandidateDraft = {
      version: 1,
      candidateHash: parsed.candidateHash,
      repoRoot: parsed.repoRoot,
      commonDir: parsed.commonDir,
      headCommit: parsed.headCommit,
      scope: parsed.originalScope,
      requestedScope: parsed.requestedScope,
      paths: await Promise.all(parsed.paths.map(async (path) => ({
        relPath: path.relPath,
        classification: path.classification,
        before: {
          state: path.before,
          payload: path.before.kind === 'regular'
            ? await readCandidatePayload(candidateDir, 'baseline', path.relPath)
            : undefined,
        },
        after: {
          state: path.after,
          payload: path.after.kind === 'regular'
            ? await readCandidatePayload(candidateDir, 'worker-final', path.relPath)
            : undefined,
        },
      }))),
    };
    assertSubagentWorktreeCandidateIntegrity(draft);
    return { manifest: parsed, draft };
  }

  async readEditingCandidate(taskId: string): Promise<EditingCandidateManifestV1 | undefined> {
    try {
      return (await this.loadEditingCandidate(taskId)).manifest;
    } catch {
      return undefined;
    }
  }

  async writeEditingCandidateResolution(
    taskId: string,
    expectedCandidateHash: string,
    resolution: EditingCandidateResolution,
  ): Promise<EditingCandidateResolutionWriteResult> {
    const { manifest } = await this.loadEditingCandidate(taskId);
    if (manifest.candidateHash !== expectedCandidateHash) {
      throw new Error('candidate_identity_mismatch: candidate hash does not match');
    }
    if (manifest.resolution !== undefined) {
      if (manifest.resolution.kind !== resolution.kind) {
        throw new Error('candidate_already_resolved: candidate has an incompatible resolution');
      }
      return { manifest, idempotent: true };
    }
    const resolved: EditingCandidateManifestV1 = { ...manifest, resolution };
    const manifestPath = join(taskOutputDir(this.sessionDir, taskId), 'candidate', 'manifest.json');
    await atomicWrite(manifestPath, JSON.stringify(resolved, null, 2));
    return { manifest: resolved, idempotent: false };
  }

  /** Read a single task file. Returns undefined when missing/corrupt/unrecognized. */
  async readTask(taskId: string): Promise<PersistedTask | undefined> {
    const task = await this.store.read(taskId);
    return task === undefined ? undefined : normalizePersistedTask(task);
  }

  async appendTaskOutput(taskId: string, chunk: string): Promise<void> {
    const path = this.taskOutputFile(taskId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, chunk, 'utf-8');
  }

  /**
   * Total byte size of a task's `output.log`. Returns 0 when the log does
   * not exist yet (the task has produced no output, or is unknown).
   *
   * This is the authoritative full-output size — unlike the in-memory ring
   * buffer it is never truncated, so callers can report how much output a
   * task has actually produced.
   */
  async taskOutputSizeBytes(taskId: string): Promise<number> {
    try {
      const st = await stat(this.taskOutputFile(taskId));
      return st.size;
    } catch {
      return 0;
    }
  }

  async taskOutputExists(taskId: string): Promise<boolean> {
    try {
      return (await stat(this.taskOutputFile(taskId))).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Read a byte window of a task's `output.log`.
   *
   * Reads at most `maxBytes` bytes starting at byte `offset`. A window that
   * runs past EOF is clamped to whatever remains; an `offset` at/after EOF
   * yields an empty string. Returns an empty string when the log is absent.
   *
   * Byte-level (not line-level) paging mirrors how the full log is stored
   * on disk, so callers can page arbitrarily large logs without loading the
   * whole file into memory.
   */
  async readTaskOutputBytes(taskId: string, offset: number, maxBytes: number): Promise<string> {
    const start = Math.max(0, Math.trunc(offset));
    const limit = Math.max(0, Math.trunc(maxBytes));
    if (limit === 0) return '';
    let handle;
    try {
      handle = await open(this.taskOutputFile(taskId), 'r');
    } catch {
      return '';
    }
    try {
      const size = (await handle.stat()).size;
      if (start >= size) return '';
      const length = Math.min(limit, size - start);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.toString('utf-8', 0, bytesRead);
    } catch {
      return '';
    } finally {
      await handle.close();
    }
  }

  /**
   * Enumerate all persisted tasks for a session.
   *
   * Skips, silently:
   *   - basenames that don't match `VALID_TASK_ID` (stray files, legacy
   *     `bg_*` leftovers, partially-written temp files);
   *   - files that fail to read / parse;
   *   - records that are neither identifiable as the current camelCase
   *     shape nor the previous snake_case task shape.
   *
   * Legacy snake_case records are normalized to current `BackgroundTaskInfo`
   * in memory. The next lifecycle/reconcile write stores them back in the
   * current format, so compatibility is read-only and opportunistically
   * migrates without a separate migration step.
   *
   * `writeTask` uses atomic temp+rename so a genuinely truncated file in
   * production is rare; if it happens we accept the loss rather than
   * emit a ghost with no recoverable metadata beyond the filename.
   */
  async listTasks(): Promise<readonly PersistedTask[]> {
    const tasks = await this.store.list();
    return tasks.map(normalizePersistedTask);
  }
}

async function writeCandidatePayload(
  candidateDir: string,
  side: 'baseline' | 'worker-final',
  relPath: string,
  payload: Buffer | undefined,
): Promise<void> {
  if (payload === undefined) return;
  const target = join(candidateDir, side, relPath);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await atomicWrite(target, payload);
}

async function readCandidatePayload(
  candidateDir: string,
  side: 'baseline' | 'worker-final',
  relPath: string,
): Promise<Buffer> {
  try {
    return await readFile(join(candidateDir, side, relPath));
  } catch {
    throw new Error(`candidate_corrupt: missing ${side} payload for ${relPath}`);
  }
}

async function verifyCandidatePayloads(
  candidateDir: string,
  manifest: EditingCandidateManifestV1,
): Promise<void> {
  for (const path of manifest.paths) {
    for (const [side, state, present] of [
      ['baseline', path.before, path.beforePayload],
      ['worker-final', path.after, path.afterPayload],
    ] as const) {
      if (state.kind !== 'regular') {
        if (present) throw new Error(`candidate_corrupt: unexpected ${side} payload for ${path.relPath}`);
        continue;
      }
      if (!present) throw new Error(`candidate_corrupt: missing ${side} payload for ${path.relPath}`);
      const payload = await readCandidatePayload(candidateDir, side, path.relPath);
      if (createHash('sha256').update(payload).digest('hex') !== state.sha256) {
        throw new Error(`candidate_corrupt: ${side} payload hash mismatch for ${path.relPath}`);
      }
    }
  }
}

function assertCandidateRelativePath(relPath: string): void {
  const canonical = normalize(relPath).replace(/^\.\//, '');
  if (
    relPath.length === 0 ||
    relPath.startsWith('/') ||
    relPath.includes('\\') ||
    canonical !== relPath ||
    relPath === '..' ||
    relPath.startsWith('../')
  ) {
    throw new Error(`candidate_corrupt: invalid path ${relPath}`);
  }
}

function isEditingCandidateManifest(value: unknown): value is EditingCandidateManifestV1 {
  if (!isRecord(value)) return false;
  const paths = value['paths'];
  const resolution = value['resolution'];
  return (
    value['version'] === 1 &&
    typeof value['taskId'] === 'string' &&
    typeof value['agentId'] === 'string' &&
    typeof value['logicalRunId'] === 'string' &&
    (value['externalSessionId'] === undefined || typeof value['externalSessionId'] === 'string') &&
    typeof value['repoRoot'] === 'string' &&
    typeof value['commonDir'] === 'string' &&
    typeof value['headCommit'] === 'string' &&
    isStringArray(value['originalScope']) &&
    isStringArray(value['requestedScope']) &&
    typeof value['candidateHash'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['handoff'] === 'string' &&
    isStringArray(value['validationEvidence']) &&
    value['complete'] === true &&
    isStringArray(value['errors']) &&
    Array.isArray(paths) &&
    paths.every(isEditingCandidateManifestPath) &&
    (resolution === undefined || isEditingCandidateResolution(resolution))
  );
}

function isEditingCandidateManifestPath(value: unknown): value is EditingCandidateManifestPath {
  return (
    isRecord(value) &&
    typeof value['relPath'] === 'string' &&
    (value['classification'] === 'in_scope' || value['classification'] === 'scope_expansion_requested') &&
    isEditingCandidatePathState(value['before']) &&
    isEditingCandidatePathState(value['after']) &&
    typeof value['beforePayload'] === 'boolean' &&
    typeof value['afterPayload'] === 'boolean'
  );
}

function isEditingCandidatePathState(value: unknown): value is EditingCandidatePathState {
  if (!isRecord(value) || typeof value['kind'] !== 'string') return false;
  switch (value['kind']) {
    case 'absent':
      return true;
    case 'regular':
      return typeof value['mode'] === 'number' && typeof value['sha256'] === 'string';
    case 'directory':
    case 'special':
      return typeof value['mode'] === 'number';
    case 'symlink':
      return typeof value['mode'] === 'number' && typeof value['target'] === 'string';
    case 'unreadable':
      return typeof value['error'] === 'string';
    default:
      return false;
  }
}

function isEditingCandidateResolution(value: unknown): value is EditingCandidateResolution {
  return (
    isRecord(value) &&
    (value['kind'] === 'approved_applied' || value['kind'] === 'denied') &&
    typeof value['resolvedAt'] === 'string'
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function normalizePersistedTask(task: DiskPersistedTask): PersistedTask {
  if (isLegacyPersistedTask(task)) return legacyPersistedTaskToInfo(task);
  return {
    ...task,
    detached: task.detached ?? true,
  };
}

type LegacyBackgroundTaskStatus =
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
  readonly status: LegacyBackgroundTaskStatus;
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

function legacyStatusToCurrent(task: LegacyPersistedTask): BackgroundTaskStatus {
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
