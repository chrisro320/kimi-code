import { afterEach, describe, expect, it, vi } from 'vitest';

import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';

// Mirrors the module-private STATUSLINE_POLL_INTERVAL_MS in kimi-tui.ts —
// kept in sync with the poller's own interval so this stays a true lifecycle
// check of the interval the poller registers.
const STATUSLINE_POLL_INTERVAL_MS = 20_000;

interface PollerDriver {
  state: TUIState;
  init(): Promise<boolean>;
  ensureSession(): Promise<unknown>;
  createNewSession(): Promise<void>;
  switchToSession(session: unknown, statusMessage: string): Promise<boolean>;
  stopStatuslinePolling(): void;
  pollStatusline(): Promise<void>;
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
    auth: {
      status: vi.fn(async () => ({ providers: [] })),
      login: vi.fn(async () => {}),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
    },
    ...overrides,
  };
}

async function makeDriver(): Promise<{ driver: PollerDriver }> {
  const harness = makeHarness();
  // Startup with an explicit model so the lazy / fresh session creation paths
  // have a model to build the session from (kimi-tui throws without one).
  const driver = new KimiTUI(
    harness as never,
    makeStartupInput({ model: 'k2' }),
  ) as unknown as PollerDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  await driver.init();
  // Session-less v2 startup: no session, and (before this fix) no poller.
  expect(driver.state.appState.sessionId).toBe('');
  return { driver };
}

describe('statusline poller lifecycle (S-1/S-2 regressions)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts the poller with an immediate poll when the lazy session activates', async () => {
    const { driver } = await makeDriver();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const pollSpy = vi.spyOn(driver, 'pollStatusline').mockResolvedValue(undefined);

    await driver.ensureSession();

    expect(pollSpy).toHaveBeenCalled();
    const pollIntervals = intervalSpy.mock.calls.filter(
      ([, delay]) => delay === STATUSLINE_POLL_INTERVAL_MS,
    );
    expect(pollIntervals).toHaveLength(1);
    driver.stopStatuslinePolling();
  });

  it('starts the poller when a fresh session is created (/new)', async () => {
    const { driver } = await makeDriver();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const pollSpy = vi.spyOn(driver, 'pollStatusline').mockResolvedValue(undefined);

    await driver.createNewSession();

    expect(pollSpy).toHaveBeenCalled();
    const pollIntervals = intervalSpy.mock.calls.filter(
      ([, delay]) => delay === STATUSLINE_POLL_INTERVAL_MS,
    );
    expect(pollIntervals).toHaveLength(1);
    driver.stopStatuslinePolling();
  });

  it('starts the poller when a session is resumed (switchToSession)', async () => {
    const { driver } = await makeDriver();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const pollSpy = vi.spyOn(driver, 'pollStatusline').mockResolvedValue(undefined);

    await driver.switchToSession(makeSession(), 'Resumed session.');

    expect(pollSpy).toHaveBeenCalled();
    const pollIntervals = intervalSpy.mock.calls.filter(
      ([, delay]) => delay === STATUSLINE_POLL_INTERVAL_MS,
    );
    expect(pollIntervals).toHaveLength(1);
    driver.stopStatuslinePolling();
  });

  it('does not stack a second interval when the session is activated again', async () => {
    const { driver } = await makeDriver();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const pollSpy = vi.spyOn(driver, 'pollStatusline').mockResolvedValue(undefined);

    await driver.ensureSession();
    // A second activation on top of the first must be a no-op for the poller:
    // no extra immediate poll, no second interval.
    await driver.createNewSession();
    await driver.ensureSession();

    expect(pollSpy).toHaveBeenCalledTimes(1);
    const pollIntervals = intervalSpy.mock.calls.filter(
      ([, delay]) => delay === STATUSLINE_POLL_INTERVAL_MS,
    );
    expect(pollIntervals).toHaveLength(1);
    driver.stopStatuslinePolling();
  });
});
