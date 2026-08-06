import { describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import { MODELS_SECTION } from '#/app/kosongConfig/configSection';

import { SUBAGENT_SECTION } from '#/session/subagent/configSection';
import {
  resolveRouteByNames,
  resolveSubagentRoute,
  SubagentRoutePool,
} from '#/session/subagent/routing';

function stubConfig(sections: Record<string, unknown>): IConfigService {
  return {
    get: ((domain: string) => sections[domain]) as IConfigService['get'],
  } as unknown as IConfigService;
}

const config = stubConfig({
  [MODELS_SECTION]: {
    fast: { provider: 'local', model: 'fast-model' },
    precise: { provider: 'local', model: 'precise-model' },
  },
  [SUBAGENT_SECTION]: {
    routing: {
      coder: { backend: 'kimi', model: 'fast', thinkingEffort: 'high' },
      plan: { model: 'precise' },
      explore: { backend: 'custom-cli', model: 'precise', thinkingEffort: 'low' },
    },
  },
});

describe('resolveSubagentRoute', () => {
  it('falls back to internal parent inheritance when no route exists', () => {
    expect(resolveSubagentRoute(config, 'reviewer')).toEqual({
      kind: 'internal',
      modelAlias: undefined,
      thinkingEffort: undefined,
    });
  });

  it('resolves per-profile models and allows a spawn-time override', () => {
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

  it('treats an omitted backend as the in-process route', () => {
    expect(resolveSubagentRoute(config, 'plan')).toEqual({
      kind: 'internal',
      modelAlias: 'precise',
      thinkingEffort: undefined,
    });
  });

  it('rejects unknown model aliases with the v1 error message', () => {
    expect(() => resolveSubagentRoute(config, 'coder', 'missing')).toThrow(
      'Subagent model alias "missing" is not defined in config.models.',
    );
    expect(() =>
      resolveSubagentRoute(
        stubConfig({
          [MODELS_SECTION]: { fast: {} },
          [SUBAGENT_SECTION]: { routing: { coder: { model: 'missing' } } },
        }),
        'coder',
      ),
    ).toThrow('Subagent model alias "missing" is not defined in config.models.');
  });

  it('rejects a non-kimi backend loudly instead of falling back to internal', () => {
    expect(() => resolveSubagentRoute(config, 'explore')).toThrow(
      'Subagent backend "custom-cli" is an external backend; external subagent backends are not implemented in the v2 engine yet',
    );
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

  it('validates only internal model aliases and rejects every external backend name', () => {
    expect(() => resolveRouteByNames(config, undefined, 'missing')).toThrow(
      'not defined in config.models',
    );
    expect(() => resolveRouteByNames(config, 'missing-backend', undefined)).toThrow(
      'external backend',
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

  it('keeps selection frequency proportional to weight over many picks', () => {
    const pool = new SubagentRoutePool([
      { backend: 'a', weight: 3 },
      { backend: 'b', weight: 1 },
    ]);
    let a = 0;
    let b = 0;
    for (let i = 0; i < 400; i++) {
      const acquired = pool.acquire();
      if (acquired.route.backend === 'a') a++;
      else b++;
      acquired.release();
    }
    const ratio = a / b;
    expect(ratio).toBeGreaterThanOrEqual(2.85);
    expect(ratio).toBeLessThanOrEqual(3.15);
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

  it('queues acquireQueued behind a saturated pool and grants the slot on release', async () => {
    const pool = new SubagentRoutePool([{ backend: 'a', maxConcurrency: 1 }]);
    const first = pool.acquire();

    let granted = false;
    const pending = pool.acquireQueued().then((acquired) => {
      granted = true;
      return acquired;
    });
    await Promise.resolve();
    expect(granted).toBe(false);

    first.release();
    const second = await pending;
    expect(granted).toBe(true);
    expect(second.route.backend).toBe('a');
    second.release();
  });

  it('serves queued waiters in FIFO order', async () => {
    const pool = new SubagentRoutePool([{ backend: 'a', maxConcurrency: 1 }]);
    const first = pool.acquire();
    const order: string[] = [];
    const waiterA = pool.acquireQueued().then((acquired) => {
      order.push('a');
      return acquired;
    });
    const waiterB = pool.acquireQueued().then((acquired) => {
      order.push('b');
      return acquired;
    });

    first.release();
    const secondA = await waiterA;
    secondA.release();
    const secondB = await waiterB;
    secondB.release();
    expect(order).toEqual(['a', 'b']);
  });

  it('rejects a queued acquireQueued when the abort signal fires', async () => {
    const pool = new SubagentRoutePool([{ backend: 'a', maxConcurrency: 1 }]);
    const first = pool.acquire();
    const controller = new AbortController();
    const pending = pool.acquireQueued(controller.signal);

    controller.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');

    // The aborted waiter must not hold a slot: the next queued acquire gets it.
    const next = pool.acquireQueued();
    first.release();
    (await next).release();
  });

  it('rejects acquireQueued immediately when the signal is already aborted', async () => {
    const pool = new SubagentRoutePool([{ backend: 'a', maxConcurrency: 1 }]);
    pool.acquire();
    const controller = new AbortController();
    controller.abort(new Error('already done'));
    await expect(pool.acquireQueued(controller.signal)).rejects.toThrow('already done');
  });
});
