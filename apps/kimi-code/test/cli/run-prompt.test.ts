/**
 * Scenario: `kimi -p` entry point and the run-lifecycle helpers it exports.
 * Responsibilities: every prompt run reaches the agent-core-v2 runner, and the
 *   shared helpers (bounded shutdown, signal cleanup, model resolution) behave.
 * Wiring: the v2 runner is mocked; the exported helpers are real.
 * Run: pnpm -C apps/kimi-code exec vitest run test/cli/run-prompt.test.ts
 *
 * The print-mode driver itself is tested in `v2-run-print.test.ts` /
 * `run-v2-print.test.ts` — it lives in `v2/run-v2-print.ts`, not here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configuredModel,
  installPromptTerminationCleanup,
  raceWithTimeout,
  requireConfiguredModel,
  runPrompt,
  signalExitCode,
  type PromptProcess,
} from '#/cli/run-prompt';
import type { CLIOptions } from '#/cli/options';

const mocks = vi.hoisted(() => ({
  runV2Print: vi.fn(async () => undefined),
}));

vi.mock('#/cli/v2/run-v2-print', () => ({
  runV2Print: mocks.runV2Print,
}));

function opts(overrides: Partial<CLIOptions> = {}): CLIOptions {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: 'hello',
    skillsDirs: [],
    agent: undefined,
    agentFiles: [],
    ...overrides,
  } as CLIOptions;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('runPrompt', () => {
  // There is no engine gate left: agent-core-v2 is the only runner, so this is
  // the assertion that `kimi -p` cannot silently fall back to anything else.
  it('routes every prompt run to the agent-core-v2 runner', async () => {
    const io = { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } };

    await runPrompt(opts(), '1.2.3-test', io);

    expect(mocks.runV2Print).toHaveBeenCalledTimes(1);
    expect(mocks.runV2Print).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'hello' }),
      '1.2.3-test',
      io,
    );
  });

  it('forwards the stream-json output format unchanged', async () => {
    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test');

    expect(mocks.runV2Print).toHaveBeenCalledWith(
      expect.objectContaining({ outputFormat: 'stream-json' }),
      '1.2.3-test',
      {},
    );
  });
});

describe('raceWithTimeout', () => {
  it('propagates a rejection that settles before the timeout', async () => {
    const failing = Promise.reject(new Error('cleanup blew up'));

    await expect(raceWithTimeout(failing, 1_000)).rejects.toThrow('cleanup blew up');
  });

  it('gives up waiting once the timeout wins', async () => {
    const wedged = new Promise<void>(() => {});

    await expect(raceWithTimeout(wedged, 10)).resolves.toBeUndefined();
  });

  it('swallows a rejection that lands after the timeout has won', async () => {
    let reject!: (error: Error) => void;
    const late = new Promise<void>((_, r) => {
      reject = r;
    });

    await expect(raceWithTimeout(late, 10)).resolves.toBeUndefined();
    // Rejecting after we stopped waiting must not surface as an unhandled
    // rejection; the eager catch inside raceWithTimeout owns it.
    reject(new Error('too late'));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

describe('installPromptTerminationCleanup', () => {
  function fakeProcess() {
    const handlers = new Map<NodeJS.Signals, () => Promise<void>>();
    const exit = vi.fn();
    const promptProcess: PromptProcess = {
      once: (signal, listener) => handlers.set(signal, listener),
      off: (signal) => handlers.delete(signal),
      exit: exit as unknown as PromptProcess['exit'],
    };
    return { promptProcess, handlers, exit };
  }

  it('runs cleanup once and exits with the signal code', async () => {
    const { promptProcess, handlers, exit } = fakeProcess();
    const cleanup = vi.fn(async () => undefined);
    installPromptTerminationCleanup(promptProcess, cleanup);

    await handlers.get('SIGINT')!();
    await handlers.get('SIGTERM')!();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('still exits when cleanup rejects', async () => {
    const { promptProcess, handlers, exit } = fakeProcess();
    installPromptTerminationCleanup(promptProcess, async () => {
      throw new Error('cleanup failed');
    });

    await expect(handlers.get('SIGTERM')!()).rejects.toThrow('cleanup failed');
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('removes its handlers when disposed', () => {
    const { promptProcess, handlers } = fakeProcess();
    const dispose = installPromptTerminationCleanup(promptProcess, async () => undefined);

    expect(handlers.size).toBe(3);
    dispose();
    expect(handlers.size).toBe(0);
  });
});

describe('model resolution', () => {
  it('picks the first non-blank candidate', () => {
    expect(configuredModel(undefined, '   ', 'k2', 'k3')).toBe('k2');
  });

  it('returns undefined when every candidate is blank', () => {
    expect(configuredModel(undefined, '', '  ')).toBeUndefined();
  });

  it('throws a login hint when no model is configured', () => {
    expect(() => requireConfiguredModel(undefined)).toThrow(/No model configured/);
  });
});

describe('signalExitCode', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGHUP', 129],
    ['SIGTERM', 143],
  ] as const)('maps %s to %i', (signal, code) => {
    expect(signalExitCode(signal)).toBe(code);
  });
});
