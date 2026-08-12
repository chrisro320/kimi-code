/**
 * `fullCompaction` domain — `IAgentFullCompactionService` implementation.
 *
 * Runs full-history compaction: reserves the per-turn compaction slot, runs
 * `hooks.onWillCompact` (PreCompact) exactly once, then either hands the
 * round to the active context manager's `onWillCompact` delegate (whose
 * `handled: true` return must already carry its durable wire mutation — the
 * result is only a receipt) or drives the built-in compaction LLM round
 * (with overflow / truncation shrink retries), and finishes both through
 * one common envelope (prompt refresh → token counts → injection →
 * completion → settle last). Also recovers the loop from
 * context-overflow failures by blocking the turn on the in-flight job. The
 * built-in round's remote and local requests share the orchestrator's
 * single `LlmRequestContext` manager snapshot. The
 * mutable plain-data state (`compactionCountInTurn`,
 * `observedMaxContextTokensByModel`, `lastCompactedTokenCount`,
 * `consecutiveOverflowCompactions`, `activeTurnId`) is registered into
 * `agentState` (`IAgentStateService`) and read/written through it;
 * `_compacting` (the in-flight job — AbortController / Promise / trace), the
 * `hooks.onWillCompact` slot, the `_onDidFinishCompaction` Emitter, the
 * `strategy`, and the lazily-resolved `contextInjectorService` stay instance
 * fields (mechanism, not plain data). Bound at Agent scope and constructed with
 * the scope so the overflow recovery handler registers before the first turn
 * runs. A completed round does not refresh the profile's system prompt inline:
 * the mid-turn refresh would reach no request of this turn — the turn config
 * freezes the prompt at the turn's first request — and would only make
 * fold-time requests send a prefix the provider never saw. Instead the service
 * requests the refresh and the loop applies it at the next turn boundary.
 */

