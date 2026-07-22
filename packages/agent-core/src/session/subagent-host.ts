import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  APIProviderRateLimitError,
  isProviderRateLimitError,
  type TokenUsage,
} from '@moonshot-ai/kosong';

import type { Agent } from '../agent';
import type { PromptOrigin } from '../agent/context';
import { ErrorCodes, KimiError } from '../errors';
import { DenyAllPermissionPolicy } from '../agent/permission/policies/deny-all';
import { isEditingCapableProfile } from '../agent/dispatch/profile';
import type {
  DispatchEscalationKind,
  DispatchWaitOutcome,
  DispatchWorkCard,
} from '../agent/dispatch/controller';
import { InMemoryAgentRecordPersistence } from '../agent/records';
import { isAbortError } from '../loop/errors';
import { sleepForRetry } from '../loop/retry';
import { redactUntrustedRaw } from '../security/redaction';
import {
  DEFAULT_AGENT_PROFILES,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import {
  isUserCancellation,
  linkAbortSignal,
  userCancellationReason,
} from '../utils/abort';
import { collectGitContext } from './git-context';
import {
  acquireSubagentWorktree,
  type EditingCandidateDraft,
  type SubagentWorktreeFinishResult,
  type SubagentWorktreeHandle,
  type SubagentWorktreeOutcome,
} from './subagent-worktree';
import type { Session } from './index';
import {
  SubagentBatch,
  resolveSwarmMaxConcurrency,
  type SubagentResult,
  type SubagentSuspendedEvent,
  type QueuedSubagentTask,
} from './subagent-batch';
import type { SubagentLauncher, SubagentPoolRoute } from '../config/schema';
import {
  EXTERNAL_SUBAGENT_ID_PREFIX,
  isExternalSubagentId,
  materializeBackendArgs,
  resolveExternalSubagentLauncher,
  resolveRouteByNames,
  resolveSubagentRoute,
  parseExternalSubagentOutput,
  parseExternalSubagentStreamLine,
  SubagentRoutePool,
  wrapExternalSubagentPrompt,
  type ExternalSubagentUsage,
  type ResolvedSubagentRoute,
} from './subagent-routing';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md?raw';

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION = '2 hours';

const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';

/**
 * External subagents run as a detached child process with no provider-level
 * retry (unlike internal subagents, which go through `chatWithRetry`). A
 * transient non-zero exit (network blip, backend crash) previously killed
 * the subagent permanently. These bound a small local retry loop around
 * `runExternalSubagent` — any non-zero exit is retried (no stderr parsing/
 * classification), up to a small attempt cap.
 */
const EXTERNAL_SUBAGENT_MAX_ATTEMPTS = 4;
const EXTERNAL_RETRY_BASE_DELAY_MS = 500;
const EXTERNAL_RETRY_FACTOR = 2;
const EXTERNAL_RETRY_MAX_DELAY_MS = 8_000;

/**
 * Tags an error already reported via `emitSubagentFailed` inside
 * `withExternalRetry`, so `spawnExternal`'s catch-all does not emit a second
 * `subagent.failed` for the same failure (e.g. an abort landing during the
 * inter-attempt backoff delay).
 */
const EXTERNAL_RETRY_EMITTED = Symbol('externalRetryEmitted');

function markExternalRetryEmitted<T>(error: T): T {
  if (typeof error === 'object' && error !== null) {
    Object.defineProperty(error, EXTERNAL_RETRY_EMITTED, { value: true, enumerable: false });
  }
  return error;
}

function hasExternalRetryEmitted(error: unknown): boolean {
  return typeof error === 'object' && error !== null && EXTERNAL_RETRY_EMITTED in error;
}

/**
 * Resolve the effective subagent per-task timeout. Precedence:
 * `KIMI_SUBAGENT_TIMEOUT_MS` (integer ms) → `configMs` →
 * `DEFAULT_SUBAGENT_TIMEOUT_MS` (2 hours). `0` means no timeout: the value
 * feeds the background-task manager's per-task timeout (where `0` arms no
 * timer), so it governs foreground and background subagents (and AgentSwarm).
 */
export function resolveSubagentTimeoutMs(configMs?: number): number {
  const raw = process.env[SUBAGENT_TIMEOUT_ENV];
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  if (configMs !== undefined && Number.isInteger(configMs) && configMs >= 0) {
    return configMs;
  }
  return DEFAULT_SUBAGENT_TIMEOUT_MS;
}

/** Human-readable duration for the subagent timeout message. */
export function formatSubagentTimeoutDescription(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) {
    const h = ms / (60 * 60 * 1000);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  if (ms % (60 * 1000) === 0) {
    const m = ms / (60 * 1000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (ms % 1000 === 0) {
    const s = ms / 1000;
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}

export type {
  SubagentResult as QueuedSubagentRunResult,
  QueuedSubagentTask,
  ResumeQueuedSubagentTask,
  SpawnQueuedSubagentTask,
} from './subagent-batch';

/**
 * A subagent summary shorter than this many characters triggers one
 * follow-up turn that asks the subagent to expand it, so the parent
 * agent receives a technically complete handoff.
 */
const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
const HOOK_TEXT_PREVIEW_LENGTH = 500;
const SUBAGENT_MAX_TOKENS_ERROR =
  'Subagent turn failed before completing its final summary: reason=max_tokens';
const TOOL_CALL_DISABLED_MESSAGE =
  'Tool calls are disabled for side questions. Answer with text only.';
const SUBAGENT_PROMPT_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'subagent' };
const SIDE_QUESTION_SYSTEM_REMINDER = `
This is a side-channel conversation with the user. You should answer user questions directly based on what you already know.

IMPORTANT:
- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- Do not call any tools. All tool calls are disabled and will be rejected.
  Even though tool definitions are visible in this request, they exist only
  for technical reasons (prompt cache). You must not use them.
- Respond only with text based on what you already know from the conversation
  and this side-channel conversation.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.
`;

export interface RunSubagentOptions {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly runInBackground: boolean;
  readonly signal: AbortSignal;
  readonly onReady?: () => void;
  readonly suppressRateLimitFailureEvent?: boolean;
  readonly dispatch?: DispatchSpawnMetadata;
  readonly displayName?: string;
}

/** Optional dispatch metadata carried by a model-initiated Agent/AgentSwarm call (D5/D6/D7). */
export interface DispatchSpawnMetadata {
  readonly rationale?: string;
  readonly scope?: readonly string[];
  readonly qualityDeficiencies?: readonly string[];
  readonly reviewReason?: string;
  readonly workCard?: DispatchWorkCard;
  /** Runtime-enforced capability boundary for Agora read-only peers. */
  readonly readOnly?: boolean;
  /** Run in an isolated worktree and discard every resulting delta. */
  readonly discardChanges?: boolean;
  /** Force the in-process route even when the named profile has external routing. */
  readonly internalOnly?: boolean;
  /** Tool allowlist applied after profile resolution for a read-only in-process run. */
  readonly allowedTools?: readonly string[];
}

export interface SpawnSubagentOptions extends RunSubagentOptions {
  readonly profileName: string;
  readonly swarmItem?: string;
  readonly modelAlias?: string;
  readonly dispatch?: DispatchSpawnMetadata;
  /** Enforce proactive-dispatch invariants for a model-issued tool call. */
  readonly enforceDispatch?: boolean;
}

export interface SubagentEditingCandidate {
  readonly draft: EditingCandidateDraft;
  readonly agentId: string;
  readonly logicalRunId: string;
  readonly externalSessionId?: string;
  readonly originalScope: readonly string[];
  readonly requestedScope: readonly string[];
  readonly outsideScope: readonly string[];
  readonly acknowledgePersisted: () => Promise<void>;
}

export type SubagentCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
  readonly editingCandidate?: SubagentEditingCandidate;
};

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  readonly resumable?: boolean;
  readonly completion: Promise<SubagentCompletion>;
};

export class SessionSubagentHost {
  private readonly activeChildren = new Map<
    string,
    {
      readonly controller: AbortController;
      runInBackground: boolean;
    }
  >();

  /**
   * One weighted round-robin pool per pooled profile (currently only
   * `coder`), held for the life of this host so rotation state and
   * per-route concurrency persist across every spawn in the session.
   */
  private readonly routePools = new Map<string, SubagentRoutePool>();

  constructor(
    private readonly session: Session,
    private readonly ownerAgentId: string,
  ) {}

  async spawn(options: SpawnSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();

    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const profile = this.resolveProfile(parent, options.profileName);
    const reservation = await this.reserveDispatchSlot(parent, profile, options);
    const reservationId = reservation?.reservationId;
    const displayName = reservation?.displayName;
    const runOptions =
      displayName === undefined ? options : { ...options, displayName, dispatch: options.dispatch };
    const enforceIsolation = options.enforceDispatch === true;

    let handle: SubagentHandle;
    let releasePoolSlot: (() => void) | undefined;
    try {
      const resolved = this.resolveSpawnRoute(profile, options);
      const route = resolved.route;
      releasePoolSlot = resolved.releasePoolSlot;
      if (route.kind === 'external') {
        handle = this.spawnExternal(parent, profile.name, route, runOptions, randomUUID(), false, undefined, enforceIsolation);
      } else {
        const { id, agent } = await this.session.createAgent(
          { type: 'sub', generate: parent.rawGenerate },
          { parentAgentId: this.ownerAgentId, swarmItem: options.swarmItem },
        );
        const completion = this.runWithActiveChild(id, runOptions, async (childRunOptions) => {
          this.emitSubagentSpawned(parent, id, profile.name, childRunOptions);
          const worktree = await this.acquireWorktreeIfNeeded(
            parent,
            profile,
            childRunOptions.dispatch?.scope,
            enforceIsolation,
            childRunOptions.dispatch?.discardChanges === true,
          );
          try {
            await this.configureChild(parent, agent, profile, route.modelAlias, worktree?.cwd, childRunOptions);
            const result = await this.runPromptTurn(parent, id, agent, profile.name, childRunOptions);
            const finishResult = worktree
              ? await worktree.finish(analysisOnlyFinishOutcome(childRunOptions, 'success'))
              : undefined;
            const completion = this.completeWorktreeResult(
              result,
              finishResult,
              id,
              childRunOptions,
            );
            this.emitSubagentCompleted(parent, id, completion, agent.context.tokenCount);
            this.triggerSubagentStop(parent, profile.name, result.result);
            return completion;
          } catch (error) {
            if (worktree) {
              await worktree.finish(analysisOnlyFinishOutcome(childRunOptions, 'failure')).catch(() => {});
            }
            this.emitSubagentFailed(parent, id, childRunOptions, error);
            throw error;
          }
        });
        handle = {
          agentId: id,
          profileName: profile.name,
          resumed: false,
          completion,
        };
      }
    } catch (error) {
      releasePoolSlot?.();
      if (reservationId !== undefined) parent.dispatchController.release(reservationId);
      throw error;
    }
    if (reservationId === undefined && releasePoolSlot === undefined) return handle;
    return {
      ...handle,
      completion: handle.completion.then(
        (result) => {
          if (reservationId !== undefined) parent.dispatchController.release(reservationId, 'completed');
          releasePoolSlot?.();
          return result;
        },
        (error: unknown) => {
          if (reservationId !== undefined) {
            parent.dispatchController.release(
              reservationId,
              isAbortError(error) || isUserCancellation(options.signal.reason) ? 'aborted' : 'failed',
            );
          }
          releasePoolSlot?.();
          throw error;
        },
      ),
    };
  }

  /**
   * Resolves the route for a spawn, in priority order: (1) the work card's
   * one-shot `routeOverride` — fully replaces backend/model for this call
   * only, never persisted to config; (2) the profile's `coder` route pool
   * (deterministic weighted round-robin, filtered by each route's
   * `maxConcurrency`), when configured; (3) the legacy single
   * `subagent.routing` entry. Non-`coder` profiles and profiles without a
   * configured pool always take path (3), unchanged from before pooling
   * existed.
   */
  private resolveSpawnRoute(
    profile: ResolvedAgentProfile,
    options: SpawnSubagentOptions,
  ): { route: ResolvedSubagentRoute; releasePoolSlot?: () => void } {
    const config = this.session.options.config ?? { providers: {} };
    if (options.dispatch?.internalOnly === true) {
      return { route: resolveRouteByNames(config, 'kimi', options.modelAlias) };
    }

    const routeOverride = options.dispatch?.workCard?.routeOverride;
    if (routeOverride !== undefined) {
      return { route: resolveRouteByNames(config, routeOverride.backend, routeOverride.model) };
    }

    const poolRoutes = profile.name === 'coder' ? config.subagent?.pools?.[profile.name] : undefined;
    if (poolRoutes === undefined || poolRoutes.length === 0) {
      return { route: resolveSubagentRoute(config, profile.name, options.modelAlias) };
    }

    const pool = this.getRoutePool(profile.name, poolRoutes);
    const acquired = pool.acquire();
    try {
      return {
        route: resolveRouteByNames(config, acquired.route.backend, acquired.route.model),
        releasePoolSlot: acquired.release,
      };
    } catch (error) {
      acquired.release();
      throw error;
    }
  }

  private getRoutePool(profileName: string, routes: readonly SubagentPoolRoute[]): SubagentRoutePool {
    let pool = this.routePools.get(profileName);
    if (pool === undefined) {
      pool = new SubagentRoutePool(routes);
      this.routePools.set(profileName, pool);
    }
    return pool;
  }

  /**
   * Pre-spawn guardrail gate (D4/D5): reserves per-turn spawn/concurrency
   * budget and editing scope before a worker launches. Returns `undefined`
   * for resumed/retried workers, which are not new dispatch decisions and are
   * intentionally left outside this bookkeeping. Waits here (not in the
   * caller) when the request only exceeds a queue-only concurrency limit;
   * throws immediately for a structural rejection (malformed/outside/overlap/
   * exhausted-cycle scope).
   */
  private async reserveDispatchSlot(
    parent: Agent,
    profile: ResolvedAgentProfile,
    options: SpawnSubagentOptions,
  ): Promise<{ reservationId: string; displayName?: string } | undefined> {
    if (
      options.dispatch?.readOnly === true &&
      options.dispatch.allowedTools === undefined &&
      profile.tools.some((tool) =>
        ['Write', 'Edit', 'Bash', 'TaskStop', 'Agent', 'AgentSwarm'].includes(tool) || tool.startsWith('mcp__'),
      )
    ) {
      throw new Error(`Dispatch rejected: read-only peer profile "${profile.name}" exposes side-effect capability.`);
    }
    // `SessionSubagentHost.spawn` is also a public/internal compatibility API
    // used for session bootstrap and explicit callers. Only a tool-issued
    // dispatch opts into proactive-dispatch quotas and scope enforcement.
    if (options.enforceDispatch !== true) return undefined;

    const isEditingCapable = isEditingCapableProfile(profile);
    const dispatch = options.dispatch;
    if (profile.name === 'coder-ex' && (dispatch?.qualityDeficiencies?.length ?? 0) === 0) {
      throw new Error(
        'Dispatch rejected (missing-evidence): coder-ex requires at least one concrete quality deficiency.',
      );
    }
    if (profile.name === 'reviewer' && (dispatch?.reviewReason?.trim().length ?? 0) === 0) {
      throw new Error(
        'Dispatch rejected (missing-review-reason): reviewer requires a concrete review reason.',
      );
    }
    const scope = dispatch?.scope;
    // Escalation identity comes from which profile is being spawned, not from
    // model-declared intent text — the cycle gate is a runtime invariant, not
    // a keyword classifier. A scope-less escalation/review (read-only
    // reviewer with no declared scope) has no stable key to dedupe against,
    // so it is intentionally left outside the one-cycle-per-scope cap; see
    // the dispatch design notes.
    const escalationKind: DispatchEscalationKind | undefined =
      profile.name === 'coder-ex' ? 'coder-ex' : profile.name === 'reviewer' ? 'reviewer' : undefined;
    const logicalScopeKey =
      escalationKind !== undefined && scope !== undefined && scope.length > 0
        ? [...scope].map((entry) => entry.trim()).sort().join('|')
        : undefined;

    const decision = parent.dispatchController.reserve({
      requestId: randomUUID(),
      isEditingCapable,
      scope,
      escalation: logicalScopeKey !== undefined ? escalationKind : undefined,
      logicalScopeKey,
      workCard: dispatch?.workCard,
      displayProfile: dispatch?.workCard === undefined ? undefined : profile.name,
    });
    if (decision.kind === 'rejected') {
      throw new Error(`Dispatch rejected (${decision.reason}): ${decision.message}`);
    }
    if (decision.kind === 'started') {
      return { reservationId: decision.reservationId, displayName: decision.displayName };
    }
    await this.waitForDispatchStart(parent, decision.reservationId, options.signal);
    return { reservationId: decision.reservationId, displayName: decision.displayName };
  }

  private async waitForDispatchStart(
    parent: Agent,
    reservationId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      parent.dispatchController.release(reservationId);
      signal.throwIfAborted();
    }
    const outcome = await new Promise<DispatchWaitOutcome | 'aborted'>((resolve) => {
      const onAbort = (): void => resolve('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      void parent.dispatchController.waitUntilStarted(reservationId).then((result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      });
    });
    if (outcome === 'dependency-failed') {
      throw new Error('Dispatch was not started because a work-card dependency failed.');
    }
    if (outcome === 'aborted') {
      parent.dispatchController.release(reservationId);
      signal.throwIfAborted();
      throw new Error('Dispatch was cancelled before it started.');
    }
  }

  /**
   * External subagents run as a bare child process with no provider-level
   * retry — a transient non-zero exit previously killed them outright. Wraps
   * `runExternalSubagent` in a small bounded retry loop: any non-zero exit
   * (not a user-initiated abort) is retried up to
   * `EXTERNAL_SUBAGENT_MAX_ATTEMPTS` times, no stderr classification. When
   * the launcher supports resume, retries after the first failure resume the
   * same external session; otherwise each retry is a fresh spawn under a new
   * session id. Emits one `subagent.failed` per failed attempt so callers can
   * reconstruct the full attempt history; throws a structured
   * `agent.not_resumable` error once the budget is exhausted.
   */
  private async withExternalRetry(
    parent: Agent,
    id: string,
    route: Extract<ResolvedSubagentRoute, { kind: 'external' }>,
    launcher: SubagentLauncher,
    cwd: string,
    prompt: string,
    onStderr: (stderr: string) => void,
    onUsage: (usage: ExternalSubagentUsage) => void,
    initialResumed: boolean,
    initialSessionId: string,
    runOptions: RunSubagentOptions,
  ): Promise<{ completion: SubagentCompletion; sessionId: string }> {
    let resumed = initialResumed;
    let sessionId = initialSessionId;
    let lastError: unknown;
    for (let attempt = 1; attempt <= EXTERNAL_SUBAGENT_MAX_ATTEMPTS; attempt += 1) {
      try {
        const args = resumed ? launcher.resumeArgs ?? [] : launcher.args ?? [];
        const completion = await runExternalSubagent(
          route,
          cwd,
          prompt,
          runOptions.signal,
          onStderr,
          onUsage,
          args,
          sessionId,
          launcher,
        );
        return { completion, sessionId };
      } catch (error) {
        if (isAbortError(error) || runOptions.signal.aborted) throw error;
        lastError = error;
        this.emitSubagentFailed(parent, id, runOptions, error, attempt, attempt >= EXTERNAL_SUBAGENT_MAX_ATTEMPTS);
        if (attempt >= EXTERNAL_SUBAGENT_MAX_ATTEMPTS) break;
        if (launcher.resumeArgs !== undefined) {
          resumed = true;
        } else {
          resumed = false;
          sessionId = randomUUID();
        }
        const delay = Math.min(
          EXTERNAL_RETRY_BASE_DELAY_MS * EXTERNAL_RETRY_FACTOR ** (attempt - 1),
          EXTERNAL_RETRY_MAX_DELAY_MS,
        );
        try {
          await sleepForRetry(delay, runOptions.signal);
        } catch (sleepError) {
          // Already emitted for this attempt above; mark so the caller's
          // catch-all does not double-report the same failure.
          markExternalRetryEmitted(sleepError);
          throw sleepError;
        }
      }
    }
    throw markExternalRetryEmitted(
      new KimiError(
        ErrorCodes.AGENT_NOT_RESUMABLE,
        `External subagent "${id}" exhausted ${EXTERNAL_SUBAGENT_MAX_ATTEMPTS} attempts: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
        { cause: lastError },
      ),
    );
  }

  private spawnExternal(
    parent: Agent,
    profileName: string,
    route: Extract<ResolvedSubagentRoute, { kind: 'external' }>,
    options: RunSubagentOptions & { readonly swarmItem?: string },
    sessionId: string = randomUUID(),
    resumed = false,
    existingAgentId?: string,
    enforceIsolation = false,
  ): SubagentHandle {
    const readOnly = options.dispatch?.readOnly === true;
    const launcher = resolveExternalSubagentLauncher(route, readOnly);
    const id = existingAgentId ?? `${EXTERNAL_SUBAGENT_ID_PREFIX}${route.backendName}-${randomUUID()}`;
    if (existingAgentId === undefined) {
      this.session.metadata.agents[id] = {
        type: 'sub',
        parentAgentId: this.ownerAgentId,
        swarmItem: options.swarmItem,
        externalBackend: route.backendName,
        externalProfile: profileName,
        externalModelAlias: route.modelAlias,
        externalSessionId: sessionId,
        externalReadOnly: readOnly || undefined,
      };
      void this.session.writeMetadata();
    }
    const completion = this.runWithActiveChild(id, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, id, profileName, runOptions, route.backendName);
      const worktree = await this.acquireExternalWorktreeIfNeeded(
        parent,
        profileName,
        runOptions,
        enforceIsolation,
      );
      try {
        await this.triggerSubagentStart(parent, profileName, runOptions.prompt, runOptions.signal);
        runOptions.signal.throwIfAborted();
        this.emitSubagentStarted(parent, id);
        runOptions.onReady?.();
        const { completion, sessionId: finalSessionId } = await this.withExternalRetry(
          parent,
          id,
          route,
          launcher,
          worktree?.cwd ?? parent.config.cwd,
          wrapExternalSubagentPrompt(profileName, runOptions.prompt),
          (stderr) => {
            this.session.log.warn('external subagent stderr', {
              subagentId: id,
              backend: route.backendName,
              stderr: redactUntrustedRaw(stderr).redacted,
            });
          },
          (usage) => {
            parent.emitEvent({
              type: 'subagent.progress',
              subagentId: id,
              usage,
            });
          },
          resumed,
          sessionId,
          runOptions,
        );
        const finishResult = worktree
          ? await worktree.finish(analysisOnlyFinishOutcome(runOptions, 'success'))
          : undefined;
        const result = this.completeWorktreeResult(
          completion,
          finishResult,
          id,
          runOptions,
          finalSessionId,
        );
        this.emitSubagentCompleted(parent, id, result);
        this.triggerSubagentStop(parent, profileName, completion.result);
        return result;
      } catch (error) {
        if (worktree) {
          await worktree.finish(analysisOnlyFinishOutcome(runOptions, 'failure')).catch(() => {});
        }
        if (!hasExternalRetryEmitted(error)) {
          this.emitSubagentFailed(parent, id, runOptions, error);
        }
        throw error;
      }
    });
    return {
      agentId: id,
      profileName,
      resumed,
      resumable: launcher.resumeArgs !== undefined,
      completion,
    };
  }

  async resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    if (isExternalSubagentId(agentId)) {
      return this.resumeExternal(agentId, options);
    }
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, agentId, profileName, runOptions);
      try {
        child.config.update({ modelAlias: parent.config.modelAlias });
        const result = await this.runPromptTurn(parent, agentId, child, profileName, runOptions);
        this.emitSubagentCompleted(parent, agentId, result, child.context.tokenCount);
        this.triggerSubagentStop(parent, profileName, result.result);
        return result;
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, runOptions, error);
        throw error;
      }
    });
    return { agentId, profileName, resumed: true, completion };
  }

  private async resumeExternal(
    agentId: string,
    options: RunSubagentOptions,
  ): Promise<SubagentHandle> {
    const metadata = this.session.metadata.agents[agentId];
    if (
      metadata?.type !== 'sub' ||
      metadata.parentAgentId !== this.ownerAgentId ||
      metadata.externalBackend === undefined ||
      metadata.externalProfile === undefined ||
      metadata.externalSessionId === undefined
    ) {
      throw new Error(`External subagent "${agentId}" has no resumable session metadata.`);
    }
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    // Resolve strictly by the backend/model recorded at spawn time. Resume
    // must never re-enter route-pool selection or drift onto a different
    // backend because `subagent.routing`/`subagent.pools` changed since.
    const route = resolveRouteByNames(
      this.session.options.config ?? { providers: {} },
      metadata.externalBackend,
      metadata.externalModelAlias,
    );
    if (route.kind !== 'external') {
      throw new Error(`External subagent "${agentId}" backend configuration is no longer available.`);
    }
    const readOnly = metadata.externalReadOnly === true;
    const launcher = resolveExternalSubagentLauncher(route, readOnly);
    if (launcher.resumeArgs === undefined) {
      const launcherPath = readOnly ? 'read_only_launcher.resume_args' : 'resume_args';
      throw new Error(
        `External subagent backend "${route.backendName}" has no ${launcherPath}; this handle is non-resumable. Launch a fresh replacement instead.`,
      );
    }
    return this.spawnExternal(
      parent,
      metadata.externalProfile,
      route,
      metadata.externalReadOnly === true
        ? { ...options, dispatch: { ...options.dispatch, readOnly: true, discardChanges: true } }
        : options,
      metadata.externalSessionId,
      true,
      agentId,
    );
  }

  async retry(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    if (isExternalSubagentId(agentId)) {
      return this.resumeExternal(agentId, options);
    }
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      try {
        runOptions.signal.throwIfAborted();
        child.config.update({ modelAlias: parent.config.modelAlias });
        this.emitSubagentStarted(parent, agentId);
        const turnId = child.turn.retry('agent-host');
        if (turnId === null) {
          throw new Error(`Agent instance "${agentId}" could not start a retry turn`);
        }
        this.observeFirstRequest(child, runOptions);
        const result = await this.waitForChildCompletion(
          parent,
          agentId,
          child,
          profileName,
          runOptions,
        );
        this.emitSubagentCompleted(parent, agentId, result, child.context.tokenCount);
        this.triggerSubagentStop(parent, profileName, result.result);
        return result;
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, runOptions, error);
        throw error;
      }
    });
    return { agentId, profileName, resumed: true, completion };
  }

  private async ensureIdleSubagent(
    agentId: string,
  ): Promise<{ readonly parent: Agent; readonly child: Agent; readonly profileName: string }> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub') {
      throw new Error(`Agent instance "${agentId}" is not a subagent`);
    }
    if (metadata.parentAgentId !== this.ownerAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
    const child = await this.session.ensureAgentResumed(agentId);
    if (this.activeChildren.has(agentId) || child.turn.hasActiveTurn) {
      throw new Error(`Agent instance "${agentId}" is already running and cannot run concurrently`);
    }

    const profileName = child.config.profileName ?? 'subagent';
    return { parent, child, profileName };
  }

  async runQueued<T>(tasks: readonly QueuedSubagentTask<T>[]): Promise<Array<SubagentResult<T>>> {
    const maxConcurrency = resolveSwarmMaxConcurrency();
    return new SubagentBatch(this, tasks, { maxConcurrency }).run();
  }

  suspended(event: SubagentSuspendedEvent): void {
    const parent = this.session.getReadyAgent?.(this.ownerAgentId);
    parent?.emitEvent({
      type: 'subagent.suspended',
      subagentId: event.agentId,
      reason: event.reason,
    });
  }

  async startBtw(): Promise<string> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const { id, agent: child } = await this.session.createAgent(
      {
        type: 'sub',
        generate: parent.rawGenerate,
        persistence: new InMemoryAgentRecordPersistence(),
      },
      { parentAgentId: this.ownerAgentId, persistMetadata: false },
    );

    child.config.update({
      modelAlias: parent.config.modelAlias,
      thinkingEffort: parent.config.thinkingEffort,
      systemPrompt: parent.config.systemPrompt,
    });
    child.tools.copyLoopToolsFrom(parent.tools);
    child.context.useProjectedHistoryFrom(parent.context);
    child.context.appendSystemReminder(SIDE_QUESTION_SYSTEM_REMINDER.trim(), {
      kind: 'system_trigger',
      name: 'btw',
    });
    child.permission.policies.unshift(new DenyAllPermissionPolicy(TOOL_CALL_DISABLED_MESSAGE));
    return id;
  }

  cancelAll(reason: unknown = userCancellationReason()): void {
    const foregroundChildren = Array.from(this.activeChildren).filter(
      ([, child]) => !child.runInBackground,
    );
    for (const [childId, child] of foregroundChildren) {
      this.session.getReadyAgent(childId)?.subagentHost?.cancelAll(reason);
      // Abort with the cancel reason (a user interruption by default) so the
      // subagent's in-flight tools report the cause accurately to the model.
      child.controller.abort(reason);
    }
  }

  markActiveChildDetached(agentId: string): void {
    const child = this.activeChildren.get(agentId);
    if (child !== undefined) child.runInBackground = true;
  }

  async getProfileName(agentId: string): Promise<string | undefined> {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    if (metadata.externalProfile !== undefined) return metadata.externalProfile;
    return (await this.session.ensureAgentResumed(agentId)).config.profileName;
  }

  getSwarmItem(agentId: string): string | undefined {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return metadata.swarmItem;
  }

  private resolveProfile(parent: Agent, profileName: string): ResolvedAgentProfile {
    const profile =
      DEFAULT_AGENT_PROFILES[parent.config.profileName ?? 'agent']?.subagents?.[profileName] ??
      DEFAULT_AGENT_PROFILES['agent']?.subagents?.[profileName];
    if (profile === undefined) {
      throw new Error(`Subagent profile "${profileName}" was not found`);
    }
    return profile;
  }

  private runWithActiveChild(
    childId: string,
    options: RunSubagentOptions,
    run: (options: RunSubagentOptions) => Promise<SubagentCompletion>,
  ): Promise<SubagentCompletion> {
    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(childId, {
      controller,
      runInBackground: options.runInBackground,
    });

    return run({ ...options, signal: controller.signal }).finally(() => {
      unlinkAbortSignal();
      this.activeChildren.delete(childId);
    });
  }

  private async runPromptTurn(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    options.signal.throwIfAborted();
    await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
    options.signal.throwIfAborted();

    let childPrompt = options.prompt;
    if (profileName === 'explore') {
      const gitContext = await collectGitContext(child.kaos, child.config.cwd);
      if (gitContext) childPrompt = `${gitContext}\n\n${childPrompt}`;
    }

    this.emitSubagentStarted(parent, childId);
    const turnId = child.turn.prompt([{ type: 'text', text: childPrompt }], SUBAGENT_PROMPT_ORIGIN);
    if (turnId === null) {
      throw new Error(`Agent instance "${childId}" could not start a turn`);
    }
    this.observeFirstRequest(child, options);
    return this.waitForChildCompletion(parent, childId, child, profileName, options);
  }

  private async waitForChildCompletion(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    await runChildTurnToCompletion(child, options.signal);
    await this.drainChildBackgroundTasks(child, options.signal);

    // A subagent that returns an overly terse summary leaves the parent
    // agent under-informed. Give it a bounded number of chances to expand
    // the handoff; if it is still short after that, accept it as-is rather
    // than retrying indefinitely.
    let result = lastAssistantText(child);
    let remainingContinuations = SUMMARY_CONTINUATION_ATTEMPTS;
    while (remainingContinuations > 0 && result.length < SUMMARY_MIN_LENGTH) {
      remainingContinuations -= 1;
      options.signal.throwIfAborted();
      child.turn.prompt([{ type: 'text', text: SUMMARY_CONTINUATION_PROMPT }], SUBAGENT_PROMPT_ORIGIN);
      await runChildTurnToCompletion(child, options.signal);
      result = lastAssistantText(child);
    }
    const usage = child.usage.data().total;
    return { result, usage };
  }

  private async configureChild(
    parent: Agent,
    child: Agent,
    profile: ResolvedAgentProfile,
    modelAlias?: string,
    isolatedCwd?: string,
    options?: RunSubagentOptions,
  ): Promise<void> {
    child.config.update({
      cwd: isolatedCwd ?? parent.config.cwd,
      modelAlias: modelAlias ?? parent.config.modelAlias,
      thinkingEffort: parent.config.thinkingEffort,
    });

    const context = await prepareSystemPromptContext(
      this.session.systemContextKaos(child.kaos.getcwd()),
      this.session.options.kimiHomeDir,
      { additionalDirs: child.getAdditionalDirs() },
    );
    child.useProfile(profile, context, this.session.options.kimiHomeDir);
    if (options?.dispatch?.allowedTools !== undefined) {
      child.tools.setActiveTools(options.dispatch.allowedTools);
    }
    if (options?.dispatch?.readOnly !== true) child.tools.inheritUserTools(parent.tools);
  }

  /** Acquire an isolated worktree for every editing-capable dispatch. */
  private async acquireWorktreeIfNeeded(
    parent: Agent,
    profile: ResolvedAgentProfile,
    scope: readonly string[] | undefined,
    enforceIsolation: boolean,
    discardChanges = false,
  ): Promise<SubagentWorktreeHandle | null> {
    const explicitlyEnabled = parent.experimentalFlags.enabled('subagent-worktree-isolation');
    if ((!enforceIsolation && !explicitlyEnabled && !discardChanges) || (!isEditingCapableProfile(profile) && !discardChanges)) return null;
    const worktree = await acquireSubagentWorktree(parent.kaos, parent.config.cwd, { scope });
    if (worktree === null && (enforceIsolation || explicitlyEnabled)) {
      throw new Error('Editing subagent isolation could not be created; dispatch was refused.');
    }
    return worktree;
  }

  /** Resolve the profile for the external-backend spawn path, then isolate editing dispatches. */
  private async acquireExternalWorktreeIfNeeded(
    parent: Agent,
    profileName: string,
    options: RunSubagentOptions,
    enforceIsolation: boolean,
  ): Promise<SubagentWorktreeHandle | null> {
    const profile = this.resolveProfile(parent, profileName);
    if (options.dispatch?.readOnly === true || options.dispatch?.discardChanges === true) {
      const worktree = await acquireSubagentWorktree(parent.kaos, parent.config.cwd, {
        scope: options.dispatch.scope,
      });
      if (worktree === null) throw new Error('Read-only Agora peer isolation could not be created.');
      return worktree;
    }
    return this.acquireWorktreeIfNeeded(parent, profile, options.dispatch?.scope, enforceIsolation);
  }

  /**
   * Hold the run open until the child agent's background tasks (background
   * Bash, nested background agents) settle — the print-mode (`kimi -p`)
   * drain semantics applied to subagent completion. Drained tasks get their
   * terminal notifications suppressed: without that, a task outliving the
   * child's final turn steers a fresh turn on the finished subagent
   * (`steer` degrades to `launch`), which runs unobserved and whose output
   * never reaches the parent. Bounded by the run's signal — the Agent
   * tool's per-run timeout / user-cancel envelope covers the drain too.
   */
  private async drainChildBackgroundTasks(child: Agent, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      await this.suppressChildTaskNotifications(child);
      await child.background.waitForActiveTasks(() => true, { signal });
      // Suppress again after the wait: notification delivery re-checks
      // suppression after its async output snapshot, so this pass still
      // blocks notifications for tasks that settled during the wait.
      await this.suppressChildTaskNotifications(child);
      // A terminal effect that slipped past the suppression race may have
      // steered a follow-up turn onto the child; let it finish (it can fan
      // out new tasks) before declaring the child drained.
      if (child.turn.hasActiveTurn) {
        await runChildTurnToCompletion(child, signal);
        continue;
      }
      if (child.background.list(true).length === 0) return;
    }
  }

  /**
   * Suppress terminal notifications for every child background task —
   * including already-settled ones whose notification may still be in
   * flight. `list(false)` is required: the active-only list drops a task
   * the moment it terminates, which is exactly when an unsuppressed
   * notification can still steer an orphan turn onto the finished child.
   */
  private async suppressChildTaskNotifications(child: Agent): Promise<void> {
    for (const task of child.background.list(false)) {
      await child.background.suppressTerminalNotification(task.taskId);
    }
  }

  private async triggerSubagentStart(
    parent: Agent,
    profileName: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    await parent.hooks?.trigger('SubagentStart', {
      matcherValue: profileName,
      signal,
      inputData: {
        agentName: profileName,
        prompt: prompt.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private triggerSubagentStop(parent: Agent, profileName: string, result: string): void {
    void parent.hooks?.fireAndForgetTrigger('SubagentStop', {
      matcherValue: profileName,
      inputData: {
        agentName: profileName,
        response: result.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private observeFirstRequest(
    child: Agent,
    options: RunSubagentOptions,
  ): void {
    if (options.onReady === undefined) return;
    void child.turn
      .waitForTurnFirstRequest()
      .then(() => {
        options.onReady?.();
      })
      .catch(() => {});
  }

  private emitSubagentSpawned(
    parent: Agent,
    childId: string,
    profileName: string,
    options: RunSubagentOptions,
    backendName?: string,
  ): void {
    parent.emitEvent({
      type: 'subagent.spawned',
      subagentId: childId,
      subagentName: profileName,
      backendName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      parentAgentId: this.ownerAgentId,
      description: options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
      dispatch:
        options.dispatch === undefined
          ? undefined
          : {
              rationale: options.dispatch.rationale,
              scope: options.dispatch.scope,
              qualityDeficiencies: options.dispatch.qualityDeficiencies,
              reviewReason: options.dispatch.reviewReason,
              workCard: options.dispatch.workCard,
              displayName: options.displayName,
            },
    });
    parent.telemetry.track('subagent_created', {
      subagent_name: profileName,
      run_in_background: options.runInBackground,
    });
  }

  private emitSubagentStarted(
    parent: Agent,
    childId: string,
  ): void {
    parent.emitEvent({
      type: 'subagent.started',
      subagentId: childId,
    });
  }

  private completeWorktreeResult(
    completion: SubagentCompletion,
    finishResult: SubagentWorktreeFinishResult | undefined,
    agentId: string,
    options: RunSubagentOptions,
    externalSessionId?: string,
  ): SubagentCompletion {
    if (
      finishResult?.reason !== 'scope-expansion-required' ||
      finishResult.candidate === undefined ||
      finishResult.acknowledgePersisted === undefined
    ) {
      return completion;
    }
    const originalScope = options.dispatch?.scope ?? finishResult.candidate.scope;
    return {
      ...completion,
      editingCandidate: {
        draft: finishResult.candidate,
        agentId,
        logicalRunId: options.parentToolCallUuid ?? options.parentToolCallId,
        externalSessionId,
        originalScope,
        requestedScope: finishResult.candidate.requestedScope,
        outsideScope: finishResult.outsideScope ?? [],
        acknowledgePersisted: finishResult.acknowledgePersisted,
      },
    };
  }

  private emitSubagentCompleted(
    parent: Agent,
    childId: string,
    completion: SubagentCompletion,
    contextTokens?: number,
  ): void {
    if (completion.editingCandidate !== undefined) return;
    parent.emitEvent({
      type: 'subagent.completed',
      subagentId: childId,
      resultSummary: completion.result,
      usage: completion.usage,
      contextTokens,
    });
  }

  /**
   * `attempt`/`exhausted` default to 1/true for the single-shot internal and
   * resume/retry paths, which never loop — they either succeed or fail once.
   * `withExternalRetry` passes its own per-attempt values explicitly so the
   * emitted event stream reconstructs the full external attempt history.
   */
  private emitSubagentFailed(
    parent: Agent,
    childId: string,
    options: RunSubagentOptions,
    error: unknown,
    attempt = 1,
    exhausted = true,
  ): void {
    if (shouldSuppressQueuedAttemptFailureEvent(options, error)) return;
    parent.emitEvent({
      type: 'subagent.failed',
      subagentId: childId,
      error: error instanceof Error ? error.message : String(error),
      attempt,
      exhausted,
    });
  }
}

export async function runExternalSubagent(
  route: Extract<ResolvedSubagentRoute, { kind: 'external' }>,
  cwd: string,
  prompt: string,
  signal: AbortSignal,
  onStderr: (stderr: string) => void,
  onUsage?: (usage: ExternalSubagentUsage) => void,
  args: readonly string[] = route.backend.args ?? [],
  sessionId = '',
  launcher: SubagentLauncher = route.backend,
): Promise<SubagentCompletion> {
  signal.throwIfAborted();
  let promptDirectory: string | undefined;
  let promptFile: string | undefined;
  if (args.some((arg) => arg.includes('{prompt_file}'))) {
    promptDirectory = await mkdtemp(join(tmpdir(), 'kimi-subagent-'));
    promptFile = join(promptDirectory, 'prompt.txt');
    await writeFile(promptFile, prompt, 'utf8');
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(launcher.command, materializeBackendArgs(route, cwd, promptFile, args, sessionId), {
      cwd,
      shell: false,
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch (error) {
    if (promptDirectory !== undefined) await rm(promptDirectory, { recursive: true, force: true });
    throw error;
  }

  return new Promise<SubagentCompletion>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let abortReason: unknown;
    let stdinError: unknown;
    let stdoutLineBuffer = '';
    let lastReportedUsage: ExternalSubagentUsage | undefined;
    const usageByKey = new Map<string, ExternalSubagentUsage>();
    let anonymousUsage: ExternalSubagentUsage | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const reportUsage = (usage: ExternalSubagentUsage): void => {
      if (
        lastReportedUsage?.inputOther === usage.inputOther &&
        lastReportedUsage.output === usage.output &&
        lastReportedUsage.inputCacheRead === usage.inputCacheRead &&
        lastReportedUsage.inputCacheCreation === usage.inputCacheCreation
      ) return;
      lastReportedUsage = usage;
      onUsage?.(usage);
    };
    const processStdoutLine = (line: string): void => {
      const update = parseExternalSubagentStreamLine(line);
      if (update?.usage === undefined) return;
      if (update.finalUsage === true) {
        reportUsage(update.usage);
        return;
      }
      if (update.usageKey !== undefined) usageByKey.set(update.usageKey, update.usage);
      else anonymousUsage = update.usage;
      const usages = [...usageByKey.values(), ...(anonymousUsage === undefined ? [] : [anonymousUsage])];
      reportUsage(usages.reduce<ExternalSubagentUsage>(
        (total, usage) => ({
          inputOther: total.inputOther + usage.inputOther,
          output: total.output + usage.output,
          inputCacheRead: total.inputCacheRead + usage.inputCacheRead,
          inputCacheCreation: total.inputCacheCreation + usage.inputCacheCreation,
        }),
        { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
      ));
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (promptDirectory !== undefined) void rm(promptDirectory, { recursive: true, force: true });
    };
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stdoutLineBuffer.length > 0) processStdoutLine(stdoutLineBuffer);
      if (stderr.length > 0) onStderr(stderr);
      if (error !== undefined) reject(error);
      else resolve(parseExternalSubagentOutput(stdout));
    };
    const kill = (): void => {
      killTimer ??= killExternalProcess(child);
    };
    const onAbort = (): void => {
      abortReason = signal.reason ?? new Error('Aborted');
      kill();
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      stdoutLineBuffer += chunk;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? '';
      for (const line of lines) processStdoutLine(line);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (abortReason !== undefined || stdinError !== undefined) return;
      settle(error);
    });
    child.on('close', (code, closeSignal) => {
      if (abortReason !== undefined) return settle(abortReason);
      if (stdinError !== undefined) return settle(stdinError);
      if (code === 0) return settle();
      const detail = stderr.trim();
      const redactedDetail = detail.length > 0 ? redactUntrustedRaw(detail).redacted : '';
      const suffix = redactedDetail.length > 0 ? `: ${redactedDetail}` : '';
      settle(new Error(
        `External subagent backend "${route.backendName}" exited with ${code === null ? `signal ${closeSignal ?? 'unknown'}` : `code ${String(code)}`}${suffix}`,
      ));
    });
    child.stdin.on('error', (error) => {
      stdinError = error;
      if (abortReason === undefined) kill();
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (promptFile === undefined) child.stdin.end(prompt);
    else child.stdin.end();
  });
}

function killExternalProcess(child: ChildProcessWithoutNullStreams): ReturnType<typeof setTimeout> {
  if (process.platform === 'win32') {
    killProcessTreeWindows(child, false);
  } else {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }
  const timer = setTimeout(() => {
    if (process.platform === 'win32') {
      killProcessTreeWindows(child, true);
      return;
    }
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {}
  }, 100);
  timer.unref();
  return timer;
}

function killProcessTreeWindows(child: ChildProcessWithoutNullStreams, force: boolean): void {
  if (child.pid === undefined) return;
  const args = force
    ? ['/T', '/F', '/PID', String(child.pid)]
    : ['/T', '/PID', String(child.pid)];
  try {
    const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    killer.once('error', () => {});
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {}
  }
}

async function runChildTurnToCompletion(child: Agent, signal: AbortSignal): Promise<void> {
  const completion = await child.turn.waitForCurrentTurn(signal);
  const turnEnded = completion.event;
  if (turnEnded.reason !== 'completed') {
    if (turnEnded.error?.code === ErrorCodes.PROVIDER_FILTERED) {
      throw new Error('Subagent turn blocked by provider safety policy');
    }
    if (turnEnded.error?.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
      throw providerRateLimitErrorFromPayload(turnEnded.error);
    }
    throw new Error(
      turnEnded.error === undefined
        ? `Subagent turn ${turnEnded.reason}`
        : `[${turnEnded.error.code}] ${turnEnded.error.message}`,
    );
  }
  if (completion.stopReason === 'max_tokens') {
    throw new Error(`${SUBAGENT_MAX_TOKENS_ERROR}.`);
  }
}

function providerRateLimitErrorFromPayload(error: {
  readonly message: string;
  readonly details?: Record<string, unknown>;
}): APIProviderRateLimitError {
  const requestId =
    typeof error.details?.['requestId'] === 'string' ? error.details['requestId'] : null;
  return new APIProviderRateLimitError(error.message, requestId);
}

function lastAssistantText(agent: Agent): string {
  for (const message of [...agent.context.history].toReversed()) {
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text.trim().length > 0) return text.trim();
  }
  return '';
}

function shouldSuppressQueuedAttemptFailureEvent(
  options: RunSubagentOptions,
  error: unknown,
): boolean {
  if (options.suppressRateLimitFailureEvent !== true) return false;
  if (isProviderRateLimitError(error)) return true;
  return isAbortError(error) || options.signal.aborted;
}

/** Analysis-only runs discard deltas; editing failures preserve recovery evidence. */
function analysisOnlyFinishOutcome(
  options: Pick<RunSubagentOptions, 'dispatch'>,
  phase: 'success' | 'failure',
): SubagentWorktreeOutcome {
  if (options.dispatch?.readOnly === true || options.dispatch?.discardChanges === true) {
    return {
      kind: 'discard',
      reason: phase === 'success'
        ? 'analysis-only subagent delta discarded'
        : 'analysis-only subagent delta discarded after failure',
    };
  }
  return phase === 'success' ? { kind: 'success' } : { kind: 'incomplete' };
}
