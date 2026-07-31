/**
 * `kosong/provider` domain — the ONLY composition point from resolved
 * traits to the Anthropic hook set.
 *
 * Single-value hooks use the last trait declarer. `withThinking` takes the LAST
 * declarer and wraps it with a defensive kwargs copy — so a hook can never
 * mutate base state, and a synthetic construction-headers trait (which never
 * declares `withThinking`) can never shadow a real dialect hook. `convertError`
 * is the shared single-value binding from `traitConvertError`. `convertTool` is
 * this fork's addition: DeepSeek served over the Anthropic wire needs a flat
 * object at the root of every tool schema.
 */

import type { Tool } from '#/kosong/contract/tool';
import { traitConvertError, type ResolvedTrait } from '#/kosong/protocol/protocolTrait';

import type { AnthropicHooks } from './anthropic';

export function composeAnthropicHooks(
  traits: readonly ResolvedTrait[],
): AnthropicHooks | undefined {
  const hooks: AnthropicHooks = {};

  // convertTool keeps the fork's last-declarer loop: upstream has no such hook.
  for (const { trait, context } of traits) {
    if (trait.convertTool !== undefined) {
      hooks.convertTool = (tool: Tool) =>
        trait.convertTool!(tool, context) as ReturnType<NonNullable<AnthropicHooks['convertTool']>>;
    }
  }

  const thinkingTraits = traits.filter(({ trait }) => trait.withThinking !== undefined);
  if (thinkingTraits.length > 0) {
    const { trait, context } = thinkingTraits.at(-1)!;
    hooks.withThinking = (effort, options, kwargs) =>
      trait.withThinking!(effort, options, { ...kwargs }, context);
  }

  const convertError = traitConvertError(traits);
  if (convertError !== undefined) {
    hooks.convertError = convertError;
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}
