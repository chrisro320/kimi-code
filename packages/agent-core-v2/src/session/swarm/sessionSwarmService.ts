/**
 * `sessionSwarm` domain — `ISessionSwarmService` implementation.
 *
 * Runs a batch of agents on behalf of a caller agent: builds an
 * `AgentRunBatchLauncher` on top of the `agentLifecycle` primitives
 * (`create({ binding })`, `run`), drives the internal `AgentRunBatch`
 * scheduler, and tracks one `AbortController` per caller so `cancel` can abort
 * every in-flight run. The caller ↔ child association is this domain's own
 * business data: requester-side display facts (`subagent.spawned` wire signals
 * carrying the swarm's tool-call context, `subagent.suspended` when a task is
 * requeued after a provider rate limit) are emitted from this layer; the
 * lifecycle registry itself stays flat. Spawn tasks may carry a concrete
 * `binding` resolved by the caller; without
 * one, spawns inherit the caller agent's model and thinking level. Profile
 * routing (`[subagent.routing.*]` / `[[subagent.pools.*]]`, resolved through
 * `ISessionSubagentRoutingService` per spawn attempt) wins over both — a
 * pool slot is acquired per spawn and released when the agent's run settles,
 * held across provider-rate-limit retries of the same agent. Spawn
 * bindings are resolved through the model catalog before lifecycle allocation.
 * Resumed agents keep the model recorded in their own wire journal — with
 * per-subagent models there is no "child follows the parent's current model"
 * invariant to enforce. Bound at Session scope.
 */

import type { TokenUsage } from '#/kosong/contract/usage';
import { IModelCatalog } from '#/kosong/model/catalog';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { linkAbortSignal } from '#/_base/utils/abort';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IEventBus } from '#/app/event/eventBus';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  isSubagentMeta,
  subagentLabels,
  subagentParentAgentId,
  subagentSwarmItem,
} from '#/session/agentLifecycle/subagentMetadata';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionSubagentService, type AgentRunHandle } from '#/session/subagent/subagent';
import { wrapSubagentModelError } from '#/session/subagent/configSection';
import { ISessionSubagentRoutingService } from '#/session/subagent/routingService';
import { circuitOpeningErrorCode, subagentRouteIdentity } from '#/session/subagent/circuit';
import { ISessionSubagentCircuitService } from '#/session/subagent/circuitService';
import { isProviderRateLimitError } from '#/kosong/contract/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ILogService } from '#/_base/log/log';

import {
  ISessionSwarmService,
  type SessionSwarmRunArgs,
  type SessionSwarmRunResult,
  type SessionSwarmTask,
} from './sessionSwarm';
import {
  resolveSwarmMaxConcurrency,
  AgentRunBatch,
  type AgentRunAttemptOptions,
  type AgentSpawnAttemptOptions,
  type AgentRunBatchLauncher,
  type AgentRunAttemptHandle,
} from './agentRunBatch';

export interface SubagentSuspendedEvent {
  readonly type: 'subagent.suspended';
  readonly subagentId: string;
  readonly reason: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'subagent.suspended': SubagentSuspendedEvent;
  }
}

const RESUMED_PROFILE_FALLBACK = 'subagent';

export class SessionSwarmService implements ISessionSwarmService {
  declare readonly _serviceBrand: undefined;

  private readonly inFlight = new Map<string, AbortController>();

  /**
   * Pool-slot releases of in-flight swarm spawns, keyed by child agent id. A
   * slot is held across provider-rate-limit retries of the same agent and
   * released when the agent's run reaches any other terminal state; the
   * per-batch sweep in `run` covers requeued agents whose retry never came.
   */
  private readonly poolSlots = new Map<string, () => void>();