import { Service } from "#/_base/di/service";
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService, type LogContext } from '#/_base/log/log';
import { defineState } from '#/_base/state/stateRegistry';
import { renderPrompt } from "#/_base/utils/render-prompt";
import { estimateTokensForMessage } from "#/kosong/contract/tokens";
import { buildCompactionSummaryText, isRealUserInput } from '#/agent/contextMemory/compactionHandoff';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentLLMRequesterService, type AgentLLMRequestFinish, type LlmRequestContext } from '#/agent/llmRequester/llmRequester';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { retryBackoffDelays, sleepForRetry } from '#/_base/utils/retry';
import { IAgentLoopService, type LoopErrorContext } from '#/agent/loop/loop';
import { abortable, isAbortError } from '#/_base/utils/abort';
import { IAgentProfileService, type ProfileModelContext } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { renderTodoList, type TodoItem } from '#/session/todo/todoItem';
import {
  APIContextOverflowError,
  APIEmptyResponseError,
  APIStatusError,
  classifyApiError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import type { CompactionCheckpoint } from '#/kosong/contract/compaction';
import { createUserMessage, type Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import { inputTotal, type TokenUsage } from '#/kosong/contract/usage';
import { IEventBus } from '#/app/event/eventBus';
import type { CompactionFailedEvent, CompactionFinishedEvent, CompactionRemoteFallbackEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2, isCodedError, isError2, toKimiErrorPayload, unwrapErrorCause } from "#/errors";
import { IWireService } from '#/wire/wire';
import compactionInstructionTemplate from './compaction-instruction.md?raw';
import {
  IAgentFullCompactionService,
  type FullCompactionInput,
  type FullCompactionTask,
} from './fullCompaction';
import {
  RuntimeCompactionStrategy,
  type CompactionStrategy,
} from './strategy';
import {
  CompactionModel,
  fullCompactionBegin,
  fullCompactionCancel,
  fullCompactionComplete,
} from './compactionOps';
import {
  type CompactionBeginData,
  type CompactionResult,
} from './types';
import { Emitter, type Event } from '#/_base/event';
import { OrderedHookSlot } from '#/hooks';

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;
const DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS = 128 * 1024;
const OVERFLOW_CONTEXT_SAFETY_RATIO = 0.85;
const OVERFLOW_STATUS_RECOVERY_RATIO = 0.5;
/** How far the remote fold's cache hit may trail the summarizer's before it is worth a warning. */
const CACHE_HIT_GAP_WARN_THRESHOLD = 0.2;
const MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS = 3;
const COMPACTION_OVERFLOW_SHRINK_RATIOS = [0.7, 0.5, 0.35] as const;
const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

type CompactionTelemetryProperties = Pick<
  CompactionFinishedEvent,
  'input_tokens' | 'output_tokens' | 'input_cache_read' | 'input_cache_creation'
>;

interface ActiveCompaction extends FullCompactionTask {
  readonly originTurnId?: number;
  trace?: LLMRequestTrace;
  blockedByTurn: boolean;
}

interface CompactionAttemptResult {
  readonly summary: string;
  readonly usage: TokenUsage | null;
  readonly traceId?: string;
}

class CompactionTruncatedError extends Error {
  constructor() {
    super('Compaction response was truncated before producing a complete summary.');
    this.name = 'CompactionTruncatedError';
  }
}

export const fullCompactionCompactionCountInTurnKey = defineState<number>(
  'fullCompaction.compactionCountInTurn',
  () => 0,
);
export const fullCompactionObservedMaxContextTokensByModelKey = defineState<Map<string, number>>(
  'fullCompaction.observedMaxContextTokensByModel',
  () => new Map(),
);
export const fullCompactionLastCompactedTokenCountKey = defineState<number | null>(
  'fullCompaction.lastCompactedTokenCount',
  () => null,
);
export const fullCompactionConsecutiveOverflowCompactionsKey = defineState<number>(
  'fullCompaction.consecutiveOverflowCompactions',
  () => 0,
);
export const fullCompactionActiveTurnIdKey = defineState<number | undefined>(
  'fullCompaction.activeTurnId',
  () => undefined as number | undefined,
);

export class AgentFullCompactionService extends Service implements IAgentFullCompactionService {
  declare readonly _serviceBrand: undefined;
  readonly hooks: IAgentFullCompactionService['hooks'] = {
    onWillCompact: new OrderedHookSlot<FullCompactionTask>(),
  };
  private readonly _onDidFinishCompaction = this._register(new Emitter<FullCompactionTask>());
  readonly onDidFinishCompaction: Event<FullCompactionTask> = this._onDidFinishCompaction.event;

  private readonly strategy: CompactionStrategy;
  private _compacting: ActiveCompaction | null = null;
  private contextInjectorService: IAgentContextInjectorService | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentTokenCountingService private readonly tokenCounting: IAgentTokenCountingService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionTodoService private readonly todo: ISessionTodoService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @ILogService private readonly log: ILogService,
    @IAgentLoopService private readonly loopService: IAgentLoopService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(fullCompactionCompactionCountInTurnKey);
    this.states.register(fullCompactionObservedMaxContextTokensByModelKey);
    this.states.register(fullCompactionLastCompactedTokenCountKey);
    this.states.register(fullCompactionConsecutiveOverflowCompactionsKey);
    this.states.register(fullCompactionActiveTurnIdKey);
    this.strategy = new RuntimeCompactionStrategy(
      () => this.resolveModelContextWithEffectiveMax(),
      (message) => this.tokenCounting.estimateMessage(message),
    );
    this._register(
      this.wire.hooks.onDidRestore.register('full-compaction', async (_ctx, next) => {
        this.normalizeAfterReplay();
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.started', () => this.resetForTurn()),
    );
    this._register(
      this.eventBus.subscribe('turn.ended', () => {
        this.activeTurnId = undefined;
      }),
    );
    this._register(
      this.loopService.hooks.onWillBeginStep.register('full-compaction', async (ctx, next) => {
        await this.beforeStep(ctx.signal, ctx.turnId);
        await next();
      }),
    );
    this._register(
      this.loopService.hooks.onDidFinishStep.register('full-compaction', async (_ctx, next) => {
        await this.afterStep();
        await next();
      }),
    );
    this._register(
      this.loopService.registerLoopErrorHandler({
        id: 'full-compaction',
        match: (context) => this.shouldRecoverFromContextOverflow(context.error),
        handle: (context) => this.recoverFromContextOverflow(context),
      }),
    );
  }

  private get compactionCountInTurn(): number {
    return this.states.get(fullCompactionCompactionCountInTurnKey);
  }

  private set compactionCountInTurn(value: number) {
    this.states.set(fullCompactionCompactionCountInTurnKey, value);
  }

  private get observedMaxContextTokensByModel(): Map<string, number> {
    return this.states.get(fullCompactionObservedMaxContextTokensByModelKey);
  }

  private get lastCompactedTokenCount(): number | null {
    return this.states.get(fullCompactionLastCompactedTokenCountKey);
  }

  private set lastCompactedTokenCount(value: number | null) {
    this.states.set(fullCompactionLastCompactedTokenCountKey, value);
  }

  private get consecutiveOverflowCompactions(): number {
    return this.states.get(fullCompactionConsecutiveOverflowCompactionsKey);
  }

  private set consecutiveOverflowCompactions(value: number) {
    this.states.set(fullCompactionConsecutiveOverflowCompactionsKey, value);
  }

  private get activeTurnId(): number | undefined {
    return this.states.get(fullCompactionActiveTurnIdKey);
  }

  private set activeTurnId(value: number | undefined) {
    this.states.set(fullCompactionActiveTurnIdKey, value);
  }

  get compacting(): FullCompactionTask | null {
    return this._compacting;
  }

  private getEffectiveMaxContextTokens(): number {
    const capability = this.profile.data().modelCapabilities;
    const configured = capability.max_input_tokens ?? capability.max_context_tokens;
    const modelAlias = this.profile.data().modelAlias;
    const observed =
      modelAlias === undefined ? undefined : this.observedMaxContextTokensByModel.get(modelAlias);
    if (observed === undefined) return configured;
    if (configured <= 0) return observed;
    return Math.min(configured, observed);
  }

  private resolveModelContextWithEffectiveMax(): ProfileModelContext {
    const resolved = this.profile.resolveModelContext();
    const effectiveMax = this.getEffectiveMaxContextTokens();
    return {
      ...resolved,
      modelCapabilities: {
        ...resolved.modelCapabilities,
        max_context_tokens: effectiveMax,
        max_input_tokens: effectiveMax,
      },
    };
  }

  private currentRequestTokens(): number {
    return this.requestTokens(this.context.get());
  }

  private requestTokens(messages: readonly Message[]): number {
    return this.tokenCounting.requestSize({
      systemPrompt: this.profile.getSystemPrompt(),
      tools: this.defaultTools().filter((tool) => tool.deferred !== true),
      messages,
    });
  }

  private defaultTools(): readonly Tool[] {
    return this.toolSelect
      .shapeTools(this.toolRegistry.list())
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
        deferred: tool.deferred,
      }));
  }

  private shouldRecoverFromContextOverflow(
    error: unknown,
    estimatedRequestTokens = this.currentRequestTokens(),
  ): boolean {
    if (isCodedError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW) return true;
    const statusError = findAPIStatusError(error);
    if (statusError instanceof APIContextOverflowError) return true;
    if (statusError === undefined || statusError.statusCode !== 413) return false;
    const effectiveMax = this.getEffectiveMaxContextTokens();
    return (
      effectiveMax > 0 &&
      estimatedRequestTokens >= effectiveMax * OVERFLOW_STATUS_RECOVERY_RATIO
    );
  }

  private observeContextOverflow(estimatedRequestTokens: number): void {
    if (!Number.isFinite(estimatedRequestTokens) || estimatedRequestTokens <= 0) return;
    const modelAlias = this.profile.data().modelAlias;
    if (modelAlias === undefined) return;
    const observed = Math.max(
      1,
      Math.floor(estimatedRequestTokens * OVERFLOW_CONTEXT_SAFETY_RATIO),
    );
    const current = this.getEffectiveMaxContextTokens();
    if (current > 0 && observed >= current) return;
    this.observedMaxContextTokensByModel.set(modelAlias, observed);
  }

  begin(input: FullCompactionInput): boolean {
    if (this._compacting) return false;
    const data: CompactionBeginData = { source: input.source, instruction: input.instruction };
    if (!this.reserveCompactionSlot(data.source)) return false;

    const tokenCount = this.validateCompactionStart(data.source);
    this.wire.dispatch(fullCompactionBegin(data));

    const active = this.createActiveCompaction(
      data.source,
      tokenCount,
      data.source === 'auto' ? this.activeTurnId : undefined,
    );
    this._compacting = active.task;
    active.task.abortController.signal.addEventListener(
      'abort',
      () => this.cancelActive(active.task),
      { once: true },
    );
    void this.compactionOrchestrator(active.task, data).then(active.resolve, active.reject);
    void active.task.promise.catch(() => undefined);
    return true;
  }

  private reserveCompactionSlot(source: CompactionBeginData['source']): boolean {
    if (source === 'manual') {
      this.compactionCountInTurn = 0;
    } else {
      this.compactionCountInTurn += 1;
    }
    return this.compactionCountInTurn <= this.strategy.maxCompactionPerTurn;
  }

  private validateCompactionStart(source: CompactionBeginData['source']): number {
    const history = this.context.get();
    if (history.length === 0) {
      throw new Error2(ErrorCodes.COMPACTION_UNABLE, 'No messages to compact in current history.');
    }
    if (source === 'manual' && this.loopService.status().state !== 'idle') {
      throw new Error2(
        ErrorCodes.COMPACTION_UNABLE,
        'Cannot compact while a turn is active. Wait for it to finish, then retry.',
      );
    }
    return this.tokenCounting.estimateMessages(history);
  }

  private createActiveCompaction(
    trigger: CompactionBeginData['source'],
    tokenCount: number,
    originTurnId: number | undefined,
  ): {
    readonly task: ActiveCompaction;
    readonly resolve: (result: CompactionResult) => void;
    readonly reject: (reason: unknown) => void;
  } {
    const abortController = new AbortController();
    let resolve!: (result: CompactionResult) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<CompactionResult>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return {
      task: {
        abortController,
        promise,
        trigger,
        tokenCount,
        originTurnId,
        get traceId() {
          return this.trace?.traceId;
        },
        blockedByTurn: false,
      },
      resolve,
      reject,
    };
  }

  override dispose(): void {
    if (this._compacting !== null && !this._compacting.abortController.signal.aborted) {
      this._compacting.abortController.abort();
    }
    super.dispose();
  }

  private cancelActive(active: ActiveCompaction): boolean {
    if (this._compacting !== active) return false;
    this.wire.dispatch(fullCompactionCancel({}));
    this._compacting = null;
    if (!active.abortController.signal.aborted) {
      active.abortController.abort();
    }
    this.eventBus.publish({ type: 'compaction.cancelled' });
    return true;
  }

  private markCompleted(active: ActiveCompaction): boolean {
    if (this._compacting !== active) return false;
    this.wire.dispatch(fullCompactionComplete({}));
    this._compacting = null;
    return true;
  }

  private normalizeAfterReplay(): void {
    if (this.wire.getModel(CompactionModel).phase !== 'running') return;
    this.wire.dispatch(fullCompactionCancel({}));
  }

  private resetForTurn(): void {
    this.compactionCountInTurn = 0;
    this.lastCompactedTokenCount = null;
    this.consecutiveOverflowCompactions = 0;
  }

  private async recoverFromContextOverflow(
    context: LoopErrorContext,
  ): Promise<boolean> {
    this.recordOverflowRecovery(context.error);
    const didStartCompaction = this.beginAutoCompaction();
    if (!didStartCompaction && !this._compacting) return false;

    await this.block(context.signal, context.turnId);
    return this.retryFailedDriver(context);
  }

  private recordOverflowRecovery(error: unknown): void {
    this.observeContextOverflow(this.currentRequestTokens());
    this.consecutiveOverflowCompactions += 1;
    const maxAttempts = this.strategy.maxOverflowCompactionAttempts;
    if (this.consecutiveOverflowCompactions <= maxAttempts) return;
    throw new Error2(
      ErrorCodes.CONTEXT_OVERFLOW,
      `Compaction failed to bring the context under the model window after ${String(maxAttempts)} attempts.`,
      { cause: error instanceof Error ? error : undefined },
    );
  }

  private retryFailedDriver(context: LoopErrorContext): boolean {
    const driver = context.failedDriver;
    if (driver === undefined || context.currentStep?.signal.aborted === true) return false;
    context.retry(driver, { at: 'head' });
    return true;
  }

  private async beforeStep(signal: AbortSignal, turnId?: number): Promise<void> {
    this.activeTurnId = turnId;
    this.checkAutoCompaction();
    if (this.strategy.shouldBlock(this.tokenCountWithPending())) {
      await this.block(signal, turnId);
    }
  }

  private async afterStep(): Promise<void> {
    this.consecutiveOverflowCompactions = 0;
    if (this.strategy.checkAfterStep) {
      this.checkAutoCompaction(false);
    }
  }

  private checkAutoCompaction(throwOnLimit = true): boolean {
    if (this._compacting) return true;
    if (
      this.lastCompactedTokenCount !== null &&
      this.tokenCountWithPending() <= this.lastCompactedTokenCount
    ) {
      return false;
    }
    if (!this.strategy.shouldCompact(this.tokenCountWithPending())) return false;
    return this.beginAutoCompaction(throwOnLimit);
  }

  private beginAutoCompaction(throwOnLimit = true): boolean {
    if (this._compacting) return true;
    const maxCompactions = this.strategy.maxCompactionPerTurn;
    if (this.compactionCountInTurn >= maxCompactions) {
      if (throwOnLimit) {
        throw new Error2(ErrorCodes.CONTEXT_OVERFLOW, `Compaction limit exceeded (${String(maxCompactions)})`, {
          details: { maxCompactions },
        });
      }
      return false;
    }
    return this.begin({ source: 'auto' });
  }

  private async block(signal?: AbortSignal, turnId?: number): Promise<void> {
    const active = this._compacting;
    if (active === null) return;
    active.blockedByTurn = true;
    this.propagateBlockingAbort(active, signal);
    this.eventBus.publish({ type: 'compaction.blocked', turnId });
    try {
      await active.promise;
    } catch (error) {
      if (this.wasBlockingWaitAborted(active, signal, error)) return;
      throw error;
    }
  }

  private propagateBlockingAbort(active: ActiveCompaction, signal: AbortSignal | undefined): void {
    signal?.addEventListener(
      'abort',
      () => {
        if (this._compacting === active) active.abortController.abort();
      },
      { once: true },
    );
  }

  private wasBlockingWaitAborted(
    active: ActiveCompaction,
    signal: AbortSignal | undefined,
    error: unknown,
  ): boolean {
    return (
      signal?.aborted === true &&
      (active.abortController.signal.aborted || isAbortError(error))
    );
  }

  private async compactionOrchestrator(
    active: ActiveCompaction,
    data: Readonly<CompactionBeginData>,
  ): Promise<CompactionResult> {
    try {
      const signal = active.abortController.signal;
      signal.throwIfAborted();
      // Captured before PreCompact: messages a hook handler appends while
      // compacting must stay out of the summarizer's history (and a changed
      // prefix still cancels the round), exactly as when the hook ran inside
      // the round after the snapshot.
      const originalHistory = [...this.context.get()];
      // PreCompact runs exactly once, before the delegate/built-in branch.
      await this.hooks.onWillCompact.run(active);
      // One manager snapshot for the whole compaction: the built-in path's
      // remote and local requests share this exact instance, and the
      // delegate is invoked on the same resolved manager.
      const requestContext: LlmRequestContext = {
        manager: this.llmRequester.getActiveContextManager(),
        transform: 'apply',
      };
      const result = await this.runCompaction(active, data, requestContext, originalHistory, signal);
      // Common envelope, fixed order — settling task.promise stays with the
      // begin() .then chain, which runs after this function (including the
      // finally block below) completes.
      if (this._compacting !== active) throw compactionCancelledReason(active);
      this.profile.requestSystemPromptRefresh();
      this.lastCompactedTokenCount = result.tokensAfter;
      await this.contextInjector.injectAfterCompaction();
      this.lastCompactedTokenCount = this.tokenCountWithPending();
      if (!this.markCompleted(active)) {
        throw compactionCancelledReason(active);
      }
      const { contextSummary: _contextSummary, ...eventResult } = result;
      void _contextSummary;
      this.eventBus.publish({ type: 'compaction.completed', result: eventResult });
      return result;
    } catch (error) {
      if (active.abortController.signal.aborted || isAbortError(error)) {
        this.cancelActive(active);
        throw error;
      }
      const blockedByTurn = this._compacting === active && active.blockedByTurn;
      if (this._compacting === active) {
        this.cancelActive(active);
      }
      if (blockedByTurn) {
        throw error;
      }
      this.eventBus.publish({
        type: 'error',
        ...toKimiErrorPayload(error),
      });
      throw error;
    } finally {
      this._onDidFinishCompaction.fire(active);
    }
  }

  private async runCompaction(
    active: ActiveCompaction,
    data: Readonly<CompactionBeginData>,
    requestContext: LlmRequestContext,
    originalHistory: readonly ContextMessage[],
    signal: AbortSignal,
  ): Promise<CompactionResult> {
    const manager = requestContext.manager;
    if (manager?.onWillCompact !== undefined) {
      // The abort race keeps task.promise settling with an AbortError even
      // when a delegate ignores the signal; the manager's own promise keeps
      // running in the background and its late outcome is discarded.
      const delegation = await abortable(
        Promise.resolve(manager.onWillCompact({ task: active, input: data, signal })),
        signal,
      );
      if (delegation.handled) {
        // Delegate contract: the durable mutation (wire op) already landed
        // before this return — the result is only a receipt.
        return delegation.result;
      }
    }
    return this.compactionRound(active, data, requestContext, originalHistory);
  }

  /**
   * Remote-compaction attempt (B4-G). Returns the endpoint's checkpoint on
   * success; anything else falls back to the local summarizer with a
   * `compaction_remote_fallback` event — except models that never declared
   * the capability, which take the local path silently (a fallback event for
   * every compaction of such a model would be noise). Only the checkpoint is
   * taken from the result: which messages survive a fold is this engine's own
   * decision (`applyCompaction` derives it from the live history), so the
   * endpoint's `retainedMessages` echo is discarded unread. Aborts propagate
   * (never swallowed into a fallback); every other failure arrives as a typed
   * outcome, already past the provider's bounded retry, so the caller does not
   * retry either.
   *
   * The usage comes back so the caller can compare cache hit rates against the
   * summarizer's — it is returned to be READ, never recorded. `compact()`
   * already recorded it internally, and a second `usage.record` here would
   * double-count (v1 records at its call site because it has no such layer).
   */
  private async tryRemoteCompaction(
    active: ActiveCompaction,
    data: Readonly<CompactionBeginData>,
    shapedHistory: readonly ContextMessage[],
    requestContext: LlmRequestContext,
    signal: AbortSignal,
  ): Promise<
    { readonly checkpoint: CompactionCheckpoint; readonly usage: TokenUsage | null } | undefined
  > {
    if (this.profile.resolveModelContext().modelCapabilities.remote_compaction !== true) {
      return undefined;
    }
    const outcome = await this.llmRequester.compactInternal(
      requestContext,
      {
        history: shapedHistory,
        source: {
          type: 'operation',
          turnId: active.originTurnId,
          requestKind: 'remote_compaction',
        },
      },
      signal,
    );
    if (outcome.kind === 'ok') {
      return { checkpoint: outcome.result.checkpoint, usage: outcome.result.usage };
    }
    const properties: CompactionRemoteFallbackEvent = {
      turn_id: active.originTurnId,
      source: data.source,
      reason: outcome.kind === 'unsupported' ? 'unsupported' : 'request_failed',
    };
    if (outcome.kind === 'error') {
      properties.error_type = classifyApiError(unwrapErrorCause(outcome.error)).kind;
    }
    this.telemetry.track2('compaction_remote_fallback', properties);
    return undefined;
  }

  private async compactionRound(
    active: ActiveCompaction,
    data: Readonly<CompactionBeginData>,
    requestContext: LlmRequestContext,
    originalHistory: readonly ContextMessage[],
  ): Promise<CompactionResult> {
    const startedAt = Date.now();
    const tokensBefore = this.tokenCounting.estimateMessages(originalHistory);
    let retryCount = 0;
    let thinkingEffort = this.profile.data().thinkingLevel;

    try {
      const signal = active.abortController.signal;
      signal.throwIfAborted();

      const resolvedModel = this.profile.resolveModelContext();
      thinkingEffort = resolvedModel.thinkingLevel;
      const maxContextTokens = resolvedModel.modelCapabilities.max_context_tokens;
      const defaultCompactionCap =
        maxContextTokens > 0
          ? Math.min(maxContextTokens, DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS)
          : undefined;
      const compactionMaxOutputSize = resolvedModel.maxOutputSize ?? defaultCompactionCap;

      const customInstruction = data.instruction?.trim() ?? '';
      const instruction = renderPrompt(compactionInstructionTemplate, {
        custom_instruction_block:
          customInstruction.length > 0 ? `\nOptional user instruction:\n${customInstruction}\n` : '',
      }).trimEnd();

      const delays = retryBackoffDelays(MAX_COMPACTION_RETRY_ATTEMPTS);
      let attempt: CompactionAttemptResult | undefined;
      // Dynamic-tool protocol context (schema messages, loadable-tools
      // announcements) is shaped by `toolSelect.shapeHistory` alone, exactly as
      // it is for a turn request: stripped when tool-select is off, kept when it
      // is on. Shaping it here as well would make the summarizer prefix diverge
      // from the turn projection at the first protocol message and void the
      // provider prompt cache from there on — v1 measured a summarizer request
      // whose tools hash, system prompt hash, and message count matched the loop
      // request immediately before it reading 19968 of 112807 input tokens from
      // cache (17.7%, against that request's 99.3%), and 95.5% once the extra
      // shaping was dropped. `originalHistory` itself stays untouched for the
      // prefix-race check and `compactedCount`.
      let historyForModel: readonly ContextMessage[] = originalHistory;
      let droppedCount = 0;
      let overflowShrinkCount = 0;
      let emptyOrTruncatedShrinkCount = 0;
      // Remote compaction first when the model opted in (B4-G): the checkpoint
      // preserves model-native state the text summary cannot, but it is never
      // required — anything short of success falls through to the summarizer
      // below, which runs either way (its output is the only portable record
      // of the fold). The remote attempt sees the unshrunk history, and its
      // failure does not consume the loop's retry/shrink budget.
      //
      // Both paths reach the same turn-aligned shape, by different routes: the
      // summarizer goes through `llmRequester.startInternal()` → `runRequest`,
      // which shapes for it, while `compactInternal()` never touches
      // `runRequest` and so has to be handed a shaped history here. Tools
      // already agree — `compactInternal()` builds them with the same
      // `shapeTools` call the turn uses. Both requests share the
      // orchestrator's single `LlmRequestContext` snapshot.
      const remote = await this.tryRemoteCompaction(
        active,
        data,
        this.toolSelect.shapeHistory(originalHistory),
        requestContext,
        signal,
      );
      const checkpoint = remote?.checkpoint;
      while (true) {
        const messagesToCompact = historyForModel;
        const messages: Message[] = [...messagesToCompact, createUserMessage(instruction)];
        const estimatedCompactionRequestTokens = this.requestTokens(messages);

        try {
          const request = this.llmRequester.startInternal(
            requestContext,
            {
              messages,
              maxOutputSize: compactionMaxOutputSize,
              source: {
                type: 'operation',
                turnId: active.originTurnId,
                requestKind: 'full_compaction',
                logFields: { droppedCount },
              },
            },
            undefined,
            signal,
          );
          active.trace = request.trace;
          attempt = collectSummary(await request.result);
          break;
        } catch (error) {
          const isContextOverflow = this.shouldRecoverFromContextOverflow(
            error,
            estimatedCompactionRequestTokens,
          );
          if (isContextOverflow) {
            this.observeContextOverflow(estimatedCompactionRequestTokens);
            overflowShrinkCount += 1;
            if (
              overflowShrinkCount > MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS ||
              messagesToCompact.length <= 1
            ) {
              throw error;
            }
            const before = messagesToCompact.length;
            historyForModel = shrinkCompactionHistoryAfterOverflow(
              messagesToCompact,
              overflowShrinkCount,
              (message) => this.tokenCounting.estimateMessage(message),
            );
            droppedCount += before - historyForModel.length;
            retryCount = 0;
            continue;
          }
          if (
            (error instanceof CompactionTruncatedError || unwrapErrorCause(error) instanceof APIEmptyResponseError) &&
            messagesToCompact.length > 1
          ) {
            emptyOrTruncatedShrinkCount += 1;
            if (emptyOrTruncatedShrinkCount > MAX_COMPACTION_RETRY_ATTEMPTS) {
              throw error;
            }
            const reduced = dropOldestMessageAndOrphanToolResults(messagesToCompact);
            droppedCount += messagesToCompact.length - reduced.length;
            historyForModel = reduced;
            retryCount = 0;
            continue;
          }
          if (!isRetryableGenerateError(unwrapErrorCause(error))) {
            throw error;
          }
          if (retryCount + 1 >= MAX_COMPACTION_RETRY_ATTEMPTS) {
            throw error;
          }
          await sleepForRetry(delays[retryCount]!, signal);
          retryCount += 1;
        }
      }

      if (attempt === undefined) {
        throw new APIEmptyResponseError(
          'The compaction response did not contain a usable summary.',
        );
      }

      // Ahead of the prefix-race check on purpose: both requests really happened
      // and their cache numbers are real regardless of whether this fold lands,
      // and a cancelled round is exactly when a silent cliff would go unnoticed.
      // Read-only — `compact()` already recorded the remote usage.
      const cacheCliff = cacheCliffFields(remote?.usage ?? null, attempt.usage);
      if (cacheCliff !== undefined) {
        this.log.warn('remote compaction cache hit far below the local summarizer', cacheCliff);
      }

      if (!historySafeToCompact(this.context.get(), originalHistory)) {
        const active = this._compacting;
        if (active !== null) {
          this.cancelActive(active);
        }
        throw compactionCancelledReason(active);
      }

      const summary = this.postProcessSummary(attempt.summary);
      const result = this.context.applyCompaction({
        summary,
        contextSummary: buildCompactionSummaryText(summary),
        compactedCount: originalHistory.length,
        tokensBefore,
        summaryOutputTokens: attempt.usage?.output,
        droppedCount: droppedCount === 0 ? undefined : droppedCount,
        checkpoint,
      });

      const properties: CompactionFinishedEvent = {
        turn_id: active.originTurnId,
        source: data.source,
        implementation: checkpoint === undefined ? 'local' : 'remote',
        tokens_before: result.tokensBefore,
        tokens_after: result.tokensAfter,
        duration_ms: Date.now() - startedAt,
        compacted_count: result.compactedCount,
        dropped_count: result.droppedCount,
        retry_count: retryCount,
        round: 1,
        thinking_effort: thinkingEffort,
        trace_id: attempt.traceId,
        ...usageTelemetry(attempt.usage),
      };
      this.telemetry.track2('compaction_finished', properties);
      return result;
    } catch (error) {
      if (isAbortError(error)) throw error;
      const properties: CompactionFailedEvent = {
        turn_id: active.originTurnId,
        source: data.source,
        tokens_before: tokensBefore,
        duration_ms: Date.now() - startedAt,
        round: 1,
        retry_count: retryCount,
        thinking_effort: thinkingEffort,
        error_type: error instanceof Error ? error.name : 'Unknown',
        trace_id: findAPIStatusError(error)?.traceId ?? active.traceId,
      };
      this.telemetry.track2('compaction_failed', properties);
      if (
        isError2(error) &&
        (error.code === ErrorCodes.AUTH_LOGIN_REQUIRED ||
          error.code === ErrorCodes.PROVIDER_AUTH_ERROR)
      ) {
        throw error;
      }
      throw new Error2(ErrorCodes.COMPACTION_FAILED, String(error), { cause: error });
    }
  }

  private postProcessSummary(summary: string): string {
    const todos = this.currentTodos();
    if (todos.length === 0) {
      return summary;
    }
    return `${summary.trim()}\n\n${renderTodoList(todos, '## TODO List')}`;
  }

  private currentTodos(): readonly TodoItem[] {
    return this.todo.getTodos();
  }

  private tokenCountWithPending(): number {
    return this.tokenCounting.get().size;
  }

  private get contextInjector(): IAgentContextInjectorService {
    if (this.contextInjectorService === undefined) {
      this.contextInjectorService = this.instantiation.invokeFunction((accessor) =>
        accessor.get(IAgentContextInjectorService),
      );
    }
    return this.contextInjectorService;
  }
}

