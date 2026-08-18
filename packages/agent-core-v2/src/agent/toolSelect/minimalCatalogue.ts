/**
 * `toolSelect` domain — the `minimal_mode` tool catalogue and its refusal text.
 *
 * Names the two tools a minimal session composes for its whole lifetime, and
 * words the refusal a call to anything outside that set gets back. The set is
 * fixed for the session: unlike progressive disclosure there is nothing to load
 * and no later step that widens it, so the refusal must not promise otherwise.
 * Also names the lean-ctx catalogue a session-chosen lean mode composes instead
 * of the built-in pair, and folds that choice into the declared capability so
 * every consumer of `minimal_mode` reads one answer rather than testing two
 * flags. An unresolvable model keeps `UNKNOWN_CAPABILITY` untouched — the
 * marker doubles as "no model bound", and a session that cannot resolve a
 * model sends no request to strip. Pure: holds no state and reaches no service.
 */

import { isUnknownCapability, type ModelCapability } from '#/kosong/contract/capability';

export const MINIMAL_MODE_TOOL_NAMES = [
  'mcp__lean-ctx__ctx_read',
  'mcp__lean-ctx__ctx_search',
  'mcp__lean-ctx__ctx_shell',
  'mcp__lean-ctx__ctx_patch',
] as const;

export const LEAN_MODE_TOOL_NAMES = [
  'mcp__lean-ctx__ctx_read',
  'mcp__lean-ctx__ctx_search',
  'mcp__lean-ctx__ctx_shell',
  'mcp__lean-ctx__ctx_patch',
] as const;

const LEAN_CAPABILITY_MARKER = Symbol.for('moonshot-ai.kosong.LEAN_MODE_CAPABILITY');

export function composeLeanCapability(
  capability: ModelCapability,
  leanMode: boolean | undefined,
): ModelCapability {
  if (leanMode !== true) return capability;
  if (isUnknownCapability(capability)) return capability;
  return Object.defineProperty(
    {
      ...capability,
      minimal_mode: true,
      minimal_mode_tools: capability.minimal_mode_tools ?? LEAN_MODE_TOOL_NAMES,
    },
    LEAN_CAPABILITY_MARKER,
    { value: true },
  );
}

export function isLeanComposedCapability(capability: ModelCapability): boolean {
  return (
    (capability as unknown as Record<PropertyKey, unknown>)[LEAN_CAPABILITY_MARKER] === true
  );
}

export type MinimalModeToolName = (typeof MINIMAL_MODE_TOOL_NAMES)[number];

export function resolveMinimalModeToolNames(
  configured: readonly string[] | undefined,
): readonly string[] {
  if (configured === undefined) return MINIMAL_MODE_TOOL_NAMES;
  const seen = new Set<string>();
  for (const name of configured) {
    const trimmed = name.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

export function minimalToolUnavailableOutput(
  name: string,
  catalogue: readonly string[],
): string {
  const available =
    catalogue.length > 0 ? `only ${catalogue.join(' and ')}` : 'no tools at all';
  return (
    `Tool "${name}" is not available in this session. It composes ${available}, ` +
    'for every request, and no further tool opens later. Answer, or use one of those.'
  );
}
