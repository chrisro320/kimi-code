/**
 * `kosong/contract` domain — declared model capabilities.
 *
 * `ModelCapability` describes the modalities and limits of a specific model
 * so callers can gate requests against what the model accepts without
 * dispatching the request and watching it fail upstream.
 *
 * `UNKNOWN_CAPABILITY` is the marker value returned when nothing is known
 * about a model: `max_context_tokens: 0` means "unknown"; callers that do
 * not gate on context length can ignore the field.
 */

export interface ModelCapability {
  readonly image_in: boolean;
  readonly video_in: boolean;
  readonly audio_in: boolean;
  readonly thinking: boolean;
  readonly tool_use: boolean;
  readonly max_context_tokens: number;
  readonly max_input_tokens?: number;
  readonly dynamically_loaded_tools?: boolean;
  /**
   * The model's endpoint can compact a conversation server-side and hand back
   * an opaque checkpoint to replay later. Opt-in by explicit declaration only
   * — no protocol-level probe can tell whether a backend serves the compaction
   * endpoint, so a wrong guess costs a failed request every compaction.
   */
  readonly remote_compaction?: boolean;
  /**
   * The model's first reasoning trajectory is sensitive to how large a tool
   * catalogue its request carries, so a session's first request is worth
   * anchoring to a minimal catalogue and opening the full one once the session
   * has produced an assistant message. Opt-in by explicit declaration only,
   * for the same reason as `remote_compaction` — no protocol-level probe can
   * tell, and the evidence for it is per-model.
   */
  readonly anchored_bootstrap?: boolean;
  /**
   * Tools the anchored first request may carry, overriding the built-in
   * bootstrap set. Absent means the built-in set; an empty list means the
   * first request carries no tools at all — a model told to act but handed
   * nothing will emit tool-call syntax as plain text, so treat the empty list
   * as a measurement instrument, not a working configuration. Only read while
   * `anchored_bootstrap` is declared.
   */
  readonly anchored_bootstrap_tools?: readonly string[];
}

const UNKNOWN_CAPABILITY_MARKER = Symbol.for('moonshot-ai.kosong.UNKNOWN_CAPABILITY');

export const UNKNOWN_CAPABILITY: ModelCapability = Object.freeze(
  Object.defineProperty(
    {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: false,
      max_context_tokens: 0,
      dynamically_loaded_tools: false,
      remote_compaction: false,
      anchored_bootstrap: false,
    },
    UNKNOWN_CAPABILITY_MARKER,
    { value: true },
  ),
);

export function isUnknownCapability(capability: ModelCapability): boolean {
  if (capability === UNKNOWN_CAPABILITY) return true;
  const marked =
    (capability as unknown as Record<PropertyKey, unknown>)[UNKNOWN_CAPABILITY_MARKER] === true;
  if (marked) return true;
  return (
    !capability.image_in &&
    !capability.video_in &&
    !capability.audio_in &&
    !capability.thinking &&
    !capability.tool_use &&
    capability.dynamically_loaded_tools !== true &&
    capability.remote_compaction !== true &&
    capability.anchored_bootstrap !== true &&
    capability.max_context_tokens === 0
  );
}
