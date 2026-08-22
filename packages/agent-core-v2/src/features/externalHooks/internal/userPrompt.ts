import type { HookResult } from './types';

export function renderHookResult(event: string, message: string): string {
  return `<hook_result hook_event="${event}">\n${message}\n</hook_result>`;
}

export interface RenderedHookResult {
  readonly event: string;
  readonly message: string;
  readonly text: string;
}

export function renderUserPromptHookResult(
  results: readonly HookResult[] | undefined,
): RenderedHookResult | undefined {
  const messages =
    results
      ?.filter((result) => result.action !== 'block')
      ?.map(hookContextText)
      .filter(isNonEmptyString) ??
    [];
  if (messages.length === 0) return undefined;
  const displayMessage = messages.join('\n\n');
  return {
    event: 'UserPromptSubmit',
    message: displayMessage,
    text: messages.map((message) => renderHookResult('UserPromptSubmit', message)).join('\n'),
  };
}

export function renderUserPromptHookBlockResult(
  results: readonly HookResult[] | undefined,
): RenderedHookResult | undefined {
  const block = results?.find((result) => result.action === 'block');
  if (block === undefined) return undefined;
  const message = block.message?.trim();
  if (message !== undefined && message.length > 0) {
    return {
      event: 'UserPromptSubmit',
      message,
      text: renderHookResult('UserPromptSubmit', message),
    };
  }
  const reason = block.reason?.trim();
  const result =
    reason === undefined || reason.length === 0 ? 'Blocked by UserPromptSubmit hook' : reason;
  return {
    event: 'UserPromptSubmit',
    message: result,
    text: renderHookResult('UserPromptSubmit', result),
  };
}

/**
 * Resolves the text a hook result contributes to the model context: a parsed
 * envelope beats raw stdout, so `additionalContext` wins, then `message`, and
 * raw stdout only when the hook's stdout was not structured hook JSON.
 */
export function hookContextText(result: HookResult): string | undefined {
  if (result.timedOut === true || (result.exitCode !== undefined && result.exitCode !== 0)) {
    return undefined;
  }
  const additionalContext = result.additionalContext?.trim();
  if (additionalContext !== undefined && additionalContext.length > 0) return additionalContext;
  const message = result.message?.trim();
  if (message !== undefined && message.length > 0) return message;
  if (result.structuredOutput === true) return undefined;
  const stdout = result.stdout?.trim();
  return stdout === undefined || stdout.length === 0 ? undefined : stdout;
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
