/**
 * `kosong/contract` — compaction checkpoint carrier contract.
 *
 * A remote-compaction checkpoint is opaque provider state that a later
 * request replays verbatim in place of the readable compaction summary. This
 * file pins the ONLY shape it may take as it crosses persistence, projection,
 * and token accounting — provider endpoints (how a checkpoint is produced),
 * capability resolution, and caller-side degradation live downstream.
 *
 * Mounting rule: a checkpoint rides on `CompactionSummaryOrigin`
 * (`agent/contextMemory/types.ts`), i.e. the `origin` sidecar of the summary
 * `ContextMessage` — never inside `Message.content`. It therefore does not
 * appear in the CONTENT of `ContentPart` / `StreamedMessagePart` / prompt /
 * steer / tool result payloads: those are different unions with no field that
 * can carry it. Note this is NOT a type-system guarantee — TypeScript's
 * structural typing makes `const m: Message = someContextMessage` legal, and
 * `origin` is simply invisible to `Message` consumers. The runtime guarantee
 * is the projection layer (`projectModelHistory`), pinned by its sentinel
 * test, not the type checker.
 */

/** Who wrote the checkpoint. Ownership is decided by exact-field comparison. */
export interface CompactionLineage {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
}

/**
 * Input tokens this checkpoint occupies when REPLAYED into a later request —
 * not the usage of the compaction pass that produced it. `/responses/compact`
 * today reports only request-level `input_tokens` / `output_tokens`, none of
 * which is the item-level replay cost, so `unknown` is the honest state until
 * a provider reports the measured figure. No `upper-bound` state: nothing can
 * produce one today, and `max_input_tokens` as a stand-in would read as
 * "nearly full" right after every compaction, re-triggering it in a loop.
 */
export type ReplayInputTokenEstimate =
  | { readonly kind: 'measured'; readonly tokens: number }
  | { readonly kind: 'unknown' };

export interface CompactionCheckpoint {
  /** Opaque provider state. Replayed verbatim; never rendered, never parsed. */
  readonly encrypted: string;
  /** Native output item type, echoed back on replay. */
  readonly itemType: string;
  readonly itemId?: string;
  readonly lineage: CompactionLineage;
  /** Input tokens this checkpoint occupies when replayed. See the type docs. */
  readonly replayInputTokens: ReplayInputTokenEstimate;
}

/**
 * Single authority for lineage identity — callers must NOT hand-assemble
 * lineage objects for comparison.
 *
 * `effectiveBaseUrl` is the ALREADY-RESOLVED base URL (non-optional): the
 * contract layer cannot know each provider's default URL — that lives on the
 * provider instance. Resolving defaults is the caller's job. The ONLY
 * normalization performed here is stripping trailing slashes, a pure spelling
 * difference. `/v1` prefixes and host casing are deliberately NOT normalized:
 * lineage is written and read back by the same provider instance, and if the
 * user edits their config in between, letting the checkpoint miss (and fall
 * back to the portable summary) is the safe outcome — guessing that two URLs
 * name the same API is not ours to make.
 */
export function canonicalizeLineage(input: {
  readonly provider: string;
  readonly model: string;
  readonly effectiveBaseUrl: string;
}): CompactionLineage {
  return {
    provider: input.provider,
    model: input.model,
    baseUrl: input.effectiveBaseUrl.replace(/\/+$/, ''),
  };
}

/** Exact three-field ownership comparison (trailing-slash-tolerant baseUrl). */
export function sameOrigin(a: CompactionLineage, b: CompactionLineage): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.baseUrl.replace(/\/+$/, '') === b.baseUrl.replace(/\/+$/, '')
  );
}

export interface ReplayContribution {
  readonly tokens: number;
  /** Present when the estimate is `unknown`: the caller MUST surface this
   *  diagnostic rather than silently booking zero. */
  readonly diagnostic?: string;
}

/**
 * The checkpoint's contribution to post-compaction token accounting. An owned
 * checkpoint REPLACES the summary text in the model-facing context, so this
 * value is consumed instead of the summary estimate — never added to it.
 * `measured` books its figure; `unknown` books zero AND returns a diagnostic.
 */
export function replayContribution(checkpoint: CompactionCheckpoint): ReplayContribution {
  if (checkpoint.replayInputTokens.kind === 'measured') {
    return { tokens: checkpoint.replayInputTokens.tokens };
  }
  return {
    tokens: 0,
    diagnostic:
      'compaction checkpoint replay cost is unknown; booking 0 input tokens for it ' +
      '(the checkpoint replaces the summary text in the model-facing context, so the ' +
      'post-compaction token count is an underestimate until the provider reports ' +
      'item-level replay usage)',
  };
}
