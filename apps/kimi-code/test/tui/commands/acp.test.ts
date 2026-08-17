import { describe, expect, it, vi } from 'vitest';

import { handleAcpCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { NO_ACTIVE_SESSION_MESSAGE } from '#/tui/constant/kimi-tui';
import { currentTheme } from '#/tui/theme';

const ENTER = '\r';
const ESCAPE = '\u001B';
const DOWN = '\u001B[B';

function makeAcpStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    managerId: 'acp-kernel',
    managerVersion: '0.1.0',
    health: 'healthy' as const,
    refs: 3,
    blocks: 7,
    activeBlocks: 2,
    ...overrides,
  };
}

function makeHost(
  overrides: {
    hasSession?: boolean;
    acpStatus?: Record<string, unknown>;
  } = {},
) {
  const session = {
    acpStatus: vi.fn(async () => makeAcpStatus(overrides.acpStatus)),
    acpEnable: vi.fn(async () => {}),
    acpDisable: vi.fn(async () => {}),
    acpReset: vi.fn(async () => {}),
  };
  const hasSession = overrides.hasSession ?? true;
  const host = {
    state: {
      appState: {} as Record<string, unknown>,
      theme: currentTheme,
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: hasSession ? session : undefined,
    requireSession: () => session,
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

interface TestPicker {
  handleInput(data: string): void;
}

function mountedPicker(host: SlashCommandHost): TestPicker {
  const mock = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0]?.[0] as TestPicker;
}

describe('handleAcpCommand', () => {
  it('reports an error when there is no active session', async () => {
    const { host } = makeHost({ hasSession: false });

    await handleAcpCommand(host, '');

    expect(host.showError).toHaveBeenCalledWith(NO_ACTIVE_SESSION_MESSAGE);
  });

  it('shows status and marks the badge healthy when enabled', async () => {
    const { host, session } = makeHost();

    await handleAcpCommand(host, '');

    expect(session.acpStatus).toHaveBeenCalledOnce();
    expect(host.setAppState).toHaveBeenCalledWith({ acp: 'healthy' });
    const [title, detail] = (host.showNotice as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(title).toBe('ACP status');
    expect(detail).toContain('enabled');
    expect(detail).toContain('Refs: 3');
    expect(detail).toContain('Blocks: 7 (2 active)');
    expect(detail).not.toContain('Context usage');
  });

  it('clears the badge and shows degraded reason when disabled', async () => {
    const { host } = makeHost({
      acpStatus: { enabled: false, health: 'degraded', reason: 'store offline', contextUsage: 0.42 },
    });

    await handleAcpCommand(host, 'status');

    expect(host.setAppState).toHaveBeenCalledWith({ acp: undefined });
    const [, detail] = (host.showNotice as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(detail).toContain('disabled');
    expect(detail).toContain('store offline');
    expect(detail).toContain('Context usage: 42%');
  });

  it('enables the manager and marks the badge healthy', async () => {
    const { host, session } = makeHost();

    await handleAcpCommand(host, 'enable');

    expect(session.acpEnable).toHaveBeenCalledOnce();
    expect(session.acpStatus).toHaveBeenCalledOnce();
    expect(host.setAppState).toHaveBeenCalledWith({ acp: 'healthy' });
    expect(host.showNotice).toHaveBeenCalledWith(
      'ACP context manager enabled',
      'Takes effect on the next request.',
    );
  });

  it('refuses to enable while lean mode is pending', async () => {
    const { host, session } = makeHost();
    host.state.appState.leanMode = true;

    await handleAcpCommand(host, 'enable');

    expect(session.acpEnable).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('ACP conflicts with lean mode'));
  });

  it('refuses to enable while lean mode is live', async () => {
    const { host, session } = makeHost();
    host.state.appState.leanModeActive = true;

    await handleAcpCommand(host, 'enable');

    expect(session.acpEnable).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('ACP conflicts with lean mode'));
  });

  it('marks the badge degraded when the service is still degraded after enable', async () => {
    const { host, session } = makeHost({
      acpStatus: { health: 'degraded', reason: 'store offline' },
    });

    await handleAcpCommand(host, 'enable');

    expect(session.acpEnable).toHaveBeenCalledOnce();
    expect(host.setAppState).toHaveBeenCalledWith({ acp: 'degraded' });
  });

  it('disables the manager and clears the badge', async () => {
    const { host, session } = makeHost();

    await handleAcpCommand(host, 'disable');

    expect(session.acpDisable).toHaveBeenCalledOnce();
    expect(host.setAppState).toHaveBeenCalledWith({ acp: undefined });
    expect(host.state.appState.acp).toBeUndefined();
  });

  it('does not reset when the confirmation picker is cancelled', async () => {
    const { host, session } = makeHost();

    const pending = handleAcpCommand(host, 'reset');
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    mountedPicker(host).handleInput(ENTER);
    await pending;

    expect(session.acpReset).not.toHaveBeenCalled();
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('does not reset when the picker is dismissed with Escape', async () => {
    const { host, session } = makeHost();

    const pending = handleAcpCommand(host, 'reset');
    mountedPicker(host).handleInput(ESCAPE);
    await pending;

    expect(session.acpReset).not.toHaveBeenCalled();
  });

  it('resets state after confirming the danger option', async () => {
    const { host, session } = makeHost();

    const pending = handleAcpCommand(host, 'reset');
    mountedPicker(host).handleInput(DOWN);
    mountedPicker(host).handleInput(ENTER);
    await pending;

    expect(session.acpReset).toHaveBeenCalledOnce();
    expect(host.showNotice).toHaveBeenCalledWith(
      'ACP state reset',
      'Refs and compressed blocks for this agent were deleted.',
    );
  });

  it('rejects unknown subcommands with usage', async () => {
    const { host, session } = makeHost();

    await handleAcpCommand(host, 'explode');

    expect(host.showError).toHaveBeenCalledWith(
      'Unknown /acp subcommand: explode. Usage: /acp [status|enable|disable|reset]',
    );
    expect(session.acpStatus).not.toHaveBeenCalled();
  });
});
