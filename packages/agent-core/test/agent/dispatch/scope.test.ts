import { describe, expect, it } from 'vitest';

import {
  normalizeScopeEntry,
  normalizeScopeList,
  scopesOverlap,
} from '../../../src/agent/dispatch/scope';

describe('dispatch scope', () => {
  it('normalizes workspace-relative entries', () => {
    expect(normalizeScopeEntry('./src\\agent//dispatch')).toEqual({
      ok: true,
      value: 'src/agent/dispatch',
    });
    expect(normalizeScopeList([' src/a.ts ', 'test/**/*.test.ts'])).toEqual({
      ok: true,
      value: ['src/a.ts', 'test/**/*.test.ts'],
    });
  });

  it.each(['/tmp/a', '~/a', 'C:\\repo\\a'])('rejects absolute scope %s', (scope) => {
    expect(normalizeScopeEntry(scope)).toMatchObject({ ok: false, error: 'malformed' });
  });

  it('rejects traversal and git control paths', () => {
    expect(normalizeScopeEntry('../outside')).toMatchObject({ ok: false, error: 'outside-repo' });
    expect(normalizeScopeEntry('src/.git/config')).toMatchObject({ ok: false, error: 'malformed' });
  });

  it('detects directory, descendant, and conservative glob overlap', () => {
    expect(scopesOverlap(['src/agent'], ['src/agent/index.ts'])).toBe(true);
    expect(scopesOverlap(['src/**/*.ts'], ['src/agent/index.ts'])).toBe(true);
    expect(scopesOverlap(['*.ts'], ['docs/readme.md'])).toBe(true);
    expect(scopesOverlap(['src/a.ts'], ['test/a.test.ts'])).toBe(false);
  });
});
