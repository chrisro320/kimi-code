import { describe, expect, it } from 'vitest';

import {
  isThinkingOn,
  thinkingEffortFromConfig,
  thinkingEffortToConfig,
} from '@/tui/utils/thinking-config';

describe('thinkingEffortToConfig', () => {
  it.each([
    ['off', { enabled: false }],
    // 'on' is the boolean-model on-signal, not a declared effort. It must not
    // be persisted as `thinking.effort` — boolean models have no effort concept
    // and resolve back to 'on' at runtime via defaultThinkingEffortFor.
    ['on', { enabled: true }],
    ['low', { enabled: true, effort: 'low' }],
    ['high', { enabled: true, effort: 'high' }],
    ['max', { enabled: true, effort: 'max' }],
  ] as const)('maps %s → %o without model efforts', (effort, expected) => {
    expect(thinkingEffortToConfig(effort)).toEqual(expected);
  });

  it.each([
    // The model's highest declared level (last support_efforts entry) is
    // session-only; anything below it persists as the global default.
    ['low', { enabled: true, effort: 'low' }],
    ['high', { enabled: true, effort: 'high' }],
    ['max', { enabled: true }],
    // Undeclared values persist as-is (the provider validates them).
    ['ultra', { enabled: true, effort: 'ultra' }],
  ] as const)('maps %s → %o for [low, high, max]', (effort, expected) => {
    expect(thinkingEffortToConfig(effort, ['low', 'high', 'max'])).toEqual(expected);
  });

  it('treats a single declared level as the top tier', () => {
    expect(thinkingEffortToConfig('max', ['max'])).toEqual({ enabled: true });
  });

  // Without this, a model whose top tier is what the user wants (v4flash
  // declares only [high, max]) can never have that tier stored: /effort reports
  // "Thinking set to max" and config.toml keeps whatever it had, so the next
  // launch silently drops back.
  it('persists the top tier when the user chose the effort explicitly', () => {
    expect(
      thinkingEffortToConfig('max', ['high', 'max'], { explicitChoice: true }),
    ).toEqual({ enabled: true, effort: 'max' });
  });

  it('still withholds the top tier when the effort was only carried along', () => {
    expect(
      thinkingEffortToConfig('max', ['high', 'max'], { explicitChoice: false }),
    ).toEqual({ enabled: true });
  });

  it.each([
    ['off', { enabled: false }],
    ['on', { enabled: true }],
  ] as const)('leaves %s alone under an explicit choice', (effort, expected) => {
    expect(thinkingEffortToConfig(effort, ['high', 'max'], { explicitChoice: true })).toEqual(
      expected,
    );
  });
});

describe('isThinkingOn', () => {
  it.each([
    ['off', false],
    ['on', true],
    ['low', true],
    ['high', true],
    ['max', true],
  ] as const)('%s → %s', (effort, expected) => {
    expect(isThinkingOn(effort)).toBe(expected);
  });
});

describe('thinkingEffortFromConfig', () => {
  it.each([
    [undefined, undefined],
    [{}, undefined],
    // enabled with no concrete effort → let the model's own default apply.
    [{ enabled: true }, undefined],
    [{ enabled: false }, 'off'],
    [{ enabled: true, effort: 'high' }, 'high'],
    // effort is honored even when enabled is not explicitly set.
    [{ effort: 'max' }, 'max'],
  ] as const)('%o → %s', (config, expected) => {
    expect(thinkingEffortFromConfig(config)).toBe(expected);
  });
});