  /**
   * R-A2 (Case 8) circuit keys of routed swarm spawns, keyed by child agent
   * id. Unlike pool slots these are never swept: circuit state must outlive
   * the batch so a later spawn skips the known-dead route.
   */
  private readonly circuitEntries = new Map<string, { readonly key: string; readonly identity: string }>();

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
    @ILogService private readonly log: ILogService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ISessionSubagentRoutingService
    private readonly subagentRouting: ISessionSubagentRoutingService,
    @ISessionSubagentCircuitService
    private readonly subagentCircuit: ISessionSubagentCircuitService,
  ) {}

  /** Records `error` against the agent's circuit when it is a non-retryable route failure. */
  private recordCircuitFailure(agentId: string, error: unknown): void {
    const entry = this.circuitEntries.get(agentId);
    if (entry === undefined) return;
    const code = circuitOpeningErrorCode(error);
    if (code !== undefined) this.subagentCircuit.openCircuit(entry.key, entry.identity, code);
  }

  async getSwarmItem(args: {
    readonly callerAgentId: string;
    readonly agentId: string;
  }): Promise<string | undefined> {
    const meta = await this.agentMeta(args.agentId);
    if (!isSubagentMeta(meta)) return undefined;
    if (subagentParentAgentId(meta) !== args.callerAgentId) return undefined;
    return subagentSwarmItem(meta);
  }

  run<T>(args: SessionSwarmRunArgs<T>): Promise<readonly SessionSwarmRunResult<T>[]> {
    const { callerAgentId, tasks } = args;
    const controller = new AbortController();
    this.inFlight.set(callerAgentId, controller);
    const unlinks: Array<() => void> = [];
    const linkedTasks: SessionSwarmTask<T>[] = tasks.map((task) => {
      if (task.signal !== undefined) unlinks.push(linkAbortSignal(task.signal, controller));
      return { ...task, signal: controller.signal };
    });
    const batchPoolAgents = new Set<string>();
    const launcher: AgentRunBatchLauncher = {
      spawn: (options) => this.spawnAttempt(callerAgentId, options, batchPoolAgents),
      resume: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, false),
      retry: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, true),
      suspended: (event) => {
        const caller = this.lifecycle.get(callerAgentId);
        caller?.accessor.get(IEventBus)?.publish({
          type: 'subagent.suspended',
          subagentId: event.agentId,
          reason: event.reason,
        });
      },
    };
    const maxConcurrency = resolveSwarmMaxConcurrency();
    const promise = new AgentRunBatch(launcher, linkedTasks, { maxConcurrency }).run();
    void promise.finally(() => {
      for (const unlink of unlinks) unlink();
      if (this.inFlight.get(callerAgentId) === controller) this.inFlight.delete(callerAgentId);
      // Sweep pool slots of agents whose rate-limit retry never came (batch
      // aborted or failed while they were requeued). Already-released slots
      // are no-ops.
      for (const agentId of batchPoolAgents) this.releasePoolSlotFor(agentId);
    });
    return promise;
  }

  cancel({ callerAgentId }: { readonly callerAgentId: string }): void {
    this.inFlight.get(callerAgentId)?.abort();
  }

  private async spawnAttempt(
    callerAgentId: string,
    options: AgentSpawnAttemptOptions,
    batchPoolAgents: Set<string>,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    await this.catalog.ready;
    const profile = this.catalog.get(options.profileName);
    if (profile === undefined) {
      throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${options.profileName}"`, {
        details: { profileName: options.profileName },
      });
    }
    const callerData = caller.accessor.get(IAgentProfileService).data();
    if (callerData.modelAlias === undefined) {
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Caller agent has no model bound', {
        details: { agentId: callerAgentId },
      });
    }
    // Profile routing (pool first, then the static entry) overrides the
    // caller-supplied binding **per field** — see design D-B5R-5: the binding
    // base is always computed first, the route only overrides fields it sets.
    // Per-spawn acquisition happens here, not in the tool, so queued
    // acquisitions interleave with the batch scheduler instead of deadlocking
    // it.
    const spawnRoute = await this.subagentRouting.resolveSpawnRoute(
      options.profileName,
      options.signal,
    );
    let releasePoolSlot = spawnRoute?.releasePoolSlot;
    let childId: string | undefined;
    try {
      const binding = options.binding ?? {
        model: callerData.modelAlias,
        thinking: callerData.thinkingLevel,
      };
      const final =
        spawnRoute === undefined
          ? binding
          : {
              model: spawnRoute.route.modelAlias ?? binding.model,
              thinking: spawnRoute.route.thinkingEffort ?? binding.thinking,
            };
      let child: IAgentScopeHandle;
      try {
        this.modelCatalog.get(final.model);
        child = await this.lifecycle.create({
          binding: {
            profile: profile.name,
            model: final.model,
            thinking: final.thinking,
          },
          labels: subagentLabels(callerAgentId, { swarmItem: options.swarmItem }),
        });
      } catch (error) {
        throw wrapSubagentModelError(error, final.model, callerData.modelAlias);
      }
      childId = child.id;
      if (spawnRoute !== undefined) {
        this.circuitEntries.set(child.id, {
          key: spawnRoute.circuitKey,
          identity: subagentRouteIdentity(spawnRoute.route),
        });
      }
      child.accessor
        .get(IAgentPermissionModeService)
        .setMode(caller.accessor.get(IAgentPermissionModeService).mode);
      child.accessor
        .get(IAgentUserToolService)
        .inheritUserTools(caller.accessor.get(IAgentUserToolService));
      emitAgentRunSpawned(caller, child.id, {
        profileName: options.profileName,
        parentToolCallId: options.parentToolCallId,
        parentToolCallUuid: options.parentToolCallUuid,
        description: options.description,
        swarmIndex: options.swarmIndex,
        runInBackground: options.runInBackground,
      });
      const promptText = await applyProfilePromptPrefix(profile, options.prompt, {
        cwd: this.sessionContext.cwd,
        runner: this.processRunner,
        log: this.log,
      });
      if (releasePoolSlot !== undefined) {
        this.poolSlots.set(child.id, releasePoolSlot);
        batchPoolAgents.add(child.id);
        releasePoolSlot = undefined;
      }
      return this.observe(
        caller,
        child.id,
        options.profileName,
        {
          kind: 'prompt',
          prompt: promptText,
        },
        options,
      );
    } catch (error) {
      if (childId !== undefined) this.recordCircuitFailure(childId, error);
      releasePoolSlot?.();
      throw error;
    }
  }

  private async resumeAttempt(
    callerAgentId: string,
    agentId: string,
    options: AgentRunAttemptOptions,
    retryTurn: boolean,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    await this.requireOwnedSubagent(callerAgentId, agentId);
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    const child = this.requireHandle(agentId, 'Agent instance');
    this.requireIdleSubagent(agentId, child);
    const profileName =
      child.accessor.get(IAgentProfileService).data().profileName ?? RESUMED_PROFILE_FALLBACK;
    if (!retryTurn) {
      emitAgentRunSpawned(caller, agentId, {
        profileName,
        parentToolCallId: options.parentToolCallId,
        parentToolCallUuid: options.parentToolCallUuid,
        description: options.description,
        swarmIndex: options.swarmIndex,
        runInBackground: options.runInBackground,
      });
    }
    const request = retryTurn
      ? ({ kind: 'retry' } as const)
      : ({ kind: 'prompt', prompt: options.prompt } as const);
    return this.observe(caller, child.id, profileName, request, options);
  }

  private async observe(
    caller: IAgentScopeHandle,
    agentId: string,
    profileName: string,
    request: { kind: 'prompt'; prompt: string } | { kind: 'retry' },
    options: AgentRunAttemptOptions,
  ): Promise<AgentRunAttemptHandle> {
    let run: AgentRunHandle;
    try {
      run = await this.subagents.run(agentId, request, {
        signal: options.signal,
        onReady: options.onReady,
      });
    } catch (error) {
      // The run never started, so no completion handler will ever fire —
      // a held pool slot would leak here and eventually deadlock the batch
      // behind `acquireQueued` (the per-batch sweep only runs at settle).
      this.recordCircuitFailure(agentId, error);
      this.releasePoolSlotFor(agentId);
      throw error;
    }
    const mirrored = mirrorAgentRun(caller, run, {
      profileName,
      prompt: request.kind === 'prompt' ? request.prompt : undefined,
      suppressRateLimitFailureEvent: options.suppressRateLimitFailureEvent,
      signal: options.signal,
    });
    const completion = mirrored.then(
      (r) => ({ result: r.summary, usage: r.usage }),
      (error: unknown) => {
        // R-A2 (Case 8): record before the rate-limit branch below — a
        // rate-limit rejection never opens the circuit
        // (circuitOpeningErrorCode filters it), so requeued retries are
        // unaffected.
        this.recordCircuitFailure(agentId, error);
        throw error;
      },
    );
    if (!this.poolSlots.has(agentId)) {
      return { agentId, profileName, completion };
    }
    return {
      agentId,
      profileName,
      completion: completion.then(
        (settled) => {
          this.releasePoolSlotFor(agentId);
          return settled;
        },
        (error: unknown) => {
          // A provider rate limit requeues the SAME agent for a retry, so its
          // pool slot stays held across attempts; every other terminal state
          // releases. Requeued agents whose retry never comes are covered by
          // the per-batch sweep in `run`.
          if (!isProviderRateLimitError(error)) this.releasePoolSlotFor(agentId);
          throw error;
        },
      ),
    };
  }

  private releasePoolSlotFor(agentId: string): void {
    const release = this.poolSlots.get(agentId);
    if (release === undefined) return;
    this.poolSlots.delete(agentId);
    release();
  }

  private requireHandle(agentId: string, label: string): IAgentScopeHandle {
    const handle = this.lifecycle.get(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `${label} "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    return handle;
  }

  private requireIdleSubagent(agentId: string, child: IAgentScopeHandle): void {
    if (child.accessor.get(IAgentLoopService).status().state === 'running') {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_RUNNING,
        `Agent instance "${agentId}" is already running and cannot run concurrently`,
        { details: { agentId } },
      );
    }
  }

  private async requireOwnedSubagent(callerAgentId: string, agentId: string): Promise<void> {
    const meta = await this.agentMeta(agentId);
    if (!isSubagentMeta(meta)) {
      throw new Error2(ErrorCodes.AGENT_NOT_A_SUBAGENT, `Agent instance "${agentId}" is not a subagent`, {
        details: { agentId },
      });
    }
    if (subagentParentAgentId(meta) !== callerAgentId) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_OWNED,
        `Agent instance "${agentId}" does not belong to this parent agent`,
        { details: { agentId, callerAgentId } },
      );
    }
  }

  private async agentMeta(agentId: string): Promise<AgentMeta | undefined> {
    const meta = await this.metadata.read();
    return meta.agents?.[agentId];
  }
}

export type _AgentRunUsage = TokenUsage;

registerScopedService(
  LifecycleScope.Session,
  ISessionSwarmService,
  SessionSwarmService,
  ScopeActivation.OnScopeCreated,
  'sessionSwarm',
);
