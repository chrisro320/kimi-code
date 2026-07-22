import { describe, expect, it, vi } from 'vitest';

import type { KimiConfig, SubagentLauncher } from '../../src/config';
import type { Session } from '../../src/session';
import { runExternalSubagent, SessionSubagentHost } from '../../src/session/subagent-host';
import {
  materializeBackendArgs,
  resolveExternalSubagentLauncher,
  resolveRouteByNames,
  resolveSubagentRoute,
  parseExternalSubagentOutput,
  SubagentRoutePool,
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
      coder: { model: 'fast', thinkingEffort: 'high' },
      explore: { backend: 'custom-cli', model: 'precise', thinkingEffort: 'low' },
    },
    backends: {
      'custom-cli': {
        command: 'custom-agent',
        args: ['--model', '{model}', '--cwd={cwd}'],
        resumeArgs: ['--resume', '{session_id}', '--cwd={cwd}'],
      },
    },
  },
};

describe('resolveSubagentRoute', () => {
  it('falls back to internal parent inheritance when no route exists', () => {
    expect(resolveSubagentRoute(config, 'plan')).toEqual({
      kind: 'internal',
      modelAlias: undefined,
      thinkingEffort: undefined,
    });
  });

  it('resolves per-type models and allows a swarm override', () => {
    expect(resolveSubagentRoute(config, 'coder')).toEqual({
      kind: 'internal',
      modelAlias: 'fast',
      thinkingEffort: 'high',
    });
    expect(resolveSubagentRoute(config, 'coder', 'precise')).toEqual({
      kind: 'internal',
      modelAlias: 'precise',
      thinkingEffort: 'high',
    });
  });

  it('resolves external backend args without a shell', () => {
    const route = resolveSubagentRoute(config, 'explore');
    expect(route.kind).toBe('external');
    if (route.kind !== 'external') throw new Error('expected external route');
    expect(route).not.toHaveProperty('thinkingEffort');
    expect(materializeBackendArgs(route, '/workspace/project')).toEqual([
      '--model',
      'precise',
      '--cwd=/workspace/project',
    ]);
    expect(
      materializeBackendArgs(
        route,
        '/workspace/project',
        '',
        route.backend.resumeArgs,
        'session-123',
      ),
    ).toEqual(['--resume', 'session-123', '--cwd=/workspace/project']);
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

describe('resolveRouteByNames', () => {
  it('resolves the in-process route for undefined and for the "kimi" name', () => {
    expect(resolveRouteByNames(config, undefined, undefined)).toEqual({
      kind: 'internal',
      modelAlias: undefined,
      thinkingEffort: undefined,
    });
    expect(resolveRouteByNames(config, 'kimi', 'fast')).toEqual({
      kind: 'internal',
      modelAlias: 'fast',
      thinkingEffort: undefined,
    });
    expect(resolveRouteByNames(config, 'kimi', 'fast', 'low')).toEqual({
      kind: 'internal',
      modelAlias: 'fast',
      thinkingEffort: 'low',
    });
  });

  it('resolves an external route with a backend-native model name', () => {
    const route = resolveRouteByNames(config, 'custom-cli', 'Opus 4.8');
    expect(route).toMatchObject({ kind: 'external', backendName: 'custom-cli', modelAlias: 'Opus 4.8' });
  });

  it('requires an explicit enforced launcher for read-only external dispatch', () => {
    const route = resolveRouteByNames(config, 'custom-cli', 'Opus 4.8');
    if (route.kind !== 'external') throw new Error('expected external route');
    expect(resolveExternalSubagentLauncher(route, false)).toBe(route.backend);
    expect(() => resolveExternalSubagentLauncher(route, true)).toThrow(
      'does not define subagent.backends.<name>.read_only_launcher',
    );

    const readOnlyRoute = resolveRouteByNames({
      ...config,
      subagent: {
        ...config.subagent,
        backends: {
          'custom-cli': {
            ...config.subagent!.backends!['custom-cli']!,
            readOnlyLauncher: {
              command: 'custom-agent-ro',
              args: ['--tools=', '--model', '{model}'],
              resumeArgs: ['--tools=', '--resume', '{session_id}'],
              sandbox: { filesystem: 'read_only', network: 'none' },
            },
          },
        },
      },
    }, 'custom-cli', 'Opus 4.8');
    if (readOnlyRoute.kind !== 'external') throw new Error('expected external route');
    expect(resolveExternalSubagentLauncher(readOnlyRoute, true)).toEqual({
      command: 'custom-agent-ro',
      args: ['--tools=', '--model', '{model}'],
      resumeArgs: ['--tools=', '--resume', '{session_id}'],
      sandbox: { filesystem: 'read_only', network: 'none' },
    });
  });

  it('fails closed when a read-only launcher lacks sandbox proof or enforcement markers', () => {
    const routeWith = (readOnlyLauncher: SubagentLauncher) => {
      const route = resolveRouteByNames({
        ...config,
        subagent: {
          ...config.subagent,
          backends: {
            'custom-cli': {
              ...config.subagent!.backends!['custom-cli']!,
              readOnlyLauncher,
            },
          },
        },
      }, 'custom-cli', 'Opus 4.8');
      if (route.kind !== 'external') throw new Error('expected external route');
      return route;
    };

    expect(() => resolveExternalSubagentLauncher(routeWith({
      command: 'custom-agent-ro',
      args: ['--read-only'],
    }), true)).toThrow('sandbox.filesystem = "read_only"');

    expect(() => resolveExternalSubagentLauncher(routeWith({
      command: 'custom-agent-ro',
      args: ['--model', '{model}'],
      sandbox: { filesystem: 'read_only' },
    }), true)).toThrow('verifiable read-only enforcement marker');

    expect(() => resolveExternalSubagentLauncher(routeWith({
      command: 'custom-agent-ro',
      args: ['--read-only'],
      resumeArgs: ['--resume', '{session_id}'],
      sandbox: { filesystem: 'read_only' },
    }), true)).toThrow('read_only_launcher.resume_args');
  });

  it('validates only internal model aliases and validates every backend name', () => {
    expect(() => resolveRouteByNames(config, undefined, 'missing')).toThrow(
      'not defined in config.models',
    );
    expect(() => resolveRouteByNames(config, 'missing-backend', undefined)).toThrow(
      'not defined in subagent.backends',
    );
  });
});

describe('SubagentRoutePool', () => {
  it('requires at least one route entry', () => {
    expect(() => new SubagentRoutePool([])).toThrow('at least one route entry');
  });

  it('rotates through routes using deterministic smooth weighted round robin', () => {
    const pool = new SubagentRoutePool([
      { backend: 'a', weight: 3 },
      { backend: 'b', weight: 1 },
    ]);
    const picks = Array.from({ length: 4 }, () => {
      const acquired = pool.acquire();
      acquired.release();
      return acquired.route.backend;
    });
    // nginx-style smooth weighted round robin over a 3:1 split: A,A,B,A.
    expect(picks).toEqual(['a', 'a', 'b', 'a']);
  });

  it('treats a missing weight as 1', () => {
    const pool = new SubagentRoutePool([{ backend: 'a' }, { backend: 'b' }]);
    const picks = Array.from({ length: 4 }, () => {
      const acquired = pool.acquire();
      acquired.release();
      return acquired.route.backend;
    });
    expect(picks).toEqual(['a', 'b', 'a', 'b']);
  });

  it('filters routes that are at their max_concurrency limit', () => {
    const pool = new SubagentRoutePool([{ backend: 'a', maxConcurrency: 1 }, { backend: 'b' }]);
    const first = pool.acquire();
    expect(first.route.backend).toBe('a');
    // `a` is now saturated, so `b` is the only route with capacity left.
    const second = pool.acquire();
    expect(second.route.backend).toBe('b');
  });

  it('throws when every route is at its max_concurrency limit', () => {
    const pool = new SubagentRoutePool([{ backend: 'a', maxConcurrency: 1 }]);
    const acquired = pool.acquire();
    expect(() => pool.acquire()).toThrow('exhausted');
    acquired.release();
    expect(pool.acquire().route.backend).toBe('a');
  });

  it('release is idempotent', () => {
    const pool = new SubagentRoutePool([{ backend: 'a', maxConcurrency: 1 }]);
    const first = pool.acquire();
    first.release();
    first.release();
    const second = pool.acquire();
    expect(() => pool.acquire()).toThrow('exhausted');
    second.release();
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

    const secret = 'SUPERSECRET_BACKEND_STDERR_999999';
    const secretFailing = {
      ...nodeRoute,
      backend: {
        command: process.execPath,
        args: ['-e', `process.stderr.write('api_key=${secret}');process.exit(9)`],
      },
    };
    await expect(
      runExternalSubagent(secretFailing, process.cwd(), '', new AbortController().signal, () => {}),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('exited with code 9');
      expect((error as Error).message).toContain('[REDACTED_SECRET]');
      expect((error as Error).message).not.toContain(secret);
      return true;
    });

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

  it('rejects resume and retry when external metadata is unavailable', async () => {
    const host = new SessionSubagentHost({ metadata: { agents: {} } } as Session, 'main');
    const options = {
      parentToolCallId: 'call',
      prompt: 'continue',
      description: 'continue external',
      runInBackground: false,
      signal: new AbortController().signal,
    };
    await expect(host.resume('external-cli-123', options)).rejects.toThrow('resumable session metadata');
    await expect(host.retry('external-cli-123', options)).rejects.toThrow('resumable session metadata');
  });
});
