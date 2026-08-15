/**
 * `toolSelect` domain — the `minimal_mode` tool catalogue and its refusal text.
 *
 * Names the two tools a minimal session composes for its whole lifetime, and
 * words the refusal a call to anything outside that set gets back. The set is
 * fixed for the session: unlike progressive disclosure there is nothing to load
 * and no later step that widens it, so the refusal must not promise otherwise.
 * Pure: holds no state and reaches no service.
 */

export const MINIMAL_MODE_TOOL_NAMES = ['Bash', 'Read'] as const;

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
