import { describe, expect, it, vi } from 'vitest';

import type { KimiConfig } from '../../src/config';
import type { Session } from '../../src/session';
import { runExternalSubagent, SessionSubagentHost } from '../../src/session/subagent-host';
import {
  materializeBackendArgs,
  resolveSubagentRoute,
  parseExternalSubagentOutput,
  wrapExternalSubagentPrompt,
  type ResolvedSubagentRoute,
} from '../../src/session/subagent-routing';

const config: KimiConfig = {
  providers: { local: { type: 'openai' } },
  models: {
    fast: { provider: 'local', model: 'fast-model', maxContextSize: 128000 },
    precise: { provider: 'local', model: 'precise-model', maxContextSize: 128000 },
  },
  subagent: {
    routing: {
      coder: { model: 'fast' },
      explore: { backend: 'custom-cli', model: 'precise' },
    },
    backends: {
      'custom-cli': {
        command: 'custom-agent',
        args: ['--model', '{model}', '--cwd={cwd}'],
      },
    },
  },
};

describe('resolveSubagentRoute', () => {
  it('falls back to internal parent inheritance when no route exists', () => {
    expect(resolveSubagentRoute(config, 'plan')).toEqual({
      kind: 'internal',
      modelAlias: undefined,
    });
  });

  it('resolves per-type models and allows a swarm override', () => {
    expect(resolveSubagentRoute(config, 'coder')).toEqual({
      kind: 'internal',
      modelAlias: 'fast',
    });
    expect(resolveSubagentRoute(config, 'coder', 'precise')).toEqual({
      kind: 'internal',
      modelAlias: 'precise',
    });
  });

  it('resolves external backend args without a shell', () => {
    const route = resolveSubagentRoute(config, 'explore');
    expect(route.kind).toBe('external');
    if (route.kind !== 'external') throw new Error('expected external route');
    expect(materializeBackendArgs(route, '/workspace/project')).toEqual([
      '--model',
      'precise',
      '--cwd=/workspace/project',
    ]);
  });

  it('adds lightweight identity context for external subagents', () => {
    expect(wrapExternalSubagentPrompt('explore', 'Find the config loader.')).toBe(
      'You are a subagent delegated by a parent Kimi Code agent. Your profile is "explore". Complete the delegated task below and return your result to the parent agent, not directly to the end user.\n\nFind the config loader.',
    );
  });

  it('rejects unknown model aliases, backends, and placeholders', () => {
    expect(() => resolveSubagentRoute(config, 'coder', 'missing')).toThrow(
      'not defined in config.models',
    );
    expect(() =>
      resolveSubagentRoute(
        { ...config, subagent: { routing: { coder: { backend: 'missing' } } } },
        'coder',
      ),
    ).toThrow('not defined in subagent.backends');
    expect(() =>
      resolveSubagentRoute(
        {
          ...config,
          subagent: {
            routing: { coder: { backend: 'bad' } },
            backends: { bad: { command: 'bad', args: ['{prompt}'] } },
          },
        },
        'coder',
      ),
    ).toThrow('unsupported template placeholder');
  });
});

