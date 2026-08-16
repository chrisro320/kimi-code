import { describe, expect, it, vi } from 'vitest';

import { handleLeanCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function makeHost(
  overrides: { hasSession?: boolean; leanMode?: boolean; leanModeActive?: boolean } = {},
) {
  const host = {
    state: {
      appState: {
        leanMode: overrides.leanMode ?? false,
        leanModeActive: overrides.leanModeActive ?? false,
      },
    },
    session: overrides.hasSession === true ? {} : undefined,
    setAppState: vi.fn((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    showError: vi.fn(),
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost;
  return host;
}

describe('handleLeanCommand', () => {
  // The footer reads the live value. With no session yet the next session is
  // the first one, so waiting for the status sync would leave the badge dark
  // until the user sent a message — the mode would look like it did not take.
  it('marks lean live immediately when there is no session yet', () => {
    const host = makeHost();

    handleLeanCommand(host, '');

    expect(host.state.appState.leanMode).toBe(true);
    expect(host.state.appState.leanModeActive).toBe(true);
  });

  it('leaves the live value alone while a session is running', () => {
    const host = makeHost({ hasSession: true });

    handleLeanCommand(host, 'on');

    expect(host.state.appState.leanMode).toBe(true);
    expect(host.state.appState.leanModeActive).toBe(false);
    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('/new'));
  });

  it('turns lean back off', () => {
    const host = makeHost({ leanMode: true, leanModeActive: true });

    handleLeanCommand(host, '');

    expect(host.state.appState.leanMode).toBe(false);
    expect(host.state.appState.leanModeActive).toBe(false);
  });

  it('rejects an unknown argument without touching the state', () => {
    const host = makeHost();

    handleLeanCommand(host, 'maybe');

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith('Usage: /lean [on|off]');
  });
});
