import { describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import { MODELS_SECTION } from '#/app/kosongConfig/configSection';

import { SUBAGENT_SECTION } from '#/session/subagent/configSection';
import { SessionSubagentRoutingService } from '#/session/subagent/routingService';

function stubConfig(sections: Record<string, unknown>): IConfigService {
  return {
    get: ((domain: string) => sections[domain]) as IConfigService['get'],
  } as unknown as IConfigService;
}

const models = {
  fast: { provider: 'local', model: 'fast-model' },
  precise: { provider: 'local', model: 'precise-model' },
};

describe('SessionSubagentRoutingService', () => {
  it('returns undefined when neither pool nor routing hits', async () => {
    const service = new SessionSubagentRoutingService(
      stubConfig({ [MODELS_SECTION]: models }),
    );
    await expect(service.resolveSpawnRoute('reviewer')).resolves.toBeUndefined();
  });

  it('resolves the static routing entry without a pool slot', async () => {
    const service = new SessionSubagentRoutingService(
      stubConfig({
        [MODELS_SECTION]: models,
        [SUBAGENT_SECTION]: {
          routing: { coder: { model: 'fast', thinkingEffort: 'high' } },
        },
      }),
    );
    await expect(service.resolveSpawnRoute('coder')).resolves.toEqual({
      route: { kind: 'internal', modelAlias: 'fast', thinkingEffort: 'high' },
    });
  });

  it('prefers the pool over the static routing entry', async () => {
    const service = new SessionSubagentRoutingService(
      stubConfig({
        [MODELS_SECTION]: models,
        [SUBAGENT_SECTION]: {
          routing: { coder: { model: 'precise' } },
          pools: { coder: [{ backend: 'kimi', model: 'fast' }] },
        },
      }),
    );
    const resolved = await service.resolveSpawnRoute('coder');
    expect(resolved?.route.modelAlias).toBe('fast');
    expect(resolved?.releasePoolSlot).toBeDefined();
    resolved?.releasePoolSlot?.();
  });

  it('rotates pool routes across spawns on the same service instance', async () => {
    const service = new SessionSubagentRoutingService(
      stubConfig({
        [MODELS_SECTION]: models,
        [SUBAGENT_SECTION]: {
          pools: {
            coder: [
              { backend: 'kimi', model: 'fast', weight: 3 },
              { backend: 'kimi', model: 'precise', weight: 1 },
            ],
          },
        },
      }),
    );
    const picks: Array<string | undefined> = [];
    for (let i = 0; i < 4; i++) {
      const resolved = await service.resolveSpawnRoute('coder');
      picks.push(resolved?.route.modelAlias);
      resolved?.releasePoolSlot?.();
    }
    // Smooth weighted round robin over a 3:1 split — only observable because
    // the pool instance persists across these four spawns.
    expect(picks).toEqual(['fast', 'fast', 'precise', 'fast']);
  });

  it('queues behind a saturated pool and grants the slot on release', async () => {
    const service = new SessionSubagentRoutingService(
      stubConfig({
        [MODELS_SECTION]: models,
        [SUBAGENT_SECTION]: {
          pools: { coder: [{ backend: 'kimi', model: 'fast', maxConcurrency: 1 }] },
        },
      }),
    );
    const first = await service.resolveSpawnRoute('coder');
    let granted = false;
    const pending = service.resolveSpawnRoute('coder').then((resolved) => {
      granted = true;
      return resolved;
    });
    await Promise.resolve();
    expect(granted).toBe(false);

    first?.releasePoolSlot?.();
    const second = await pending;
    expect(granted).toBe(true);
    expect(second?.route.modelAlias).toBe('fast');
    second?.releasePoolSlot?.();
  });

  it('releases the pool slot when route resolution fails', async () => {
    const service = new SessionSubagentRoutingService(
      stubConfig({
        [MODELS_SECTION]: models,
        [SUBAGENT_SECTION]: {
          pools: { coder: [{ backend: 'kimi', model: 'missing', maxConcurrency: 1 }] },
        },
      }),
    );
    await expect(service.resolveSpawnRoute('coder')).rejects.toThrow(
      'not defined in config.models',
    );
    // The failed acquire freed the slot — a leaked slot would leave this
    // second resolve queued behind max_concurrency=1 forever (test timeout).
    await expect(service.resolveSpawnRoute('coder')).rejects.toThrow(
      'not defined in config.models',
    );
  });
});
