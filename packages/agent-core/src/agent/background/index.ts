/**
 * BackgroundManager — manages background tasks for an agent.
 *
 * Tracks background bash tasks and background subagent tasks.
 *
 * Each task gets a unique ID, captures stdout+stderr to a ring buffer,
 * and supports status query / output retrieval / stop operations.
 *
 * Concrete task classes own execution details; the manager owns task
 * registration, lifecycle state, persistence, output, and notifications.
 */

import { randomBytes } from 'node:crypto';

import { createControlledPromise, type ControlledPromise } from '@antfu/utils';
import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '../..';
import { errorMessage } from '../../loop/errors';
import { resettableTimeoutOutcome, timeoutOutcome, type ResettableTimeoutPromise } from '../../utils/promise';
import { escapeXml, escapeXmlAttr } from '../../utils/xml-escape';
import { isExternalSubagentId } from '../../session/subagent-routing';
import { applySubagentWorktreeCandidate } from '../../session/subagent-worktree';
import type { BackgroundTaskOrigin } from '../context';
import { renderNotificationXml } from '../context/notification-xml';
import {
  type BackgroundTaskPersistence,
  type EditingCandidateManifestV1,
} from './persist';
import {
  TERMINAL_STATUSES,
  type BackgroundTask,
  type BackgroundTaskInfo,
  type BackgroundTaskInfoBase,
  type BackgroundTaskSettlement,
  type BackgroundTaskStatus,
} from './task';

// ── Types ────────────────────────────────────────────────────────────

/**
 * `'lost'` is a reconcile-only terminal state. Tasks loaded from disk
 * that were marked `running` at startup but have no live KaosProcess
 * (the previous CLI process died) are reclassified as lost.
 */
export function isBackgroundTaskTerminal(status: BackgroundTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isBackgroundTaskExecuting(status: BackgroundTaskStatus): boolean {
  return status === 'running';
}

export function isBackgroundTaskAwaitingInput(status: BackgroundTaskStatus): boolean {
  return status === 'input_required';
}

const MAX_RUNNING_TASKS_ENV = 'KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS';

/**
 * Resolve the effective background-task concurrency cap. Precedence:
 * `KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS` (positive integer) → config
 * (`background.max_running_tasks`) → `undefined` (no cap). An invalid env
 * value is ignored.
 */
export function resolveMaxRunningTasks(configValue?: number): number | undefined {
  const raw = process.env[MAX_RUNNING_TASKS_ENV]?.trim();
  if (raw !== undefined && raw.length > 0 && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return configValue;
}

export { AgentBackgroundTask } from './agent-task';
export type { AgentBackgroundTaskInfo } from './agent-task';
export { ProcessBackgroundTask } from './process-task';
export type { ProcessBackgroundTaskInfo } from './process-task';
export { QuestionBackgroundTask } from './question-task';
export type { QuestionBackgroundTaskInfo } from './question-task';
export { BackgroundTaskPersistence } from './persist';
export type {
  BackgroundTaskInfo,
  BackgroundTaskStatus,
} from './task';

interface ManagedTask {
  readonly taskId: string;
  readonly task: BackgroundTask;
  readonly outputChunks: string[];
  /**
   * Running total of characters currently held in `outputChunks`, maintained
   * incrementally so the ring-buffer cap stays O(1) per chunk instead of
   * re-summing every chunk (which was O(n²) over a command's lifetime).
   */
  outputRingChars: number;
  /** Total UTF-8 bytes observed, including chunks dropped from the live ring buffer. */
  outputSizeBytes: number;
  /**
   * True once a command has crossed `MAX_TASK_OUTPUT_BYTES` and termination has
   * been requested. One-shot guard so the ceiling fires exactly once.
   */
  outputLimitTripped: boolean;
  status: BackgroundTaskStatus;
  candidate?: Extract<BackgroundTaskInfo, { kind: 'agent' }>['candidate'];
  /** Normalized registration options. Current mutable state stays on ManagedTask. */
  readonly options: RegisterBackgroundTaskOptions;
  readonly startedAt: number;
  endedAt: number | null;
  /** Foreground tool call release signal, present only for non-detached starts. */
  foregroundRelease?: ControlledPromise<ForegroundTaskReleaseReason>;
  /** Resettable deadline timer; reset on detach to apply `detachTimeoutMs`. */
  timeoutHandle?: ResettableTimeoutPromise<TerminalOutcome>;
  /** User/tool stop request. */
  readonly stop: ControlledPromise<StopRequest>;
  /** Resolved once manager has finalized the task. */
  readonly terminal: ControlledPromise<void>;
  /** Human-readable reason for the terminal status, when available. */
  stopReason?: string | undefined;
  /** Suppress automatic terminal notifications/reminders for this task. */
  terminalNotificationSuppressed?: boolean | undefined;
  /** Cancellation signal owned by the manager and observed by the concrete task. */
  readonly abortController: AbortController;
  persistWriteQueue: Promise<void>;
  outputWriteQueue: Promise<void>;
  /**
   * Full output buffered in memory while a foreground task has not yet
   * persisted to disk. Flushed to `output.log` (in order, ahead of the live
   * stream) when the task detaches or spills, then released.
   */
  pendingOutput: string[];
  pendingOutputBytes: number;
  /**
   * Whether `output.log` writes have begun. True from the start for tasks
   * registered already-detached; flipped on detach or memory-bound spill for
   * foreground tasks. Until then output stays in `pendingOutput`.
   */
  outputPersistStarted: boolean;
}

/**
 * Maximum bytes of combined output kept in the in-memory ring buffer per
 * task. When exceeded, the oldest chunks are dropped.
 *
 * The ring buffer is a lightweight tail intended for the `/tasks` UI and
 * terminal notifications only — it deliberately discards old output to
 * cap memory. It is NOT the authoritative full output: the complete,
 * never-truncated log lives on disk at `<sessionDir>/tasks/<id>/output.log`.
 * Callers that need task output should use `getOutputSnapshot()`, which
 * reads the persisted log when available.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB
const NOTIFICATION_FALLBACK_PREVIEW_BYTES = 3_000;

/**
 * Hard ceiling on the combined output a single shell command may stream before
 * it is force-terminated (SIGTERM → grace → SIGKILL). It guards both the
 * live-forward path and the on-disk `output.log` write chain from a runaway
 * command (e.g. `b3sum --length <huge>`) whose output would otherwise grow
 * without bound — filling the disk, or retaining each pending-write chunk until
 * Node aborts with an out-of-memory crash. Scoped to process tasks (foreground
 * and background); subagent and user-question results are appended once and must
 * always be persisted, so they are intentionally not capped here.
 */
const MAX_TASK_OUTPUT_BYTES = 16 * 1024 * 1024; // 16 MiB

/** Terminal `stopReason` recorded when a command trips the output ceiling. */
function outputLimitReason(): string {
  const mib = Math.floor(MAX_TASK_OUTPUT_BYTES / (1024 * 1024));
  return (
    `Output limit exceeded: the command produced more than ${mib} MiB and was ` +
    'terminated. Redirect large output to a file (e.g. `command > out.txt`) and ' +
    'inspect it in slices instead.'
  );
}

const SIGTERM_GRACE_MS = 5_000;
const USER_INTERRUPT_REASON = 'Interrupted by user';

const _ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Generate `{prefix}-{8 base36 chars}`.
 *
 * `randomBytes(8) % 36` has a modest modulo bias (256 % 36 = 4) but
 * over an 8-char suffix yields ~36^8 ≈ 2.8e12 distinct ids which is
 * more than enough uniqueness for per-session task ids.
 */
function generateTaskId(kind: string): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += _ALPHABET[bytes[i]! % 36];
  }
  return `${kind}-${suffix}`;
}

