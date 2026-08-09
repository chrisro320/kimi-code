import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';

interface WarningDriver {
  state: TUIState;
  sessionEventHandler: {
    handleEvent(event: Event, sendQueued: () => void): void;
  };
  init(): Promise<boolean>;
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

async function makeDriver(): Promise<{ driver: WarningDriver }> {
  const harness = makeHarness();
  const driver = new KimiTUI(harness as never, makeStartupInput()) as unknown as WarningDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  vi.spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  await driver.init();
  return { driver };
}

describe('session warning status rendering (D-1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders compaction-replay-estimate as a bare dim status (no prefix, no amber)', async () => {
    const { driver } = await makeDriver();
    const showStatusSpy = vi.spyOn(driver as never, 'showStatus');
    const message = 'post-compaction token count is an underestimate of the replay cost';

    driver.sessionEventHandler.handleEvent(
      {
        type: 'warning',
        message,
        code: 'compaction-replay-estimate',
        agentId: 'main',
      } as Event,
      () => {},
    );

    expect(showStatusSpy).toHaveBeenCalledTimes(1);
    expect(showStatusSpy).toHaveBeenCalledWith(message);
    expect(showStatusSpy).not.toHaveBeenCalledWith(`Warning: ${message}`, 'warning');
  });

  it('keeps the amber Warning: rendering for other warning codes', async () => {
    const { driver } = await makeDriver();
    const showStatusSpy = vi.spyOn(driver as never, 'showStatus');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'warning',
        message: 'tool pattern never activates',
        code: 'other',
        agentId: 'main',
      } as Event,
      () => {},
    );

    expect(showStatusSpy).toHaveBeenCalledTimes(1);
    expect(showStatusSpy).toHaveBeenCalledWith('Warning: tool pattern never activates', 'warning');
  });

  it('keeps the amber Warning: rendering when the warning carries no code', async () => {
    const { driver } = await makeDriver();
    const showStatusSpy = vi.spyOn(driver as never, 'showStatus');

    driver.sessionEventHandler.handleEvent(
      { type: 'warning', message: 'plain warning', agentId: 'main' } as Event,
      () => {},
    );

    expect(showStatusSpy).toHaveBeenCalledTimes(1);
    expect(showStatusSpy).toHaveBeenCalledWith('Warning: plain warning', 'warning');
  });
});
