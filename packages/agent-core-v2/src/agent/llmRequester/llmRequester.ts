import { createDecorator } from '#/_base/di/instantiation';
import type { FinishReason, ThinkingEffort } from '#/kosong/contract/provider';
import type { Message, StreamedMessagePart } from '#/kosong/contract/message';
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
}

export const IAgentLLMRequesterService = createDecorator<IAgentLLMRequesterService>(
  'agentLLMRequesterService',
);