export interface BackgroundTaskOutputSnapshot {
  readonly outputPath?: string;
  readonly outputSizeBytes: number;
  readonly previewBytes: number;
  readonly truncated: boolean;
  readonly fullOutputAvailable: boolean;
  readonly preview: string;
}

function emptyOutputSnapshot(): BackgroundTaskOutputSnapshot {
  return {
    outputSizeBytes: 0,
    previewBytes: 0,
    truncated: false,
    fullOutputAvailable: false,
    preview: '',
  };
}

type BackgroundTaskNotification = Record<string, unknown> & {
  readonly id: string;
  readonly category: 'task';
  readonly type: string;
  readonly source_kind: 'background_task';
  readonly source_id: string;
  /** Subagent id accepted by Agent(resume=...). Omitted for process tasks. */
  readonly agent_id?: string | undefined;
  readonly title: string;
  readonly severity: 'info' | 'warning';
  readonly body: string;
  readonly children?: readonly string[] | undefined;
};

interface BackgroundTaskNotificationContext {
  readonly content: readonly ContentPart[];
  readonly origin: BackgroundTaskOrigin;
  readonly notification: BackgroundTaskNotification;
}

export interface RegisterBackgroundTaskOptions {
  /**
   * When false, the task is tracked by the manager but a foreground tool call
   * is still waiting for it. It can later be detached through RPC.
   */
  readonly detached?: boolean;
  /** Deadline owned by BackgroundManager. `0` and `undefined` do not arm a timer. */
  readonly timeoutMs?: number;
  /**
   * When set, detaching a foreground task resets its deadline to this value
   * (counted from the detach moment). Lets a command started with a short
   * foreground timeout run longer once it is moved to the background.
   */
  readonly detachTimeoutMs?: number;
  /**
   * When true, a foreground task whose deadline fires is detached to the
   * background (re-armed to `detachTimeoutMs`) instead of being killed.
   * Only meaningful for non-detached registrations.
   */
  readonly autoBackgroundOnTimeout?: boolean;
  /** Foreground caller signal. Ignored for tasks created already detached. */
  readonly signal?: AbortSignal;
}

export type ForegroundTaskReleaseReason = 'detached' | 'timeout_detached' | 'terminal';

interface StopRequest {
  readonly reason?: string;
  readonly abortReason?: unknown;
}

type TerminalOutcome =
  | { readonly kind: 'worker'; readonly settlement: BackgroundTaskSettlement }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'stop'; readonly request: StopRequest };

export type ScopeExpansionResolutionAction = 'approve' | 'deny';

export interface ScopeExpansionResolutionRequest {
  readonly taskId: string;
  readonly action: ScopeExpansionResolutionAction;
  readonly candidateHash: string;
  readonly requestedScope: readonly string[];
}

export interface ScopeExpansionResolutionResult {
  readonly task: BackgroundTaskInfo;
  readonly candidateHash: string;
  readonly requestedScope: readonly string[];
  readonly resolution: 'approved_applied' | 'denied';
  readonly idempotent: boolean;
}

type CandidateReplay = typeof applySubagentWorktreeCandidate;

// ── Manager ──────────────────────────────────────────────────────────

export class BackgroundManager {
  private readonly tasks = new Map<string, ManagedTask>();
  /**
   * Ghosts: tasks loaded from disk during reconcile that have no live
   * KaosProcess. They appear in `list()` / `getTask()` with status
   * `lost` so users see what was running before the crash/restart.
   */
  private readonly ghosts = new Map<string, BackgroundTaskInfo>();

