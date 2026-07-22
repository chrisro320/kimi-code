import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import type { ContextMessage } from '../context';
import { estimateTokensForContentParts, estimateTokensForMessages } from '../../utils/tokens';

/**
 * Outbound-only tool-result compaction policy.
 *
 * The class and option name remain `MicroCompaction` so existing Agent wiring
 * and old wire records stay compatible. It intentionally does not restore the
 * removed cache-age/cutoff behaviour: selection is recomputed from each full
 * canonical history by message occurrence, never by an absolute message index.
 */
export interface MicroCompactionConfig {
  keepRecentMessages: number;
  minContentTokens: number;
  /** Legacy option kept for host compatibility; no longer used as a trigger. */
  cacheMissedThresholdMs: number;
  truncatedMarker: string;
  minContextUsageRatio: number;
}

const DEFAULT_CONFIG: MicroCompactionConfig = {
  keepRecentMessages: 20,
  minContentTokens: 100,
  cacheMissedThresholdMs: 60 * 60 * 1000,
  truncatedMarker: '[Old successful tool result omitted from model context; re-run the tool if its full output is needed.]',
  minContextUsageRatio: 0.5,
};

export class MicroCompaction {
  readonly config: MicroCompactionConfig;
  private lastSelectionSignature: string | undefined;

  constructor(
    public readonly agent: Agent,
    config?: Partial<MicroCompactionConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Legacy `micro_compaction.apply` replay records are intentionally no-ops. */
  apply(_cutoff: number): void {}

  /** A compaction/clear changed canonical history; allow the next selection to be measured. */
  reset(_maxCutoff?: number): void {
    this.lastSelectionSignature = undefined;
  }

  /**
   * Kept at the pre-step hook boundary for compatibility. Selection happens in
   * compact(), where the actual outbound history is available.
   */
  detect(): void {}

  compact(
    messages: readonly ContextMessage[],
    canonicalHistory: readonly ContextMessage[] = messages,
  ): readonly ContextMessage[] {
    if (!this.agent.experimentalFlags.enabled('tool-result-compaction')) return messages;

    const maxContextTokens = this.agent.config.modelCapabilities.max_context_tokens;
    if (maxContextTokens <= 0) return messages;
    // Provider usage can describe a previously compacted projection. Canonical
    // history remains raw, so never let that smaller number turn compaction off.
    const estimatedCanonicalTokens = estimateTokensForMessages(canonicalHistory);
    const contextTokens = Math.max(this.agent.context.tokenCountWithPending, estimatedCanonicalTokens);
    const contextUsageRatio = contextTokens / maxContextTokens;
    if (contextUsageRatio < this.config.minContextUsageRatio) return messages;

    const candidates = this.candidates(canonicalHistory);
    if (candidates.length === 0) return messages;

    const selected = new Set(candidates.map((candidate) => candidate.message));
    const targets = messages.filter((message) => selected.has(message));
    if (targets.length === 0) return messages;

    const candidateByMessage = new Map(candidates.map((candidate) => [candidate.message, candidate]));
    const signature = targets
      .map((target) => {
        const candidate = candidateByMessage.get(target);
        if (candidate === undefined) throw new Error('Selected tool-result candidate is missing');
        return `${String(candidate.index)}:${candidate.toolCallId}`;
      })
      .toSorted()
      .join('\0');
    if (signature !== this.lastSelectionSignature) {
      const markerTokens = estimateTokensForContentParts([this.markerPart()]);
      const before = targets.reduce(
        (total, target) => total + estimateTokensForContentParts(target.content),
        0,
      );
      this.agent.telemetry.track('tool_result_compaction_finished', {
        keep_recent_messages: this.config.keepRecentMessages,
        min_content_tokens: this.config.minContentTokens,
        min_context_usage_ratio: this.config.minContextUsageRatio,
        context_usage_ratio: contextUsageRatio,
        truncated_tool_result_count: targets.length,
        truncated_tool_result_tokens_before: before,
        truncated_tool_result_tokens_after: markerTokens * targets.length,
      });
      this.lastSelectionSignature = signature;
    }

    const compacted = messages.map((message) => {
      if (!selected.has(message)) return message;
      // Keep all tool-exchange and ContextMessage metadata intact. The projector
      // still renders note/isError and repairs pairing from the same call id.
      return { ...message, content: [this.markerPart()] };
    });
    return compacted;
  }

  private candidates(messages: readonly ContextMessage[]): Array<{
    index: number;
    message: ContextMessage;
    toolCallId: string;
  }> {
    const recentStart = Math.max(0, messages.length - this.config.keepRecentMessages);
    const candidates: Array<{ index: number; message: ContextMessage; toolCallId: string }> = [];
    for (let index = 0; index < recentStart; index++) {
      const message = messages[index];
      if (
        message?.role !== 'tool' ||
        message.toolCallId === undefined ||
        message.isError === true
      ) {
        continue;
      }
      const contentTokens = estimateTokensForContentParts(message.content);
      if (contentTokens >= this.config.minContentTokens) {
        candidates.push({ index, message, toolCallId: message.toolCallId });
      }
    }
    return candidates;
  }

  private markerPart(): ContentPart {
    return { type: 'text', text: this.config.truncatedMarker };
  }
}