function findAPIStatusError(error: unknown): APIStatusError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current instanceof APIStatusError) return current;
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function collectSummary(finish: AgentLLMRequestFinish): CompactionAttemptResult {
  if (finish.providerFinishReason === 'truncated') {
    throw new CompactionTruncatedError();
  }

  const summary = finish.message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
  if (summary.length === 0) {
    throw new APIEmptyResponseError(
      'The compaction response did not contain a non-empty summary.',
    );
  }

  return { summary, usage: finish.usage, traceId: finish.traceId };
}

function historySafeToCompact(
  current: readonly ContextMessage[],
  original: readonly ContextMessage[],
): boolean {
  if (current.length < original.length) return false;
  if (!original.every((message, index) => message === current[index])) return false;
  return current.slice(original.length).every(isRealUserInput);
}

function shrinkCompactionHistoryAfterOverflow<T extends Message>(
  messages: readonly T[],
  attempt: number,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): T[] {
  if (messages.length <= 1) return messages.slice();
  const ratio = COMPACTION_OVERFLOW_SHRINK_RATIOS[
    Math.min(attempt - 1, COMPACTION_OVERFLOW_SHRINK_RATIOS.length - 1)
  ]!;
  let totalTokens = 0;
  for (const message of messages) totalTokens += estimateMessage(message);
  const tokenBudget = Math.floor(totalTokens * ratio);
  return takeRecentMessagesWithinTokenBudget(messages, tokenBudget, estimateMessage);
}