  private readonly scheduledNotificationKeys = new Set<string>();
  private readonly deliveredNotificationKeys = new Set<string>();
  private readonly resolutionQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly agent: Agent,
    private readonly persistence?: BackgroundTaskPersistence,
    private readonly replayCandidate: CandidateReplay = applySubagentWorktreeCandidate,
  ) { }

  private fireCompletionEffects(entry: ManagedTask): void {
    if (!this.isDetached(entry)) return;
    const info = this.toInfo(entry);
    void this.notifyBackgroundTask(info).catch(() => { });
    // input_required is not terminal, but the background execution has ended
    // and consumers (badge, task map) must stop counting it as running.
    if (isBackgroundTaskTerminal(info.status) || isBackgroundTaskAwaitingInput(info.status)) {
      this.emitTaskTerminated(info);
    }
  }

  private emitTaskStarted(info: BackgroundTaskInfo): void {
    this.agent.emitEvent({ type: 'background.task.started', info });
    this.agent.telemetry.track('background_task_created', {
      kind: info.kind === 'process' ? 'bash' : info.kind,
    });
  }

  private emitTaskTerminated(info: BackgroundTaskInfo): void {
    this.agent.emitEvent({ type: 'background.task.terminated', info });
    this.agent.telemetry.track('background_task_completed', {
      kind: info.kind,
      duration_ms: info.endedAt !== null ? info.endedAt - info.startedAt : null,
      status: info.status,
    });
  }

  private assertCanRegister(startedInBackground: boolean): void {
    const maxRunningTasks = resolveMaxRunningTasks(
      this.agent.kimiConfig?.background?.maxRunningTasks,
    );
    if (maxRunningTasks === undefined) return;
    if (!startedInBackground) return;
    if (this.activeBackgroundAdmissionCount() < maxRunningTasks) return;
    throw new Error('Too many background tasks are already running.');
  }

  private activeBackgroundAdmissionCount(): number {
    let count = 0;
    for (const entry of this.tasks.values()) {
      if (isBackgroundTaskExecuting(entry.status) && this.startedInBackground(entry)) count++;
    }
    return count;
  }

  private startedInBackground(entry: ManagedTask): boolean {
    return entry.options.detached !== false;
  }

  private isDetached(entry: ManagedTask): boolean {
    return entry.foregroundRelease === undefined;
  }

  /**
   * Foreground tasks opted into auto-background survive their first deadline
   * by detaching to the background instead of being killed.
   */
  private canAutoBackgroundOnTimeout(entry: ManagedTask): boolean {
    return entry.options.autoBackgroundOnTimeout === true && !this.isDetached(entry);
  }

  registerTask(task: BackgroundTask, options: RegisterBackgroundTaskOptions = {}): string {
    const detached = options.detached ?? true;
    const timeoutMs = options.timeoutMs ?? task.timeoutMs;
    const entryOptions: RegisterBackgroundTaskOptions = {
      detached,
      timeoutMs,
      detachTimeoutMs: options.detachTimeoutMs,
      autoBackgroundOnTimeout: options.autoBackgroundOnTimeout,
      signal: detached ? undefined : options.signal,
    };
    this.assertCanRegister(detached);
    const taskId = generateTaskId(task.idPrefix);
    const entry: ManagedTask = {
      taskId,
      task,
      outputChunks: [],
      outputRingChars: 0,
      outputSizeBytes: 0,
      outputLimitTripped: false,
      status: 'running',
      options: entryOptions,
      startedAt: Date.now(),
      endedAt: null,
      foregroundRelease: detached ? undefined : createControlledPromise(),
      stop: createControlledPromise(),
      terminal: createControlledPromise(),
      abortController: new AbortController(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
      pendingOutput: [],
      pendingOutputBytes: 0,
      outputPersistStarted: detached,
    };
    this.tasks.set(taskId, entry);
    void this.runTaskLifecycle(entry);

    // Initial persistence (snapshot at start). Foreground tasks defer all
    // persistence until they detach (or spill) — see appendOutput / detach /
    // finalizeTask — so ordinary commands leave nothing undiscoverable on disk.
    if (this.isDetached(entry)) {
      void this.persistLive(entry);
      this.emitTaskStarted(this.toInfo(entry));
    }

    return taskId;
  }

  /** Get info about a specific task. Falls back to reconcile ghosts. */
  getTask(taskId: string): BackgroundTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    if (entry !== undefined) {
      return this.toInfo(entry);
    }
    return this.ghosts.get(taskId);
  }

  async inspectCandidate(taskId: string): Promise<EditingCandidateManifestV1 | undefined> {
    if (!this.agent.experimentalFlags.enabled('subagent-worktree-isolation')) return undefined;
    if (this.getTask(taskId)?.kind !== 'agent') return undefined;
    return this.persistence?.readEditingCandidate(taskId);
  }

  async resolveScopeExpansion(
    request: ScopeExpansionResolutionRequest,
  ): Promise<ScopeExpansionResolutionResult> {
    const previous = this.resolutionQueues.get(request.taskId) ?? Promise.resolve();
    const resolution = previous
      .catch(() => {})
      .then(() => this.resolveScopeExpansionSerialized(request));
    const tracked = resolution.then(() => {}, () => {});
    this.resolutionQueues.set(request.taskId, tracked);
    try {
      return await resolution;
    } finally {
      if (this.resolutionQueues.get(request.taskId) === tracked) {
        this.resolutionQueues.delete(request.taskId);
      }
    }
  }

  private async resolveScopeExpansionSerialized(
    request: ScopeExpansionResolutionRequest,
  ): Promise<ScopeExpansionResolutionResult> {
    if (!this.agent.experimentalFlags.enabled('subagent-worktree-isolation')) {
      throw new Error('candidate_resolution_disabled: subagent worktree isolation is disabled');
    }
    const persistence = this.persistence;
    if (persistence === undefined) {
      throw new Error('candidate_corrupt: candidate persistence is unavailable');
    }
    const info = this.getTask(request.taskId);
    if (info === undefined) throw new Error(`Task not found: ${request.taskId}`);
    if (info.kind !== 'agent') {
      throw new Error('candidate_identity_mismatch: task is not an agent task');
    }

    const { manifest, draft } = await persistence.loadEditingCandidate(request.taskId);
    this.assertScopeExpansionIdentity(info, manifest, request);
    const resolutionKind = request.action === 'approve' ? 'approved_applied' : 'denied';
    if (manifest.resolution !== undefined && manifest.resolution.kind !== resolutionKind) {
      throw new Error('candidate_already_resolved: candidate has an incompatible resolution');
    }
    if (manifest.resolution === undefined && info.status !== 'input_required') {
      throw new Error(`candidate_already_resolved: task status is ${info.status}`);
    }

    let idempotent = manifest.resolution !== undefined;
    if (!idempotent) {
      if (request.action === 'approve') {
        try {
          await this.replayCandidate(this.agent.kaos, draft, request.requestedScope);
        } catch (error) {
          const message = errorMessage(error);
          if (message.startsWith('candidate_') || message.startsWith('apply_failed_')) throw error;
          throw new Error(
            message.includes('guarded rollback incomplete')
              ? `apply_failed_recovery_required: ${message}`
              : `apply_failed_rolled_back: ${message}`,
          );
        }
      }
      const write = await persistence.writeEditingCandidateResolution(
        request.taskId,
        request.candidateHash,
        { kind: resolutionKind, resolvedAt: new Date().toISOString() },
      );
      idempotent = write.idempotent;
    }

    const status: BackgroundTaskStatus = request.action === 'approve' ? 'completed' : 'expansion_denied';
    const task = await this.setResolvedTaskStatus(request.taskId, status);
    return {
      task,
      candidateHash: manifest.candidateHash,
      requestedScope: manifest.requestedScope,
      resolution: resolutionKind,
      idempotent,
    };
  }

  private assertScopeExpansionIdentity(
    info: Extract<BackgroundTaskInfo, { kind: 'agent' }>,
    manifest: EditingCandidateManifestV1,
    request: ScopeExpansionResolutionRequest,
  ): void {
    if (
      manifest.candidateHash !== request.candidateHash ||
      JSON.stringify(manifest.requestedScope) !== JSON.stringify(request.requestedScope) ||
      info.candidate?.hash !== manifest.candidateHash ||
      JSON.stringify(info.candidate.requestedScope) !== JSON.stringify(manifest.requestedScope) ||
      (info.agentId !== undefined && info.agentId !== manifest.agentId)
    ) {
      throw new Error('candidate_identity_mismatch: candidate hash or requested scope does not match');
    }
  }

  private async setResolvedTaskStatus(
    taskId: string,
    status: 'completed' | 'expansion_denied',
  ): Promise<BackgroundTaskInfo> {
    const live = this.tasks.get(taskId);
    if (live !== undefined) {
      const previous = {
        status: live.status,
        stopReason: live.stopReason,
        endedAt: live.endedAt,
      };
      const changed = live.status !== status;
      live.status = status;
      live.stopReason = undefined;
      live.endedAt ??= Date.now();
      try {
        await this.persistLive(live, true);
      } catch (error) {
        live.status = previous.status;
        live.stopReason = previous.stopReason;
        live.endedAt = previous.endedAt;
        throw error;
      }
      if (changed) this.fireCompletionEffects(live);
      return this.toInfo(live);
    }

    const ghost = this.ghosts.get(taskId);
    if (ghost === undefined) throw new Error(`Task not found: ${taskId}`);
    const changed = ghost.status !== status;
    const updated: BackgroundTaskInfo = {
      ...ghost,
      status,
      stopReason: undefined,
      endedAt: ghost.endedAt ?? Date.now(),
    };
    await this.persistence!.writeTask(updated);
    this.ghosts.set(taskId, updated);
    if (changed) {
      void this.notifyBackgroundTask(updated).catch(() => {});
      this.emitTaskTerminated(updated);
    }
    return updated;
  }

  /**
   * List tasks, optionally filtering to active-only.
   *
   * When `activeOnly=false`, includes reconcile ghosts (lost tasks
   * from a prior CLI process) so the user sees what survived the
   * restart. Active-only mode never shows ghosts (they're terminal).
   */
  list(activeOnly = true, limit?: number): BackgroundTaskInfo[] {
    const result: BackgroundTaskInfo[] = [];
    for (const entry of this.tasks.values()) {
      const info = this.toInfo(entry);
      if (!this.shouldListTask(info, activeOnly)) continue;
      result.push(info);
      if (limit !== undefined && result.length >= limit) return result;
    }
    for (const ghost of this.ghosts.values()) {
      if (!this.shouldListTask(ghost, activeOnly)) continue;
      result.push(ghost);
      if (limit !== undefined && result.length >= limit) return result;
    }
    return result;
  }

  private shouldListTask(info: BackgroundTaskInfo, activeOnly: boolean): boolean {
    if (!TERMINAL_STATUSES.has(info.status)) return true;
    if (activeOnly) return false;
    return info.detached !== false;
  }

  /**
   * Return the output snapshot used by TaskOutput.
   *
   * Persisted logs are preferred when the task was registered with an
   * output session directory and `output.log` has actually been created,
   * because they are the complete, never-truncated source. Detached managers,
   * tasks registered before a session dir was attached, and silent tasks with
   * no persisted log fall back to the live ring buffer.
   */
  async getOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<BackgroundTaskOutputSnapshot> {
    if (this.getTask(taskId) === undefined) return emptyOutputSnapshot();

    await this.tasks.get(taskId)?.outputWriteQueue;

    const previewLimit = Math.max(0, Math.trunc(maxPreviewBytes));
    const persistence = this.persistence;
    if (persistence !== undefined && (await persistence.taskOutputExists(taskId))) {
      const outputSizeBytes = await persistence.taskOutputSizeBytes(taskId);
      const previewOffset = Math.max(0, outputSizeBytes - previewLimit);
      const previewBytes = outputSizeBytes - previewOffset;
      const preview = await persistence.readTaskOutputBytes(taskId, previewOffset, previewBytes);
      return {
        outputPath: persistence.taskOutputFile(taskId),
        outputSizeBytes,
        previewBytes,
        truncated: previewOffset > 0,
        fullOutputAvailable: true,
        preview,
      };
    }

    const entry = this.tasks.get(taskId);
    if (entry === undefined) return emptyOutputSnapshot();

    const available = Buffer.from(entry.outputChunks.join(''), 'utf-8');
    const previewBytes = Math.min(previewLimit, available.byteLength, entry.outputSizeBytes);
    const previewOffset = available.byteLength - previewBytes;
    return {
      outputSizeBytes: entry.outputSizeBytes,
      previewBytes,
      truncated: entry.outputSizeBytes > previewBytes,
      fullOutputAvailable: false,
      preview: available.subarray(previewOffset).toString('utf-8'),
    };
  }

  async readOutput(taskId: string, tail?: number): Promise<string> {
    const output = (await this.getOutputSnapshot(taskId, Number.MAX_SAFE_INTEGER)).preview;
    if (tail !== undefined && tail < output.length) {
      return output.slice(-tail);
    }
    return output;
  }

  async suppressTerminalNotification(taskId: string): Promise<void> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined || entry.terminalNotificationSuppressed === true) return;
    entry.terminalNotificationSuppressed = true;
    await this.persistLive(entry);
  }

  /**
   * Move a foreground task to the background, releasing its tool-call waiter.
   * `viaTimeout` marks an automatic detach triggered by the task deadline (vs.
   * an explicit user/RPC detach) so the waiter can word its result.
   */
  detach(taskId: string, viaTimeout = false): BackgroundTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return this.ghosts.get(taskId);
    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);
    const foregroundRelease = entry.foregroundRelease;
    if (foregroundRelease === undefined) return this.toInfo(entry);

    entry.foregroundRelease = undefined;
    if (entry.options.detachTimeoutMs !== undefined) {
      entry.timeoutHandle?.reset(entry.options.detachTimeoutMs);
    }
    try {
      entry.task.onDetach?.();
    } catch {
      /* detach has already succeeded; hooks must not make RPC fail */
    }
    // Flush buffered pre-detach output to disk before the live stream resumes,
    // so output.log stays the complete, in-order record.
    this.startOutputPersist(entry);
    void this.persistLive(entry);
    this.emitTaskStarted(this.toInfo(entry));
    foregroundRelease.resolve(viaTimeout ? 'timeout_detached' : 'detached');
    return this.toInfo(entry);
  }

  persistOutput(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return;
    this.startOutputPersist(entry);
  }

  /** Stop a running or awaiting-input task. SIGTERM → 5s grace → SIGKILL for live workers. */
  async stop(taskId: string, reason?: string): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      const ghost = this.ghosts.get(taskId);
      if (ghost === undefined || !isBackgroundTaskAwaitingInput(ghost.status)) return undefined;
      const trimmedReason = reason?.trim();
      const updated: BackgroundTaskInfo = {
        ...ghost,
        status: 'killed',
        stopReason:
          trimmedReason === undefined || trimmedReason.length === 0 ? undefined : trimmedReason,
      };
      this.ghosts.set(taskId, updated);
      await this.persistence?.writeTask(updated);
      this.emitTaskTerminated(updated);
      return updated;
    }
    // Normalize at this shared boundary: every public stop path (the TaskStop
    // tool, SDK/RPC) funnels through here, so a blank or whitespace-only
    // reason must never be recorded as an empty stopReason.
    const trimmedReason = reason?.trim();
    const stopReason =
      trimmedReason === undefined || trimmedReason.length === 0 ? undefined : trimmedReason;
    // Terminal tasks short-circuit.
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }
    if (isBackgroundTaskAwaitingInput(entry.status)) {
      entry.status = 'killed';
      entry.stopReason = stopReason;
      await this.persistLive(entry);
      this.fireCompletionEffects(entry);
      return this.toInfo(entry);
    }

    entry.stopReason = stopReason;
    entry.abortController.abort(stopReason);
    entry.stop.resolve({ reason: stopReason });
    await entry.terminal;
    return this.toInfo(entry);
  }

  async stopAll(reason?: string): Promise<readonly BackgroundTaskInfo[]> {
    const taskIds = Array.from(this.tasks.keys());
    const results = await Promise.all(taskIds.map((taskId) => this.stop(taskId, reason)));
    return results.filter((info): info is BackgroundTaskInfo => info !== undefined);
  }

  /**
   * Wait for a task to stop executing.
   * Returns immediately if terminal or awaiting input. Times out after `timeoutMs`.
   */
  async wait(taskId: string, timeoutMs = 30_000): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (!entry) return this.ghosts.get(taskId);
    if (TERMINAL_STATUSES.has(entry.status) || isBackgroundTaskAwaitingInput(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    if (timeoutMs <= 0) {
      return this.toInfo(entry);
    }
    const timeout = timeoutOutcome(timeoutMs, undefined);
    await Promise.race([entry.terminal, timeout]).finally(() => timeout.clear());

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
    }
    return this.toInfo(entry);
  }

  /**
   * Wait until no executing task matching `predicate` remains.
   * Awaiting-input tasks are actionable but do not hold the drain open.
   *
   * Used by print-mode (`kimi -p`) turn draining to hold a turn open while
   * background subagents are still running. Re-enumerates after each batch
   * settles so tasks registered during the wait (fan-out) are picked up.
   * Resolves immediately when nothing matches. Bounded by `timeoutMs`; once
   * the deadline passes the method returns without waiting for stragglers.
   * Rejects with the abort reason when `signal` is aborted.
   */
  async waitForActiveTasks(
    predicate: (info: BackgroundTaskInfo) => boolean,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    const deadline =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? Date.now() + options.timeoutMs
        : undefined;
    const signal = options.signal;
    while (true) {
      signal?.throwIfAborted();
      const active = this.list(true).filter(
        (info) => isBackgroundTaskExecuting(info.status) && predicate(info),
      );
      if (active.length === 0) return;
      let perTaskTimeout: number | undefined;
      if (deadline !== undefined) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        perTaskTimeout = remaining;
      }
      const batch = Promise.all(active.map((t) => this.wait(t.taskId, perTaskTimeout)));
      if (signal === undefined) {
        await batch;
      } else {
        await Promise.race([batch, abortRejecter(signal)]);
      }
      // Re-enumerate: settled tasks (and any fan-out) show up in the next list().
    }
  }

  /**
   * Wait until a foreground task either detaches from the current tool call or
   * reaches a terminal state. Detached tasks return immediately.
   */
  async waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined> {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return 'terminal';
    }
    if (this.isDetached(entry)) return 'detached';

    const foregroundRelease = entry.foregroundRelease;
    const reason = await Promise.race([
      foregroundRelease,
      entry.terminal.then(() => 'terminal' as const),
    ]);
    if (reason === 'terminal') {
      await entry.persistWriteQueue;
    }
    return reason;
  }

  // ── persistence + reconcile ────────────────────────────────────────

  /**
   * Load persisted task records into the ghost map. Does NOT reconcile
   * (call `reconcile()` after `loadFromDisk()`). Idempotent; subsequent
   * calls overwrite the ghost map.
   */
  async loadFromDisk(): Promise<void> {
    const persistence = this.persistence;
    if (persistence === undefined) return;
    this.ghosts.clear();
    const persisted = await persistence.listTasks();
    for (const t of persisted) {
      // Skip ids that already exist as live processes — live wins.
      if (this.tasks.has(t.taskId)) continue;
      this.ghosts.set(t.taskId, t);
    }
  }

  /**
   * Reconcile loaded ghost tasks. Any ghost with status `running` is
   * reclassified as `lost` (its previous CLI process died without
   * writing a terminal state). Updates the on-disk record and returns
   * the lost task snapshots so the caller can emit user-facing notifications.
   */
  private async markLoadedTasksLost(): Promise<readonly BackgroundTaskInfo[]> {
    const lostInfo: BackgroundTaskInfo[] = [];
    const persistence = this.persistence;
    for (const [id, info] of this.ghosts) {
      // Only an executing process becomes lost; awaiting-input ghosts remain actionable.
      if (!isBackgroundTaskExecuting(info.status)) continue;
      const updated: BackgroundTaskInfo = {
        ...info,
        status: 'lost',
        endedAt: info.endedAt ?? Date.now(),
      };
      this.ghosts.set(id, updated);
      if (persistence !== undefined) {
        await persistence.writeTask(updated);
      }
      lostInfo.push(updated);
    }
    return lostInfo;
  }

  async reconcile(): Promise<void> {
    const lostInfo = await this.markLoadedTasksLost();
    for (const info of lostInfo) {
      this.emitTaskTerminated(info);
    }
    await this.restoreBackgroundTaskNotifications();
  }

  /**
   * Persist the current state of a live ManagedTask. Called from
   * `registerTask()` and the lifecycle finally block. No-op unless attached.
   */
  private persistLive(entry: ManagedTask, strict = false): Promise<void> {
    const persistence = this.persistence;
    if (persistence === undefined) return Promise.resolve();
    const info = this.toInfo(entry);
    const write = entry.persistWriteQueue.then(() => persistence.writeTask(info));
    entry.persistWriteQueue = write.catch(() => {});
    return strict ? write : entry.persistWriteQueue;
  }

  private appendOutput(entry: ManagedTask, chunk: string): void {
    entry.outputSizeBytes += Buffer.byteLength(chunk, 'utf-8');
    entry.outputChunks.push(chunk);
    entry.outputRingChars += chunk.length;
    // Enforce the ring-buffer cap: drop oldest chunks when over budget. The
    // running total keeps this O(1) amortized per chunk; re-summing the whole
    // buffer on every chunk was O(n²) over a command's lifetime and could
    // starve the event loop (and so the foreground timeout) under a high-rate
    // output stream.
    while (entry.outputRingChars > MAX_OUTPUT_BYTES && entry.outputChunks.length > 1) {
      const removed = entry.outputChunks.shift();
      if (removed === undefined) break;
      entry.outputRingChars -= removed.length;
    }

    // Output ceiling: a single shell command must not grow the (unbounded)
    // live-forward buffer or the on-disk write chain until the process runs out
    // of memory or fills the disk. Trip once, then request graceful termination
    // through the shared stop path (SIGTERM → grace → SIGKILL). Scoped to
    // process tasks (foreground and background): subagent and user-question tasks
    // append their bounded result in one shot and must always persist it, so they
    // are intentionally not capped here.
    if (
      !entry.outputLimitTripped &&
      entry.task.kind === 'process' &&
      entry.outputSizeBytes > MAX_TASK_OUTPUT_BYTES
    ) {
      entry.outputLimitTripped = true;
      void this.stop(entry.taskId, outputLimitReason());
    }

    // Once the cap has tripped the task is being terminated: keep only the
    // bounded in-memory ring buffer above and stop feeding the (unbounded) disk
    // write chain. A producer that ignores SIGTERM could otherwise keep the
    // chain — and the chunk strings each pending write retains — growing through
    // the grace window until SIGKILL, re-introducing the OOM this cap prevents.
    if (entry.outputLimitTripped) return;

    if (this.persistence === undefined) return;

    // Foreground tasks keep their full output in memory and only touch disk
    // once they detach. A memory-bound spill begins disk persistence early so
    // a never-detached command can't grow the buffer without limit.
    if (!entry.outputPersistStarted) {
      entry.pendingOutput.push(chunk);
      entry.pendingOutputBytes += Buffer.byteLength(chunk, 'utf-8');
      if (entry.pendingOutputBytes > MAX_OUTPUT_BYTES) this.startOutputPersist(entry);
      return;
    }

    this.appendTaskOutput(entry, chunk);
  }

  /** Enqueue an `output.log` append, serialized per task. No-op when detached managers omit persistence. */
  private appendTaskOutput(entry: ManagedTask, chunk: string): void {
    const persistence = this.persistence;
    if (persistence === undefined) return;
    entry.outputWriteQueue = entry.outputWriteQueue
      .then(() => persistence.appendTaskOutput(entry.taskId, chunk))
      .catch(() => { });
  }

  /**
   * Begin persisting `output.log` for a task that buffered while foreground.
   * Flushes the buffered pre-detach output first (in order, ahead of the live
   * stream) so the on-disk log stays complete, then releases the buffer.
   * Idempotent.
   */
  private startOutputPersist(entry: ManagedTask): void {
    if (entry.outputPersistStarted) return;
    entry.outputPersistStarted = true;
    if (entry.pendingOutput.length > 0) {
      this.appendTaskOutput(entry, entry.pendingOutput.join(''));
    }
    entry.pendingOutput = [];
    entry.pendingOutputBytes = 0;
  }

  private async restoreBackgroundTaskNotifications(): Promise<void> {
    for (const info of this.list(false)) {
      if (!isBackgroundTaskTerminal(info.status) && !isBackgroundTaskAwaitingInput(info.status)) continue;
      await this.restoreBackgroundTaskNotification(info);
    }
  }

  private async notifyBackgroundTask(info: BackgroundTaskInfo): Promise<void> {
    const context = await this.buildBackgroundTaskNotificationContext(info);
    if (context === undefined) return;
    this.agent.turn.steer(context.content, context.origin);
    this.fireNotificationHook(context.notification);
  }

  private async restoreBackgroundTaskNotification(info: BackgroundTaskInfo): Promise<void> {
    const context = await this.buildBackgroundTaskNotificationContext(info);
    if (context === undefined) return;
    this.agent.context.appendUserMessage(context.content, context.origin);
    this.fireNotificationHook(context.notification);
  }

  private async buildBackgroundTaskNotificationContext(
    info: BackgroundTaskInfo,
  ): Promise<BackgroundTaskNotificationContext | undefined> {
    if (info.detached === false) return undefined;
    if (this.isTerminalNotificationSuppressed(info.taskId)) return undefined;
    const origin: BackgroundTaskOrigin = {
      kind: 'background_task',
      taskId: info.taskId,
      status: info.status,
      notificationId: `task:${info.taskId}:${info.status}`,
    };
    const key = notificationKey(origin);
    if (this.scheduledNotificationKeys.has(key)) return;
    if (this.deliveredNotificationKeys.has(key)) return;

    this.scheduledNotificationKeys.add(key);
    let output = await this.getOutputSnapshot(info.taskId, 0);
    if (!output.fullOutputAvailable) {
      output = await this.getOutputSnapshot(info.taskId, NOTIFICATION_FALLBACK_PREVIEW_BYTES);
    }
    if (this.isTerminalNotificationSuppressed(info.taskId)) return undefined;
    const notification: BackgroundTaskNotification = {
      id: origin.notificationId,
      category: 'task',
      type: `task.${info.status}`,
      source_kind: 'background_task',
      source_id: info.taskId,
      agent_id: info.kind === 'agent' ? info.agentId : undefined,
      title: `Background ${info.kind} ${info.status}`,
      severity: info.status === 'completed' ? 'info' : 'warning',
      body: buildBackgroundTaskNotificationBody(info),
      children: backgroundTaskNotificationChildren(output),
    };
    const content = [
      {
        type: 'text',
        text: renderNotificationXml(notification),
      },
    ] as const;
    return { content, origin, notification };
  }

  private fireNotificationHook(notification: BackgroundTaskNotification): void {
    void this.agent.hooks?.fireAndForgetTrigger('Notification', {
      matcherValue: notification.type,
      inputData: {
        sink: 'context',
        notificationType: notification.type,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        sourceKind: notification.source_kind,
        sourceId: notification.source_id,
      },
    });
  }

  markDeliveredNotification(origin: BackgroundTaskOrigin): void {
    this.deliveredNotificationKeys.add(notificationKey(origin));
  }

  private isTerminalNotificationSuppressed(taskId: string): boolean {
    return (
      this.tasks.get(taskId)?.terminalNotificationSuppressed === true ||
      this.ghosts.get(taskId)?.terminalNotificationSuppressed === true
    );
  }

  private async runTaskLifecycle(entry: ManagedTask): Promise<void> {
    const worker = createControlledPromise<BackgroundTaskSettlement>();
    let workerSettled = false;
    const settleWorker = (settlement: BackgroundTaskSettlement): boolean => {
      if (workerSettled) return false;
      workerSettled = true;
      worker.resolve(settlement);
      return true;
    };

    void Promise.resolve()
      .then(() => entry.task.start({
        signal: entry.abortController.signal,
        appendOutput: (chunk) => {
          this.appendOutput(entry, chunk);
        },
        settle: async (settlement) => settleWorker(settlement),
      }))
      .catch((error: unknown) => {
        settleWorker({
          status: entry.abortController.signal.aborted ? 'killed' : 'failed',
          stopReason: entry.abortController.signal.aborted ? undefined : errorMessage(error),
        });
      });

    let timeout = resettableTimeoutOutcome(entry.options.timeoutMs, { kind: 'timeout' as const });
    entry.timeoutHandle = timeout;
    let outcome: TerminalOutcome;
    try {
      while (true) {
        outcome = await Promise.race([
          worker.then((settlement): TerminalOutcome => ({ kind: 'worker', settlement })),
          timeout,
          entry.stop.then((request): TerminalOutcome => ({ kind: 'stop', request })),
          this.signalOutcome(entry),
        ]);
        if (outcome.kind !== 'timeout' || !this.canAutoBackgroundOnTimeout(entry)) break;
        // Move the foreground task to the background instead of killing it:
        // detach() releases the tool-call waiter, then a fresh deadline is
        // armed (reset() is a no-op once the timeout promise has resolved).
        this.detach(entry.taskId, true);
        timeout.clear();
        timeout = resettableTimeoutOutcome(entry.options.detachTimeoutMs, { kind: 'timeout' as const });
        entry.timeoutHandle = timeout;
      }
    } finally {
      timeout.clear();
      entry.timeoutHandle = undefined;
    }
    const settlement = await this.settlementForOutcome(entry, outcome, worker);
    await this.finalizeTask(entry, settlement);
  }

  private signalOutcome(entry: ManagedTask): Promise<TerminalOutcome> {
    const signal = entry.options.signal;
    if (signal === undefined) return new Promise<never>(() => {});
    const outcome = (): TerminalOutcome => ({
      kind: 'stop',
      request: { reason: USER_INTERRUPT_REASON, abortReason: signal.reason },
    });
    if (signal.aborted) return Promise.resolve(outcome());
    return new Promise((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          if (!this.isDetached(entry)) resolve(outcome());
        },
        { once: true },
      );
    });
  }

  private async settlementForOutcome(
    entry: ManagedTask,
    outcome: TerminalOutcome,
    worker: Promise<BackgroundTaskSettlement>,
  ): Promise<BackgroundTaskSettlement> {
    if (outcome.kind === 'worker') return outcome.settlement;

    const timedOut = outcome.kind === 'timeout';
    const stopReason = outcome.kind === 'stop' ? outcome.request.reason : undefined;
    let abortReason: unknown;
    if (timedOut) {
      abortReason = 'Timed out';
    } else if (outcome.kind === 'stop') {
      abortReason = outcome.request.abortReason ?? stopReason;
    }
    entry.stopReason = stopReason;
    entry.abortController.abort(abortReason);

    const graceTimeout = timeoutOutcome(SIGTERM_GRACE_MS, undefined);
    const workerAfterAbort = await Promise.race([
      worker,
      graceTimeout,
    ]).finally(() => graceTimeout.clear());

    if (
      outcome.kind === 'stop' &&
      workerAfterAbort !== undefined &&
      workerAfterAbort.status !== 'killed' &&
      workerAfterAbort.status !== 'timed_out'
    ) {
      return workerAfterAbort;
    }

    if (workerAfterAbort === undefined) {
      try {
        await entry.task.forceStop?.();
      } catch {
        /* ignore */
      }
    }

    return {
      status: timedOut ? 'timed_out' : 'killed',
      stopReason,
    };
  }

  private async finalizeTask(
    entry: ManagedTask,
    settlement: BackgroundTaskSettlement,
  ): Promise<void> {
    let acknowledgePersisted: (() => Promise<void>) | undefined;
    if (settlement.status === 'input_required') {
      this.startOutputPersist(entry);
      await entry.outputWriteQueue;
      const persistence = this.persistence;
      if (persistence === undefined) {
        settlement = {
          status: 'failed',
          stopReason: 'Editing candidate persistence is unavailable; the isolated worktree was retained.',
        };
      } else {
        try {
          const manifest = await persistence.writeEditingCandidate(
            entry.taskId,
            settlement.candidate,
            settlement.handoff,
            settlement.usage,
          );
          entry.candidate = {
            hash: manifest.candidateHash,
            requestedScope: manifest.requestedScope,
            paths: manifest.paths.map((path) => path.relPath),
          };
          acknowledgePersisted = settlement.candidate.acknowledgePersisted;
          let replayApplied = false;
          try {
            await this.replayCandidate(
              this.agent.kaos,
              settlement.candidate.draft,
              manifest.requestedScope,
            );
            replayApplied = true;
          } catch {
            // A durable candidate is already available. Keep the exceptional
            // conflict path actionable without discarding the completed run or
            // spending another provider attempt.
          }
          if (replayApplied) {
            try {
              await persistence.writeEditingCandidateResolution(
                entry.taskId,
                manifest.candidateHash,
                { kind: 'approved_applied', resolvedAt: new Date().toISOString() },
              );
            } catch {
              // Replay already applied exactly once. Resolution metadata is
              // best-effort here; do not expose an applied candidate as an
              // actionable conflict that a later approval would replay again.
            }
            settlement = { status: 'completed' };
          }
        } catch (error) {
          settlement = {
            status: 'failed',
            stopReason: `Editing candidate persistence failed; the isolated worktree was retained: ${errorMessage(error)}`,
          };
        }
      }
    }
    entry.status = settlement.status;
    entry.endedAt = Date.now();
    entry.stopReason =
      'stopReason' in settlement
        ? settlement.stopReason ?? (settlement.status === 'killed' ? entry.stopReason : undefined)
        : undefined;
    // Persist the terminal record only when the task actually touched disk:
    // detached tasks, and foreground tasks that spilled past the in-memory
    // buffer. A foreground task whose output stayed in memory leaves nothing on
    // disk — release the buffer and skip persistence so it never accumulates as
    // an undiscoverable log.
    if (entry.outputPersistStarted) {
      try {
        await this.persistLive(entry, acknowledgePersisted !== undefined);
      } catch (error) {
        acknowledgePersisted = undefined;
        entry.status = 'failed';
        entry.stopReason =
          `Editing candidate task-state persistence failed; the isolated worktree was retained: ${errorMessage(error)}`;
        await this.persistLive(entry);
      }
    } else {
      entry.pendingOutput = [];
      entry.pendingOutputBytes = 0;
    }
    if (acknowledgePersisted !== undefined) {
      await acknowledgePersisted().catch(() => {});
    }
    this.fireCompletionEffects(entry);
    entry.foregroundRelease?.resolve('terminal');
    entry.terminal.resolve();
  }

  private toInfo(entry: ManagedTask): BackgroundTaskInfo {
    const base: BackgroundTaskInfoBase = {
      taskId: entry.taskId,
      description: entry.task.description,
      status: entry.status,
      detached: this.isDetached(entry),
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      stopReason: entry.stopReason,
      terminalNotificationSuppressed: entry.terminalNotificationSuppressed,
      timeoutMs: entry.options.timeoutMs,
    };
    const info = entry.task.toInfo(base);
    if (info.kind !== 'agent' || entry.candidate === undefined) return info;
    return { ...info, candidate: entry.candidate };
  }
}

