import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APIConnectionError,
  APIContextOverflowError,
  APIProviderRateLimitError,
  APIStatusError,
} from '#/kosong/contract/errors';
import { emptyUsage } from '#/kosong/contract/usage';
import { IEventBus } from '#/app/event/eventBus';
import { retryBackoffDelays } from '#/_base/utils/retry';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnStepRetrying } from '#/agent/stepRetry/stepRetryService';

import { createTestAgent, llmGenerateServices, type TestAgentContext } from '../../harness';

const realSetTimeout = globalThis.setTimeout;

describe('stepRetry plugin', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function rpcEvents(name: string) {
    return ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === name);
  }

  async function runTurn(turnId: number, signal?: AbortSignal) {
    void ctx.dispatcher.dispatch(new TurnStarted({ turnId, origin: { kind: 'user' } }));
    const loop = ctx.get(IAgentLoopService);
    loop.enqueue(new ContinuationStepRequest());
    const resultPromise = loop.run({ turnId, signal });
    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let i = 0; i < 100; i += 1) {
      if (settled) break;
      await vi.runAllTimersAsync();
      if (!settled) {
        await new Promise((resolve) => realSetTimeout(resolve, 1));
      }
    }
    return resultPromise;
  }

  it('retries a retryable provider error and resumes the same step number', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIConnectionError('terminated');
        return {
          id: 'retry-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 2, truncated: false });
    expect(calls).toBe(2);
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          turnId: 1,
          step: 1,
          failedAttempt: 1,
          nextAttempt: 2,
          maxAttempts: 10,
          delayMs: expect.any(Number),
          errorName: 'APIConnectionError',
          errorMessage: 'terminated',
        }),
      }),
    ]);
    expect(
      rpcEvents('turn.step.started').map((event) => (event.args as { step: number }).step),
    ).toEqual([1, 2]);
    expect(rpcEvents('turn.step.interrupted')).toEqual([]);
    expect(ctx.contextData().history).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered' }],
      }),
    ]);
  });

  it('fails the turn after maxAttempts and reports the interruption only then', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIStatusError(429, 'slow down');
      }),
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(10);
    expect(rpcEvents('turn.step.retrying')).toHaveLength(9);
    expect(rpcEvents('turn.step.interrupted')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ reason: 'error', step: 10 }),
      }),
    ]);
  });

  it('honors the provider retry-after delay before retrying', async () => {
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) throw new APIProviderRateLimitError('slow down', null, 1);
        return {
          id: 'retry-after-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    void ctx.dispatcher.dispatch(new TurnStarted({ turnId: 1, origin: { kind: 'user' } }));
    const loop = ctx.get(IAgentLoopService);
    loop.enqueue(new ContinuationStepRequest());
    const result = await loop.run({ turnId: 1 });

    expect(result.type).toBe('completed');
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ delayMs: 1 }),
      }),
    ]);
  });

  it('does not retry a non-retryable error', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIStatusError(401, 'unauthorized');
      }),
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('cancels the turn when aborted during the backoff wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        throw new APIConnectionError('terminated');
      }),
    );
    ctx.get(IEventBus).subscribe(TurnStepRetrying, () => {
      controller.abort(new Error('stop'));
    });

    const result = await runTurn(1, controller.signal);

    expect(result.type).toBe('cancelled');
  });

  it('honors loop_control.max_attempts_per_step', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(llmGenerateServices(async () => {
      calls += 1;
      throw new APIConnectionError('terminated');
    }), {
      initialConfig: { loopControl: { maxAttemptsPerStep: 1 } },
    });

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(1);
    expect(rpcEvents('turn.step.retrying')).toEqual([]);
  });

  it('starts a fresh attempt budget on the next turn', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let failing = true;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        if (failing) {
          calls += 1;
          throw new APIConnectionError('terminated');
        }
        return {
          id: 'ok-response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const first = await runTurn(1);
    expect(first.type).toBe('failed');
    expect(calls).toBe(10);

    failing = false;
    const second = await runTurn(2);
    expect(second).toEqual({ type: 'completed', steps: 1, truncated: false });
  });

  it('retries a 401 capacity false alarm on a fixed 60s cadence with its own budget', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls <= 3) {
          throw new APIContextOverflowError(401, 'kimi-k2 supports only 262K context');
        }
        return {
          id: 'capacity-recovered',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const result = await runTurn(1);

    expect(result).toEqual({ type: 'completed', steps: 4, truncated: false });
    expect(calls).toBe(4);
    expect(rpcEvents('turn.step.retrying')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          failedAttempt: 1,
          nextAttempt: 2,
          maxAttempts: 11,
          delayMs: 60_000,
          errorName: 'APIContextOverflowError',
          statusCode: 401,
        }),
      }),
      expect.objectContaining({
        args: expect.objectContaining({ failedAttempt: 2, maxAttempts: 11, delayMs: 60_000 }),
      }),
      expect.objectContaining({
        args: expect.objectContaining({ failedAttempt: 3, maxAttempts: 11, delayMs: 60_000 }),
      }),
    ]);
  });

  it('keeps the 429 backoff curve untouched by the capacity channel', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        throw new APIStatusError(429, 'slow down');
      }),
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    expect(calls).toBe(10);
    const retrying = rpcEvents('turn.step.retrying');
    expect(retrying).toHaveLength(9);
    for (const [index, event] of retrying.entries()) {
      const args = event.args as { failedAttempt: number; maxAttempts: number; delayMs: number };
      // General channel numbering and budget — not the capacity channel's 11.
      expect(args.failedAttempt).toBe(index + 1);
      expect(args.maxAttempts).toBe(10);
      // Exponential ramp caps at 32s + 25% jitter: always below the fixed 60s
      // cadence a capacity retry would publish.
      expect(args.delayMs).toBeLessThan(60_000);
    }
  });

  it('does not spend the general attempts budget on capacity retries', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls === 1) {
          throw new APIContextOverflowError(401, 'kimi-k2 supports only 262K context');
        }
        throw new APIStatusError(429, 'slow down');
      }),
    );

    const result = await runTurn(1);

    expect(result.type).toBe('failed');
    // 1 capacity failure + 10 rate-limit failures: the 429s still get their
    // full 10-attempt general budget despite the earlier capacity retry.
    expect(calls).toBe(11);
    const retrying = rpcEvents('turn.step.retrying');
    expect(retrying).toHaveLength(10);
    expect(retrying[0]).toEqual(
      expect.objectContaining({
        args: expect.objectContaining({
          failedAttempt: 1,
          maxAttempts: 11,
          delayMs: 60_000,
          statusCode: 401,
        }),
      }),
    );
    for (const [index, event] of retrying.slice(1).entries()) {
      const args = event.args as { failedAttempt: number; maxAttempts: number; statusCode: number };
      expect(args.failedAttempt).toBe(index + 1);
      expect(args.maxAttempts).toBe(10);
      expect(args.statusCode).toBe(429);
    }
  });

  it('hands the error to overflow recovery once the capacity budget is spent', async () => {
    vi.useFakeTimers();
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        calls += 1;
        if (calls <= 11) {
          throw new APIContextOverflowError(401, 'kimi-k2 supports only 262K context');
        }
        if (calls === 12) {
          // Compaction summary call from overflow recovery.
          return {
            id: 'compaction-summary',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Compacted summary.' }],
              toolCalls: [],
            },
            usage: emptyUsage(),
            finishReason: 'completed',
            rawFinishReason: 'stop',
          };
        }
        return {
          id: 'post-compaction',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recovered after compaction' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );

    const result = await runTurn(1);

    // 10 capacity retries (10 x 60s), then the 11th failure falls through to
    // overflow recovery instead of failing the turn outright.
    const retrying = rpcEvents('turn.step.retrying');
    expect(retrying).toHaveLength(10);
    for (const event of retrying) {
      expect((event.args as { delayMs: number }).delayMs).toBe(60_000);
    }
    expect(rpcEvents('compaction.started')).not.toEqual([]);
    expect(result.type).not.toBe('failed');
  });
});

describe('retryBackoffDelays', () => {
  it('starts at 500 milliseconds and doubles with up to 25 percent jitter', () => {
    const delays = retryBackoffDelays(3);

    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(625);
    expect(delays[1]).toBeGreaterThanOrEqual(1_000);
    expect(delays[1]).toBeLessThanOrEqual(1_250);
  });

  it('caps high-attempt backoff at 32 seconds plus up to 25 percent jitter', () => {
    const delays = retryBackoffDelays(10);

    expect(delays).toHaveLength(9);
    expect(delays[6]).toBeGreaterThanOrEqual(32_000);
    expect(delays[6]).toBeLessThanOrEqual(40_000);
    expect(delays[8]).toBeGreaterThanOrEqual(32_000);
    expect(delays[8]).toBeLessThanOrEqual(40_000);
  });
});
