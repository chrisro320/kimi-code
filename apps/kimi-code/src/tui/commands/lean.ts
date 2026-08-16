/**
 * `commands` domain — the `/lean` slash command.
 *
 * Records whether the next session is created in lean mode and reports where
 * that lands. Lean is a create-time choice — the one-line prompt and the
 * lean-ctx catalogue it composes are the request prefix — so a live session
 * keeps the mode it was created with and the new value waits for `/new`.
 * Reads and writes the TUI app state through `host`; reaches no engine service.
 */

import type { SlashCommandHost } from './dispatch';

export function handleLeanCommand(host: SlashCommandHost, args: string): void {
  const arg = args.trim().toLowerCase();
  if (arg !== '' && arg !== 'on' && arg !== 'off') {
    host.showError('Usage: /lean [on|off]');
    return;
  }
  const next = arg === '' ? !host.state.appState.leanMode : arg === 'on';
  host.setAppState({ leanMode: next });

  if (host.session === undefined) {
    host.showStatus(
      next
        ? 'Lean mode on — the session starts with a one-line prompt and the lean-ctx tools only.'
        : 'Lean mode off — the session starts with the full prompt and tool set.',
    );
    return;
  }
  if (host.state.appState.leanModeActive === next) {
    host.showStatus(next ? 'Lean mode is already on.' : 'Lean mode is already off.');
    return;
  }
  host.showStatus(
    next
      ? 'Lean mode on for the next session — run /new to start it. This session keeps its prefix.'
      : 'Lean mode off for the next session — run /new to start it. This session keeps its prefix.',
  );
}
