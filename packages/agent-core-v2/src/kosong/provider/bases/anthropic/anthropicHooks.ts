/**
 * `kosong/provider` domain (L2) — the ONLY composition point from resolved
 * traits to the Anthropic hook set.
 *
 * Single-value hooks use the last trait declarer. `withThinking` receives a
 * defensive kwargs copy, so a dialect hook cannot mutate base state.
 */

import type { Tool } from '#/kosong/contract/tool';
import type { ResolvedTrait } from '#/kosong/protocol/protocolTrait';

import type { AnthropicHooks } from './anthropic';

export function composeAnthropicHooks(
  traits: readonly ResolvedTrait[],
): AnthropicHooks | undefined {
  const hooks: AnthropicHooks = {};

  for (const { trait, context } of traits) {
    if (trait.convertTool !== undefined) {
      hooks.convertTool = (tool: Tool) =>
        trait.convertTool!(tool, context) as ReturnType<NonNullable<AnthropicHooks['convertTool']>>;
    }
    if (trait.withThinking !== undefined) {
      hooks.withThinking = (effort, options, kwargs) =>
        trait.withThinking!(effort, options, { ...kwargs }, context);
    }
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}