function backgroundTaskNotificationChildren(
  output: BackgroundTaskOutputSnapshot,
): readonly string[] | undefined {
  if (output.fullOutputAvailable && output.outputPath !== undefined) {
    return [renderOutputFileBlock(output.outputPath, output.outputSizeBytes)];
  }
  if (output.preview.length === 0) return undefined;
  return [renderOutputPreviewBlock(output)];
}

function renderOutputFileBlock(outputPath: string, outputSizeBytes: number): string {
  return [
    `<output-file path="${escapeXmlAttr(outputPath)}" bytes="${String(outputSizeBytes)}">`,
    `Read the output file to retrieve the result: ${escapeXml(outputPath)}`,
    '</output-file>',
  ].join('\n');
}

function renderOutputPreviewBlock(output: BackgroundTaskOutputSnapshot): string {
  return [
    `<output-preview bytes="${String(output.previewBytes)}" total_bytes="${String(output.outputSizeBytes)}" truncated="${String(output.truncated)}">`,
    output.truncated
      ? `Showing the last ${String(output.previewBytes)} bytes. No persisted full output is available.`
      : 'No persisted full output is available; this preview is the currently buffered task output.',
    escapeXml(output.preview),
    '</output-preview>',
  ].join('\n');
}

function notificationKey(origin: BackgroundTaskOrigin): string {
  return `${origin.taskId}\0${origin.status}\0${origin.notificationId}`;
}