function takeRecentMessagesWithinTokenBudget<T extends Message>(
  messages: readonly T[],
  tokenBudget: number,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): T[] {
  let start = messages.length;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = estimateMessage(messages[i]!);
    if (tokens + messageTokens > tokenBudget) break;
    tokens += messageTokens;
    start = i;
  }
  if (start === 0) start = 1;
  return dropOrphanToolResults(messages.slice(start));
}

function dropOldestMessageAndOrphanToolResults<T extends Message>(messages: readonly T[]): T[] {
  if (messages.length <= 1) return messages.slice();
  return dropOrphanToolResults(messages.slice(1));
}

/**
 * Drop tool results whose owning assistant call did not survive the cut.
 *
 * A leading run of `role: 'tool'` is the common shape but not the only one.
 * With tool-select on, `toolSelect.load()` appends the dynamic tool schema
 * WHILE the tool is still executing, so the stored order is
 * `assistant(call) → system(schema) → tool(result)`. A cut landing on the call
 * leaves the schema in front of the result: the result is orphaned, yet not
 * leading, and a position-based scan walks straight past it.
 *
 * Ownership is therefore decided by the tool-call ids still present in the
 * slice, not by where a message sits. Protocol messages are left alone — they
 * are what keeps the summarizer prefix aligned with the turn projection.
 */
