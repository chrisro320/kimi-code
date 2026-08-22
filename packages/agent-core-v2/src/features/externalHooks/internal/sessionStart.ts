import type { HookResult } from './types';
import { hookContextText, renderHookResult } from './userPrompt';

/** Renders SessionStart hook output into one context block, or nothing. */
export function renderSessionStartHookText(
  results: readonly HookResult[] | undefined,
): string | undefined {
  const texts =
    results
      ?.filter((result) => result.action !== 'block')
      .map(hookContextText)
      .filter((text): text is string => text !== undefined && text.length > 0) ?? [];
  if (texts.length === 0) return undefined;
  return renderHookResult('SessionStart', texts.join('\n\n'));
}
