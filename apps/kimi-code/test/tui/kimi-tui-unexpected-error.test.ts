import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  onUnexpectedError,
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
  type UnexpectedErrorHandler,
} from '@moonshot-ai/kimi-code-sdk';

import { KimiTUI, type KimiTUIStartupInput } from '#/tui/kimi-tui';

interface UnexpectedErrorDriver {
  installUnexpectedErrorHandler(): void;
  restoreUnexpectedErrorHandler(): void;
}

function makeStartupInput(
  cliOptions: Partial<KimiTUIStartupInput['cliOptions']> = {},
): KimiTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
      ...cliOptions,
    },
    tuiConfig: {
      theme: 'dark',
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      statusLine: { items: null, command: null },
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ses-1',
    model: 'k2',
    summary: { title: 'Session title' },
    getStatus: vi.fn(async () => ({
      model: 'k2',
      thinkingEffort: 'off',
      permission: 'manual',
      planMode: false,
      contextTokens: 10,
      maxContextTokens: 100,
      contextUsage: 0.1,
    })),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    setPermission: vi.fn(async () => {}),
    setPlanMode: vi.fn(async () => {}),
    getGoal: vi.fn(async () => ({ goal: null })),
    onEvent: vi.fn(() => () => {}),
    getResumeState: vi.fn(() => null),
    listSkills: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeHarness(session = makeSession(), overrides: Record<string, unknown> = {}) {
  return {
    getConfig: vi.fn(async () => ({
      models: {
        k2: { model: 'moonshot-v1', maxContextSize: 200 },
      },
      defaultModel: 'k2',
    })),
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    track: vi.fn(),
    setTelemetryContext: vi.fn(),
    getExperimentalFeatures: vi.fn(async () => []),
    supportsAtomicSectionReplace: vi.fn(() => false),
    getWorkspaceTrustInfo: vi.fn(async () => ({ trusted: true, gatedMcpServers: [] })),
    trustWorkspace: vi.fn(async () => {}),
    auth: {
      status: vi.fn(async () => ({ providers: [] })),
      login: vi.fn(async () => {}),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
    },
    ...overrides,
  };
}

function makeTui(harness: ReturnType<typeof makeHarness> = makeHarness()): KimiTUI {
  const tui = new KimiTUI(harness as never, makeStartupInput({ model: 'k2' }));
  // pi-tui start/stop and the terminal touch the real TTY — stub the I/O.
  vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(tui.state.ui, 'start').mockImplementation(() => {});
  vi.spyOn(tui.state.ui, 'stop').mockImplementation(() => {});
  vi.spyOn(tui.state.terminal, 'setProgress').mockImplementation(() => {});
  vi.spyOn(tui.state.terminal, 'write').mockImplementation(() => {});
  vi.spyOn(tui.state.terminal, 'drainInput').mockImplementation(async () => {});
  return tui;
}

describe('KimiTUI unexpected-error handler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetUnexpectedErrorHandler();
  });

  it('routes engine unexpected errors into the managed status during the TUI lifetime', async () => {
    const tui = makeTui();
    const showStatusSpy = vi.spyOn(tui, 'showStatus');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await tui.start();

    onUnexpectedError(new Error('boom boom'));

    // Managed path: one-line status component, not a raw stderr write.
    expect(showStatusSpy).toHaveBeenCalledWith('Error: boom boom', 'error');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    const transcript = tui.state.transcriptContainer.render(160).join('\n');
    expect(transcript).toContain('Error: boom boom');

    await tui.stop();

    // Shutdown itself must not fall back to stderr either.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('restores the previously-installed handler when the TUI stops', async () => {
    const sentinel = vi.fn<(err: unknown) => void>();
    setUnexpectedErrorHandler(sentinel);
    try {
      const tui = makeTui();
      (tui as unknown as UnexpectedErrorDriver).installUnexpectedErrorHandler();

      // While the TUI handler is live, the sentinel must not see anything.
      onUnexpectedError(new Error('during'));
      expect(sentinel).not.toHaveBeenCalled();

      await tui.stop();

      // stop() restores the handler this instance replaced — not the module
      // default — so the sentinel is back in charge.
      onUnexpectedError('after-stop');
      expect(sentinel).toHaveBeenCalledWith('after-stop');
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('chains install/restore across two consecutive TUI instances', async () => {
    const sentinel = vi.fn<(err: unknown) => void>();
    setUnexpectedErrorHandler(sentinel);
    try {
      const tuiA = makeTui();
      const tuiB = makeTui();
      (tuiA as unknown as UnexpectedErrorDriver).installUnexpectedErrorHandler();
      (tuiB as unknown as UnexpectedErrorDriver).installUnexpectedErrorHandler();
      const showErrorA = vi.spyOn(tuiA, 'showError');
      const showErrorB = vi.spyOn(tuiB, 'showError');

      // B is on top: errors route to B.
      onUnexpectedError(new Error('to-b'));
      expect(showErrorB).toHaveBeenCalledWith('to-b');
      expect(showErrorA).not.toHaveBeenCalled();

      await tuiB.stop();

      // B restored the exact handler it replaced — A's — so errors now route
      // to A, not to the sentinel.
      onUnexpectedError(new Error('to-a'));
      expect(showErrorA).toHaveBeenCalledWith('to-a');
      expect(showErrorB).toHaveBeenCalledTimes(1);
      expect(sentinel).not.toHaveBeenCalled();

      await tuiA.stop();

      // A restored the sentinel.
      onUnexpectedError('tail');
      expect(sentinel).toHaveBeenCalledWith('tail');
    } finally {
      resetUnexpectedErrorHandler();
    }
  });
});
