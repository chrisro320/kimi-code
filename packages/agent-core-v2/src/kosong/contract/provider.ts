/**
 * `kosong/contract` domain — the ChatProvider wire contract.
 *
 * ⚠ Named `provider` but this is the L0 contract, not an implementation:
 * the slimmed `ChatProvider` interface plus everything a single generation
 * call needs. Two invariants hold here:
 *
 *  - A ChatProvider is immutable after construction. The interface has no
 *    `with*` methods; every per-turn intent (prompt-cache key, sampling
 *    overrides, thinking effort/keep, completion-token budget) flows through
 *    `GenerateOptions` on each `generate` call instead of through morphs.
 *  - `GenerateOptions` is the per-turn intent carrier. Each wire dialect
 *    decides how — or whether — to encode an intent (e.g. a cache key may
 *    become `prompt_cache_key`, `metadata.user_id`, or be silently dropped).
 *
 * Pure types only — no other domain, no I/O, no SDKs.
 */

import type { CompactionCheckpoint, CompactionLineage, ModelHistoryItem } from './compaction';
import type { Message, StreamedMessagePart, VideoURLPart } from './message';
import type { Tool } from './tool';
import type { TokenUsage } from './usage';

export type ThinkingEffort = 'off' | 'on' | (string & {});

export type JsonSchemaObject = Record<string, unknown>;

export interface JsonObjectResponseFormat {
  readonly type: 'json_object';
}

export interface JsonSchemaResponseFormat {
  readonly type: 'json_schema';
  readonly jsonSchema: {
    readonly name: string;
    readonly schema: JsonSchemaObject;
    readonly strict?: boolean;
    readonly description?: string;
  };
}

export type ResponseFormat = JsonObjectResponseFormat | JsonSchemaResponseFormat;

export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other';

export interface StreamedMessage {
  [Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart>;
  readonly id: string | null;
  readonly usage: TokenUsage | null;
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;
  readonly traceId?: string | null;
  /**
   * Wire `type` values of output items the provider decoder recognized as
   * output items but could not turn into any {@link StreamedMessagePart}.
   *
   * The provider protocols are extensible, so an item type added upstream
   * decodes to nothing here and the response looks like the model produced
   * less than it did — or nothing at all. Recording the names keeps that
   * loss reportable instead of silent. Empty (or absent) when every output
   * item was consumed.
   */
  readonly droppedOutputItemTypes?: readonly string[];
}

export interface ProviderRequestAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface SamplingOptions {
  readonly temperature?: number;
  readonly topP?: number;
}

export interface ThinkingRequestOptions {
  readonly effort: ThinkingEffort;
  readonly keep?: string;
}

export interface ToolCallIdPolicy {
  normalize: (id: string) => string;
  maxLength?: number;
}

export interface StreamDecodeStats {
  readonly serverDecodeMs: number;
  readonly clientConsumeMs: number;
}

export interface VideoUploadInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string | undefined;
}

export interface GenerateOptions {
  signal?: AbortSignal;
  auth?: ProviderRequestAuth;
  responseFormat?: ResponseFormat;
  cacheKey?: string;
  sampling?: SamplingOptions;
  thinking?: ThinkingRequestOptions;
  maxCompletionTokens?: number;
  usedContextTokens?: number;
  maxContextTokens?: number;
  onRequestStart?: () => void;
  onRequestSent?: () => void;
  onStreamEnd?: (stats?: StreamDecodeStats) => void;
  onTraceId?: (traceId: string | null) => void;
}

export interface ChatProvider {
  readonly name: string;
  readonly modelName: string;
  readonly thinkingEffort: ThinkingEffort | null;
  readonly maxCompletionTokens?: number;
  generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage>;
  uploadVideo?(input: string | VideoUploadInput, options?: GenerateOptions): Promise<VideoURLPart>;
  /**
   * OPTIONAL remote-compaction endpoint. Providers without a compaction
   * endpoint simply do not implement it — the `ModelRequester` boundary
   * answers `{ kind: 'unsupported' }` for them, so behavior is unchanged.
   */
  compactConversation?(
    input: ChatProviderCompactionInput,
    options?: GenerateOptions,
  ): Promise<ChatProviderCompactionResult>;
  /**
   * OPTIONAL lineage of checkpoints this provider instance produces and
   * accepts for replay, built via `canonicalizeLineage()` with the ALREADY
   * RESOLVED base URL (the provider's default when the config sets none).
   * Present exactly when `compactConversation` is.
   */
  compactionLineage?(): CompactionLineage;
}

/** Input of a remote-compaction request at the provider boundary. */
export interface ChatProviderCompactionInput {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  /** Checkpoint-aware projected history (see `projectModelHistory`). */
  readonly history: readonly ModelHistoryItem[];
  /**
   * Messages the caller keeps verbatim regardless of the endpoint's own
   * retention decision — the provider may use them to bound what must
   * survive compaction.
   */
  readonly retainedMessages: readonly Message[];
}

/** Result of a successful remote compaction. */
export interface ChatProviderCompactionResult {
  readonly checkpoint: CompactionCheckpoint;
  readonly retainedMessages: readonly Message[];
  readonly usage: TokenUsage | null;
  /** Allowlisted wire types of output items dropped as unknown-nonessential. */
  readonly unknownOutputItemTypes?: readonly string[];
  readonly traceId?: string | null;
}
