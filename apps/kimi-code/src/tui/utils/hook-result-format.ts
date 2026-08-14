import type { HookResultEvent } from '@moonshot-ai/kimi-code-sdk';

export function formatHookResultMarkdown(event: HookResultEvent): string {
  return `*${formatHookResultTitle(event.hookEvent, event.blocked === true)}*\n\n${formatHookResultBody(event.content)}`;
}

export function formatHookResultPlain(event: HookResultEvent): string {
  return `${formatHookResultTitle(event.hookEvent, event.blocked === true)}\n\n${formatHookResultBody(event.content)}`;
}

export function formatHookResultTitle(hookEvent: string, blocked: boolean): string {
  return `${hookEvent} hook${blocked ? ' blocked' : ''}`;
}

export function formatHookResultBody(content: string): string {
  const trimmed = content.trim();
  return trimmed.length === 0 ? '(empty)' : trimmed;
}