export function dropOrphanToolResults<T extends Message>(messages: readonly T[]): T[] {
  const ownedIds = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls) ownedIds.add(call.id);
  }
  return messages.filter(
    (message) =>
      message.role !== 'tool' ||
      (message.toolCallId !== undefined && ownedIds.has(message.toolCallId)),
  );
}

/** Share of a request's input tokens served from the provider's prompt cache. */
function cacheHitRatio(usage: TokenUsage): number {
  return usage.inputCacheRead / Math.max(1, inputTotal(usage));
}

/**
 * The cache-cliff signature: the remote fold reads far less of the prompt cache
 * than the local summarizer running on the same history moments later (v1
 * measured 0% against 98% on real folds). Returns the log fields when the gap is
 * worth reporting, so the miss cannot hide inside aggregate token stats.
 *
 * This is the only thing watching for a compaction prefix that has drifted out
 * of line with the turn projection: such a drift turns no test red and breaks no
 * behaviour — it just makes the bill quietly larger.
 *
 * Needs both numbers to say anything, so a missing usage on either side is not a
 * finding.
 */
export function cacheCliffFields(
  remote: TokenUsage | null,
  summarizer: TokenUsage | null,
): LogContext | undefined {
  if (remote === null || summarizer === null) return undefined;
  if (cacheHitRatio(summarizer) - cacheHitRatio(remote) <= CACHE_HIT_GAP_WARN_THRESHOLD) {
    return undefined;
  }
  return {
    remoteCacheRead: remote.inputCacheRead,
    remoteInput: inputTotal(remote),
    summarizerCacheRead: summarizer.inputCacheRead,
    summarizerInput: inputTotal(summarizer),
  };
}

function usageTelemetry(usage: TokenUsage | null): CompactionTelemetryProperties {
  if (usage === null) return {};
  return {
    input_tokens: inputTotal(usage),
    output_tokens: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}

function compactionCancelledReason(active: ActiveCompaction | null): Error {
  const reason = active?.abortController.signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Compaction cancelled.');
  error.name = 'AbortError';
  return error;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentFullCompactionService,
  AgentFullCompactionService,
  ScopeActivation.OnScopeCreated,
  'fullCompaction',
);
