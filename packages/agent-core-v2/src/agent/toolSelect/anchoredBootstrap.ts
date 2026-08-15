/**
 * `toolSelect` domain — anchored-bootstrap catalogue and promotion predicate.
 *
 * Names the minimal tool catalogue that a session's first request carries while
 * the `anchored_bootstrap` model capability is declared, decides from
 * conversation history whether the session has already produced the assistant
 * message that opens the full catalogue, and words the refusal a call to a
 * still-closed tool gets back. Promotion needs an assistant message carrying
 * content or a tool call: the folded history already holds an empty assistant
 * placeholder for the in-flight step by the time the request is assembled, so
 * a bare role test would open the catalogue on the very request it is meant to
 * anchor. Pure: holds no state and reaches no service.
 */

import type { ContextMessage } from '#/agent/contextMemory/types';

export const ANCHORED_BOOTSTRAP_TOOL_NAMES = ['Bash', 'Read'] as const;

export type AnchoredBootstrapToolName = (typeof ANCHORED_BOOTSTRAP_TOOL_NAMES)[number];

export function resolveAnchoredBootstrapToolNames(
  configured: readonly string[] | undefined,
): readonly string[] {
  if (configured === undefined) return ANCHORED_BOOTSTRAP_TOOL_NAMES;
  const seen = new Set<string>();
  for (const name of configured) {
    const trimmed = name.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

export function hasPromotionSignal(messages: readonly ContextMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      (message.content.length > 0 || message.toolCalls.length > 0),
  );
}

export function anchoredToolClosedOutput(name: string, bootstrap: readonly string[]): string {
  const available =
    bootstrap.length > 0 ? `only ${bootstrap.join(' and ')}` : 'no tools at all';
  return (
    `Tool "${name}" is not open yet. This session's first request carries ${available}; ` +
    'every tool opens from the next step onwards. Answer, or use one of those tools now, ' +
    'then call it.'
  );
}
