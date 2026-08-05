/**
 * `kosong/model` domain — the `ModelRequester` contract: per-turn input,
 * streamed events, and the per-turn intent carrier `ModelRequestParams`.
 *
 * `ModelRequestParams` is how every per-turn intent reaches the wire: prompt-cache
 * key, sampling overrides, thinking effort/keep, and the completion-token
 * budget (with its window-clamp companions). It is deliberately dialect-free —
 * each wire dialect encodes (or silently drops) an intent in its own hooks.
 * The requester maps the params onto `GenerateOptions` 1:1; the fixed overlay
 * order inside the bases is `cacheKey → sampling → thinking →
 * maxCompletionTokens`.
 */

import type { Message, StreamedMessagePart, VideoURLPart } from '#/kosong/contract/message';
import type {
  CompactionCheckpoint,
  CompactionLineage,
  ModelHistoryItem,
} from '#/kosong/contract/compaction';
import type {
  FinishReason,
  ResponseFormat,
  SamplingOptions,
  ThinkingEffort,
  VideoUploadInput,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';

import type { Model } from './catalog';

export interface ModelRequestInput {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly responseFormat?: ResponseFormat;
}

export interface ModelRequestTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
  readonly requestBuildMs?: number;
  readonly serverFirstTokenMs?: number;
  readonly serverDecodeMs?: number;
  readonly clientConsumeMs?: number;
}

export type ModelRequestEvent =
  | { readonly type: 'part'; readonly part: StreamedMessagePart }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly model?: string }
  | {
      readonly type: 'finish';
      readonly message: Message;
      readonly providerFinishReason?: FinishReason;
      readonly rawFinishReason?: string;
      readonly id?: string;
      readonly traceId?: string;
    }
  | ({ readonly type: 'timing' } & ModelRequestTiming);

export interface ModelRequestParams {
  readonly cacheKey?: string;
  readonly sampling?: SamplingOptions;
  readonly thinkingEffort?: ThinkingEffort;
  readonly thinkingKeep?: string;
  readonly maxCompletionTokens?: number;
  readonly usedContextTokens?: number;
  readonly maxContextTokens?: number;
  readonly onTraceId?: (traceId: string | null) => void;
}

export interface ModelRequester {
  readonly model: Model;

  request(
    input: ModelRequestInput,
    signal?: AbortSignal,
    params?: ModelRequestParams,
  ): AsyncIterable<ModelRequestEvent>;

  uploadVideo?(
    input: string | VideoUploadInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<VideoURLPart>;

  /**
   * REQUIRED remote-compaction boundary. When the underlying provider does
   * not implement `ChatProvider.compactConversation`, this resolves to
   * `{ kind: 'unsupported' }` — typed, never an exception — so the caller's
   * capability gate stays the only gate it has to reason about.
   *
   * Abort signals propagate as abort errors (thrown, never wrapped in an
   * outcome); every other failure is provider-error-translated and returned
   * as `{ kind: 'error' }`.
   */
  compactConversation(
    input: ModelCompactionInput,
    signal?: AbortSignal,
    params?: ModelCompactionParams,
  ): Promise<ModelCompactionOutcome>;

  /**
   * Lineage of checkpoints the underlying provider produces and accepts for
   * replay — `undefined` when the provider has no compaction endpoint.
   */
  compactionLineage(): CompactionLineage | undefined;
}

/**
 * Remote-compaction input at the kosong boundary. NOT a `ModelRequestInput`
 * reuse: `history` is checkpoint-aware (`ModelHistoryItem[]`), which the
 * plain `messages: Message[]` shape cannot carry.
 */
export interface ModelCompactionInput {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly history: readonly ModelHistoryItem[];
  /** Messages the caller keeps verbatim regardless of endpoint retention. */
  readonly retainedMessages: readonly Message[];
}

/** Per-request intent for a compaction call — the same carrier idea as {@link ModelRequestParams}. */
export interface ModelCompactionParams {
  readonly cacheKey?: string;
  readonly sampling?: SamplingOptions;
  readonly thinkingEffort?: ThinkingEffort;
  readonly thinkingKeep?: string;
  readonly maxCompletionTokens?: number;
  readonly usedContextTokens?: number;
  readonly maxContextTokens?: number;
  readonly onTraceId?: (traceId: string | null) => void;
}

export interface ModelCompactionResult {
  readonly checkpoint: CompactionCheckpoint;
  readonly retainedMessages: readonly Message[];
  readonly usage: TokenUsage | null;
  /** Allowlisted wire types of output items dropped as unknown-nonessential. */
  readonly unknownOutputItemTypes?: readonly string[];
  readonly traceId?: string | null;
}

/**
 * Typed outcome of a compaction request: the provider-method gate produces
 * `unsupported`, aborts throw, and every other failure lands in `error`
 * (provider-error-translated).
 */
export type ModelCompactionOutcome =
  | { readonly kind: 'ok'; readonly result: ModelCompactionResult }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'error'; readonly error: unknown };

export function effectiveMaxCompletionTokens(params?: ModelRequestParams): number | undefined {
  return params?.maxCompletionTokens;
}
