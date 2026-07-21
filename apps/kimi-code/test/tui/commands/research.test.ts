import { describe, expect, it, vi } from 'vitest';

import { dispatchInput, handleResearchCommand, type SlashCommandHost } from '#/tui/commands';

function makeHost(options: { model?: string; hasSession?: boolean; research?: unknown; cancelError?: Error } = {}) {
  const cancel = options.cancelError === undefined
    ? vi.fn(async () => {})
    : vi.fn(async () => { throw options.cancelError ?? new Error('cancel failed'); });
  const appState = {
    model: options.model ?? 'kimi-k2',
    streamingPhase: 'idle' as const,
    isCompacting: false,
    research: options.research ?? null,
  };
  const host = {
    state: { appState },
    session: options.hasSession === false ? undefined : { cancel },
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    sendNormalUserInput: vi.fn(),
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(appState, patch)),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    showError: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    sendNormalUserInput: ReturnType<typeof vi.fn>;
    setAppState: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
    session: { cancel: ReturnType<typeof vi.fn> } | undefined;
  };
  return host;
}

const activeResearch = {
  focus: 'Minecraft and No Man’s Sky',
  phase: 'auditing' as const,
  startedAtMs: 100,
};

describe('handleResearchCommand', () => {
  it('starts a session-scoped ReferenceAudit with explicit fallback semantics', async () => {
    const host = makeHost();

    await handleResearchCommand(host, 'Minecraft and No Man’s Sky');

    expect(host.setAppState).toHaveBeenCalledWith({
      research: expect.objectContaining({
        focus: 'Minecraft and No Man’s Sky',
        phase: 'starting',
      }),
    });
    const prompt = host.sendNormalUserInput.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('Use the ReferenceAudit tool');
    expect(prompt).toContain('do not automatically invoke Agora');
    expect(prompt).toContain('main-model fallback (not independent consensus)');
    expect(prompt).toContain('Minecraft and No Man’s Sky');
  });

  it('shows status without starting another audit', async () => {
    const host = makeHost({ research: { ...activeResearch, fallbackReason: 'provider quota exhausted' } });

    await handleResearchCommand(host, 'status');

    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('main-model fallback: provider quota exhausted'));
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('cancels the actual active session turn before clearing research state', async () => {
    const host = makeHost({ research: activeResearch });

    await handleResearchCommand(host, 'cancel');

    expect(host.session?.cancel).toHaveBeenCalledOnce();
    expect(host.setAppState).toHaveBeenNthCalledWith(1, {
      research: { ...activeResearch, phase: 'cancelling' },
    });
    expect(host.setAppState).toHaveBeenNthCalledWith(2, { research: null });
  });

  it('keeps the active state when cancellation fails', async () => {
    const host = makeHost({ research: activeResearch, cancelError: new Error('cancel rejected') });

    await handleResearchCommand(host, 'cancel');

    expect(host.setAppState).toHaveBeenLastCalledWith({ research: activeResearch });
    expect(host.showError).toHaveBeenCalledWith('Failed to cancel research audit: cancel rejected');
  });

  it('dispatches /research through the built-in command registry', async () => {
    const host = makeHost();

    dispatchInput(host, '/research inspect public references');
    await vi.waitFor(() => expect(host.sendNormalUserInput).toHaveBeenCalledOnce());

    expect(host.track).toHaveBeenCalledWith('input_command', { command: 'research' });
  });
});
