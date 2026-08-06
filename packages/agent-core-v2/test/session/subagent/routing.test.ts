import { describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import { MODELS_SECTION } from '#/app/kosongConfig/configSection';

import { SUBAGENT_SECTION } from '#/session/subagent/configSection';
import { resolveRouteByNames, resolveSubagentRoute } from '#/session/subagent/routing';

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
