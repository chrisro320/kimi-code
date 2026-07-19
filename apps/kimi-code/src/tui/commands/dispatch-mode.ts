import type { DispatchMode } from '@moonshot-ai/kimi-code-sdk';

import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const DISPATCH_MODES: readonly DispatchMode[] = ['auto', 'ask', 'off'];

function isDispatchMode(value: string): value is DispatchMode {
  return (DISPATCH_MODES as readonly string[]).includes(value);
}

function dispatchModeDescription(mode: DispatchMode): string {
  switch (mode) {
    case 'auto':
      return 'Balanced proactive delegation (default).';
    case 'ask':
      return 'A single read-only worker runs normally; multi-worker, editing, reviewer, or coder-ex dispatch asks for confirmation first.';
    case 'off':
      return 'The agent will not initiate delegation; an explicit Agent/AgentSwarm call still asks for confirmation.';
  }
}

/** `/dispatch [auto|ask|off]` — show or set the session's proactive-delegation policy (D3). */
export async function handleDispatchCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const arg = args.trim().toLowerCase();
  if (arg.length === 0) {
    const current = host.state.appState.dispatchMode;
    host.showStatus(
      `Dispatch mode: ${current} — ${dispatchModeDescription(current)} Usage: /dispatch [auto|ask|off]`,
    );
    return;
  }

  if (!isDispatchMode(arg)) {
    host.showError(`Invalid dispatch mode "${args.trim()}". Usage: /dispatch [auto|ask|off]`);
    return;
  }

  if (arg === host.state.appState.dispatchMode) {
    host.showStatus(`Dispatch mode is already ${arg}.`);
    return;
  }

  try {
    await session.setDispatchMode(arg);
  } catch (error) {
    host.showError(`Failed to set dispatch mode: ${formatErrorMessage(error)}`);
    return;
  }
  host.setAppState({ dispatchMode: arg });
  host.showNotice(`Dispatch mode: ${arg.toUpperCase()}`, dispatchModeDescription(arg));
}