function buildBackgroundTaskNotificationBody(info: BackgroundTaskInfo): string {
  const baseLine =
    info.status === 'timed_out'
      ? `${info.description} timed out.`
      : info.stopReason
        ? `${info.description} ${info.status === 'killed' ? 'was killed' : info.status}: ${info.stopReason
        }.`
        : `${info.description} ${info.status}.`;

  if (info.kind !== 'agent') return baseLine;
  if (info.status === 'completed' || info.status === 'input_required') return baseLine;
  const agentId = info.agentId;
  if (agentId === undefined || agentId === info.taskId || isExternalSubagentId(agentId)) return baseLine;

  const recovery = [
    '',
    `To recover or continue this subagent, call Agent(resume="${agentId}", prompt="Pick up where you left off; redo the last tool call if its result was never observed.").`,
    `Use agent_id ("${agentId}"), NOT source_id / task_id ("${info.taskId}") — the two look alike but only agent_id is accepted by the resume parameter.`,
    'Add run_in_background=true to keep it backgrounded, or omit it to take the result inline in the current turn.',
    'If the subagent had already started, it retains its full prior context across the restart (any in-flight tool call lost its result and may need to be redone); if it failed before its first turn ran, re-spawn with the original prompt instead.',
  ].join('\n');

  return `${baseLine}${recovery}`;
}

function abortRejecter(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error('Aborted'));
  }
  return new Promise<never>((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(signal.reason ?? new Error('Aborted')),
      { once: true },
    );
  });
}
