import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { FinishReason, ThinkingEffort } from '#/kosong/contract/provider';
import type { Message, StreamedMessagePart } from '#/kosong/contract/message';
import type { FullCompactionInput, FullCompactionTask } from '#/agent/fullCompaction/fullCompaction';
import type { CompactionResult } from '#/agent/fullCompaction/types';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import type {
  ModelCompactionOutcome,
  ModelRequestTiming,
} from '#/kosong/model/modelRequester';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { LogContext } from '#/_base/log/log';

export type AgentLLMRequestLogFields = Readonly<LogContext>;

export type AgentLLMRequestSource =
  | {
      readonly type: 'turn';
      readonly turnId: number;
      readonly step?: number;
      readonly logFields?: AgentLLMRequestLogFields;
    }
  | {
      readonly type: 'operation';
      readonly turnId?: number;
      readonly requestKind?: string;
      readonly logFields?: AgentLLMRequestLogFields;
    };

export interface AgentLLMRequestFinish {
  message: Message;
  usage: TokenUsage;
  model?: string | undefined;
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  providerMessageId?: string;
  timing?: ModelRequestTiming;
  traceId?: string;
}

export type AgentLLMRequestPartHandler = (part: StreamedMessagePart) => void | Promise<void>;

export interface AgentLLMRequestOverrides {
  messages?: readonly Message[];
  tools?: readonly Tool[];
  systemPrompt?: string;
  source?: AgentLLMRequestSource;
  maxOutputSize?: number;
}

export interface AgentLLMRequestTask {
  readonly trace: LLMRequestTrace;
  readonly result: Promise<AgentLLMRequestFinish>;
}

/** Per-call accounting declaration of a context-manager transform. */
export type TransformAccounting = 'raw-equivalent' | 'transformed';

export interface TransformResult {
  readonly messages: readonly Message[];
  /**
   * `raw-equivalent` = the output is message-for-message equivalent to the
   * input, so the engine may still write the raw-context usage anchor;
   * `transformed` = anything else, and the anchor is skipped for this call.
   * Reported per call by the manager — never inferred from its identity.
   */
  readonly accounting: TransformAccounting;
}

/**
 * Compaction takeover decision returned by `ContextManager.onWillCompact`.
 * `handled: true` means the durable mutation (wire op) already completed
 * before the return — `result` is only a receipt.
 */
export type CompactDelegation =
  | { readonly handled: false }
  | { readonly handled: true; readonly result: CompactionResult };

/**
 * Opt-in request-time context manager. Registered per agent through
 * `IAgentLLMRequesterService.registerContextManager` and activated by the
 * engine-internal `contextManager` config section (value = manager `id`).
 * Absent or not configured = zero-cost passthrough.
 */
export interface ContextManager {
  readonly id: string;
  readonly version: string;

  transformMessages(input: {
    readonly messages: readonly Message[];
    readonly source?: AgentLLMRequestSource;
    readonly usedContextTokens: number;
    readonly maxContextTokens: number;
    readonly signal: AbortSignal;
  }): Promise<TransformResult> | TransformResult;

  onWillCompact?(input: {
    readonly task: FullCompactionTask;
    readonly input: FullCompactionInput;
    readonly signal: AbortSignal;
  }): Promise<CompactDelegation> | CompactDelegation;
}

/**
 * Internal per-request context carrying the active-manager snapshot and the
 * transform mode. Both fields are readonly: one instance is shared by the
 * remote/local paths of a single operation and must never be mutated.
 * `transform: 'bypass'` marks ACP-owned requests that skip the transform.
 */
export interface LlmRequestContext {
  readonly manager: ContextManager | undefined;
  readonly transform: 'apply' | 'bypass';
}

export interface PreparedTurnRequestConfig {
  readonly thinkingEffort: ThinkingEffort;
}

/** Input of an agent-layer remote-compaction request (B4-G calls this). */
export interface AgentCompactionInput {
  /** Stored history to compact; defaults to the live context. */
  readonly history?: readonly ContextMessage[];
  /** Messages the caller keeps verbatim regardless of endpoint retention. */
  readonly retainedMessages?: readonly Message[];
  /** Defaults to the profile system prompt. */
  readonly systemPrompt?: string;
  readonly source?: AgentLLMRequestSource;
}

export interface IAgentLLMRequesterService {
  readonly _serviceBrand: undefined;

  prepareTurnConfig(turnId: number): PreparedTurnRequestConfig | undefined;

  request(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): Promise<AgentLLMRequestFinish>;

  start(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): AgentLLMRequestTask;

  /**
   * Remote-compaction entry point. Resolves the profile (model, thinking,
   * cache key, budget), projects the history into checkpoint-aware
   * `ModelHistoryItem[]` against the provider's capability and lineage,
   * records usage, and drives `ModelRequester.compactConversation()`.
   *
   * The typed outcome is returned as-is: `unsupported` (provider has no
   * endpoint) and `error` (translated provider failure) are for the caller's
   * fallback; aborts throw.
   */
  compact(
    input?: AgentCompactionInput,
    signal?: AbortSignal,
  ): Promise<ModelCompactionOutcome>;

  /**
   * Registers the agent's context manager. Single registration; a second
   * call while one is registered throws. Disposing the returned handle
   * restores the unregistered state.
   */
  registerContextManager(manager: ContextManager): IDisposable;

  /**
   * The registered manager when the `contextManager` config section names
   * its `id`; `undefined` otherwise (not registered, not configured, or a
   * mismatch — the mismatch warns once on first resolution).
   */
  getActiveContextManager(): ContextManager | undefined;

  /** `start` against an explicit request context (engine-internal). */
  startInternal(
    context: LlmRequestContext,
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): AgentLLMRequestTask;

  /** `compact` against an explicit request context (engine-internal). */
  compactInternal(
    context: LlmRequestContext,
    input?: AgentCompactionInput,
    signal?: AbortSignal,
  ): Promise<ModelCompactionOutcome>;
}

export const IAgentLLMRequesterService = createDecorator<IAgentLLMRequesterService>(
  'agentLLMRequesterService',
);