describe('runExternalSubagent', () => {
  const nodeRoute: Extract<ResolvedSubagentRoute, { kind: 'external' }> = {
    kind: 'external',
    backendName: 'node',
    backend: {
      command: process.execPath,
      args: [
        '-e',
        "process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{process.stderr.write('diagnostic');process.stdout.write(process.cwd()+'\\n'+input)})",
      ],
    },
    modelAlias: undefined,
  };

  it('passes prompt on stdin and returns only stdout from the configured cwd', async () => {
    const stderr: string[] = [];
    const result = await runExternalSubagent(
      nodeRoute,
      process.cwd(),
      'hello external',
      new AbortController().signal,
      (chunk) => stderr.push(chunk),
    );
    expect(result).toEqual({ result: `${process.cwd()}\nhello external` });
    expect(stderr).toEqual(['diagnostic']);
  });

  it('parses Claude and Grok JSON usage while preserving plain output fallback', () => {
    expect(parseExternalSubagentOutput(JSON.stringify({
      result: 'claude result',
      usage: {
        input_tokens: 8,
        cache_creation_input_tokens: 36646,
        cache_read_input_tokens: 120740,
        output_tokens: 876,
      },
    }))).toEqual({
      result: 'claude result',
      usage: {
        inputOther: 8,
        output: 876,
        inputCacheRead: 120740,
        inputCacheCreation: 36646,
      },
    });
    expect(parseExternalSubagentOutput(JSON.stringify({
      text: 'grok result',
      usage: { input_tokens: 19770, output_tokens: 22, total_tokens: 19920 },
    }))).toEqual({
      result: 'grok result',
      usage: {
        inputOther: 19770,
        output: 22,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    });
    expect(parseExternalSubagentOutput('plain output')).toEqual({ result: 'plain output' });
  });

  it('parses Claude and Grok streaming JSON output', () => {
    const claude = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-1',
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 40,
            cache_read_input_tokens: 10,
            output_tokens: 3,
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-2',
          usage: {
            input_tokens: 4,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 50,
            output_tokens: 5,
          },
        },
      }),
      JSON.stringify({
        type: 'result',
        result: 'claude streamed',
        usage: {
          input_tokens: 6,
          cache_creation_input_tokens: 40,
          cache_read_input_tokens: 60,
          output_tokens: 8,
        },
      }),
    ].join('\n');
    expect(parseExternalSubagentOutput(claude)).toEqual({
      result: 'claude streamed',
      usage: {
        inputOther: 6,
        output: 8,
        inputCacheRead: 60,
        inputCacheCreation: 40,
      },
    });

    const grok = [
      JSON.stringify({ type: 'text', data: 'grok ' }),
      JSON.stringify({ type: 'text', data: 'streamed' }),
      JSON.stringify({
        type: 'end',
        usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 7 },
      }),
    ].join('\n');
    expect(parseExternalSubagentOutput(grok)).toEqual({
      result: 'grok streamed',
      usage: {
        inputOther: 100,
        output: 7,
        inputCacheRead: 20,
        inputCacheCreation: 0,
      },
    });
  });

  it('reports non-zero exits and aborts a running process', async () => {
    const failing = {
      ...nodeRoute,
      backend: {
        command: process.execPath,
        args: ['-e', "process.stderr.write('bad exit');process.exit(7)"],
      },
    };
    await expect(
      runExternalSubagent(failing, process.cwd(), '', new AbortController().signal, () => {}),
    ).rejects.toThrow('exited with code 7: bad exit');

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const controller = new AbortController();
      const hanging = {
        ...nodeRoute,
        backend: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
      };
      const running = runExternalSubagent(
        hanging,
        process.cwd(),
        '',
        controller.signal,
        () => {},
      );
      controller.abort(new Error('cancelled'));
      await expect(running).rejects.toThrow('cancelled');
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it('waits for close and rejects when a backend exits while stdin is still writing', async () => {
    const earlyExit = {
      ...nodeRoute,
      backend: {
        command: process.execPath,
        args: ['-e', "process.stderr.write('closed early');process.exit(0)"],
      },
    };
    const stderr: string[] = [];

    await expect(
      runExternalSubagent(
        earlyExit,
        process.cwd(),
        'x'.repeat(16 * 1024 * 1024),
        new AbortController().signal,
        (chunk) => stderr.push(chunk),
      ),
    ).rejects.toMatchObject({ code: 'EPIPE' });
    expect(stderr).toEqual(['closed early']);
  });

  it('rejects resume and retry for opaque external ids', async () => {
    const host = new SessionSubagentHost({} as Session, 'main');
    const options = {
      parentToolCallId: 'call',
      prompt: 'continue',
      description: 'continue external',
      runInBackground: false,
      signal: new AbortController().signal,
    };
    await expect(host.resume('external-cli-123', options)).rejects.toThrow('cannot be resumed');
    await expect(host.retry('external-cli-123', options)).rejects.toThrow(
      'cannot be retried or resumed',
    );
  });
});
