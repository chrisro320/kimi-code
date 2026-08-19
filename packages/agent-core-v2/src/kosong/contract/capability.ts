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
   * Reproduce the upstream `minimal` preset's regime: the system prompt is one
   * sentence, no workspace instructions, runtime context, skill listing, or
   * plugin sections reach it, no context injection ever fires, and a two-tool
   * catalogue serves the whole session. Declaration-only for the same reason as
   * `remote_compaction` — no protocol-level probe can tell, and the evidence
   * for it is per-model. Strips the agent down far enough that it cannot use
   * skills, cron, or MCP — a measurement instrument for the model's native
   * reasoning register, not a working configuration.
   */
  readonly minimal_mode?: boolean;
  /**
   * Tools a minimal session composes, overriding the built-in pair. Absent
   * means the built-in pair; an empty list means the requests carry no tools at
   * all — a model told to act but handed nothing will emit tool-call syntax as
   * plain text, so treat the empty list as a measurement instrument, not a
   * working configuration. Only read while `minimal_mode` is declared.
   */
  readonly minimal_mode_tools?: readonly string[];
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
      minimal_mode: false,
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
    capability.minimal_mode !== true &&
    capability.max_context_tokens === 0
  );
}
