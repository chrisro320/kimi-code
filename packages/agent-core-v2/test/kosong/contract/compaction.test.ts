import { describe, expect, it } from 'vitest';

import {
  canonicalizeLineage,
  replayContribution,
  sameOrigin,
  type CompactionCheckpoint,
} from '#/kosong/contract/compaction';

function checkpoint(replayInputTokens: CompactionCheckpoint['replayInputTokens']): CompactionCheckpoint {
  return {
    encrypted: 'opaque',
    itemType: 'compaction',
    lineage: { provider: 'p', model: 'm', baseUrl: 'https://api.example.com' },
    replayInputTokens,
  };
}

describe('canonicalizeLineage', () => {
  it('passes provider/model through and strips trailing slashes from the resolved base URL', () => {
    expect(
      canonicalizeLineage({
        provider: 'openai',
        model: 'gpt-x',
        effectiveBaseUrl: 'https://api.openai.com/v1/',
      }),
    ).toEqual({ provider: 'openai', model: 'gpt-x', baseUrl: 'https://api.openai.com/v1' });
  });

  it('does not normalize /v1 prefixes or casing', () => {
    const a = canonicalizeLineage({ provider: 'p', model: 'm', effectiveBaseUrl: 'https://api.example.com/v1' });
    const b = canonicalizeLineage({ provider: 'p', model: 'm', effectiveBaseUrl: 'https://api.example.com' });
    expect(sameOrigin(a, b)).toBe(false);
  });
});

describe('sameOrigin', () => {
  const base = { provider: 'p', model: 'm', baseUrl: 'https://api.example.com' };

  it('exact match is the same origin', () => {
    expect(sameOrigin(base, { ...base })).toBe(true);
  });

  it('provider mismatch is a different origin', () => {
    expect(sameOrigin(base, { ...base, provider: 'other' })).toBe(false);
  });

  it('model mismatch is a different origin', () => {
    expect(sameOrigin(base, { ...base, model: 'other' })).toBe(false);
  });

  it('baseUrl mismatch is a different origin', () => {
    expect(sameOrigin(base, { ...base, baseUrl: 'https://other.example.com' })).toBe(false);
  });

  it('trailing-slash spelling differences are tolerated', () => {
    expect(sameOrigin(base, { ...base, baseUrl: 'https://api.example.com/' })).toBe(true);
  });
});

describe('replayContribution', () => {
  it('measured books its figure with no diagnostic', () => {
    const contribution = replayContribution(checkpoint({ kind: 'measured', tokens: 500 }));
    expect(contribution.tokens).toBe(500);
    expect(contribution.diagnostic).toBeUndefined();
  });

  it('unknown books zero AND returns a diagnostic', () => {
    const contribution = replayContribution(checkpoint({ kind: 'unknown' }));
    expect(contribution.tokens).toBe(0);
    expect(contribution.diagnostic).toBeTypeOf('string');
    expect(contribution.diagnostic!.length).toBeGreaterThan(0);
  });
});
