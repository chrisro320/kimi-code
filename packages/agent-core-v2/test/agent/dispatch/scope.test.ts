import { describe, expect, it } from 'vitest';

import { isEditingCapableProfile } from '#/agent/dispatch/profile';
import {
  normalizeScopeEntry,
  normalizeScopeList,
  resolveEditingDispatchScope,
  scopesOverlap,
} from '#/agent/dispatch/scope';

describe('normalizeScopeEntry (v1 parity)', () => {
  it('trims and normalizes separators and dot segments', () => {
    expect(normalizeScopeEntry('  src//./pkg\\mod  ')).toEqual({ ok: true, value: 'src/pkg/mod' });
  });

  it('rejects empty entries', () => {
    expect(normalizeScopeEntry('   ')).toMatchObject({ ok: false, error: 'malformed' });
    expect(normalizeScopeEntry('./.')).toMatchObject({ ok: false, error: 'malformed' });
  });

  it('rejects absolute paths, home paths, and Windows drives', () => {
    expect(normalizeScopeEntry('/etc/passwd')).toMatchObject({ ok: false, error: 'malformed' });
    expect(normalizeScopeEntry('~/src')).toMatchObject({ ok: false, error: 'malformed' });
    expect(normalizeScopeEntry('C:\\src')).toMatchObject({ ok: false, error: 'malformed' });
    expect(normalizeScopeEntry('d:/src')).toMatchObject({ ok: false, error: 'malformed' });
  });

  it('rejects entries escaping the workspace root', () => {
    expect(normalizeScopeEntry('../outside')).toMatchObject({ ok: false, error: 'outside-repo' });
    expect(normalizeScopeEntry('src/../../outside')).toMatchObject({
      ok: false,
      error: 'outside-repo',
    });
  });

  it('rejects VCS metadata in any segment, case-insensitively', () => {
    expect(normalizeScopeEntry('.git')).toMatchObject({ ok: false, error: 'malformed' });
    expect(normalizeScopeEntry('src/.Git/config')).toMatchObject({ ok: false, error: 'malformed' });
  });

  it('keeps glob metacharacters intact', () => {
    expect(normalizeScopeEntry('src/**/*.ts')).toEqual({ ok: true, value: 'src/**/*.ts' });
  });
});

describe('normalizeScopeList (v1 parity)', () => {
  it('normalizes every entry and preserves order', () => {
    expect(normalizeScopeList(['b/./y', 'a\\x'])).toEqual({ ok: true, value: ['b/y', 'a/x'] });
  });

  it('fails on the first invalid entry', () => {
    const result = normalizeScopeList(['ok', '..', 'also-ok']);
    expect(result).toMatchObject({ ok: false, error: 'outside-repo' });
  });
});

describe('scopesOverlap (v1 parity)', () => {
  it('treats identical and prefix-contained paths as overlapping', () => {
    expect(scopesOverlap(['src'], ['src'])).toBe(true);
    expect(scopesOverlap(['src'], ['src/pkg'])).toBe(true);
    expect(scopesOverlap(['src/pkg'], ['src'])).toBe(true);
  });

  it('treats sibling paths as non-overlapping', () => {
    expect(scopesOverlap(['src/a'], ['src/b'])).toBe(false);
    // 'src2' is not under 'src' — segment-boundary match, not raw prefix.
    expect(scopesOverlap(['src'], ['src2'])).toBe(false);
  });

  it('compares glob entries by their static prefix', () => {
    expect(scopesOverlap(['src/**/*.ts'], ['src/pkg'])).toBe(true);
    expect(scopesOverlap(['src/**/*.ts'], ['docs'])).toBe(false);
  });

  it('treats a root-level (ambiguous) glob as conflicting with anything', () => {
    expect(scopesOverlap(['*.ts'], ['any/thing'])).toBe(true);
    expect(scopesOverlap(['**/*'], ['src'])).toBe(true);
  });

  it('checks every pair across both lists', () => {
    expect(scopesOverlap(['a', 'b'], ['c', 'b/x'])).toBe(true);
    expect(scopesOverlap(['a', 'b'], ['c', 'd'])).toBe(false);
  });

  it('compares by code unit, not collation (fbc784ec0)', () => {
    // Collation folds punctuation/case; code-unit comparison must not.
    expect(scopesOverlap(['w-x.txt'], ['w_x.txt'])).toBe(false);
    expect(scopesOverlap(['Src'], ['src'])).toBe(false);
  });
});

describe('isEditingCapableProfile (v1 parity)', () => {
  it('is editing-capable with native edit tools or MCP grants matching ctx_patch', () => {
    expect(isEditingCapableProfile({ tools: ['Read', 'Write'] })).toBe(true);
    expect(isEditingCapableProfile({ tools: ['Edit'] })).toBe(true);
    expect(isEditingCapableProfile({ tools: ['mcp__lean-ctx__ctx_patch'] })).toBe(true);
    expect(isEditingCapableProfile({ tools: ['mcp__lean-ctx__*'] })).toBe(true);
    expect(isEditingCapableProfile({ tools: ['mcp__*'] })).toBe(true);
  });

  it('is read-only without a native or MCP editing grant', () => {
    expect(isEditingCapableProfile({ tools: ['Read', 'Grep', 'Bash'] })).toBe(false);
    expect(isEditingCapableProfile({ tools: ['mcp__github__*'] })).toBe(false);
    expect(isEditingCapableProfile({ tools: [] })).toBe(false);
  });
});

describe('resolveEditingDispatchScope (v1 parity)', () => {
  it('refuses an editing dispatch that declares no scope', () => {
    const message = 'An editing-capable dispatch requires at least one scope entry.';
    expect(resolveEditingDispatchScope(true, undefined)).toEqual({
      ok: false,
      error: 'malformed',
      message,
    });
    expect(resolveEditingDispatchScope(true, [])).toEqual({
      ok: false,
      error: 'malformed',
      message,
    });
  });

  it('normalizes a declared editing scope', () => {
    expect(resolveEditingDispatchScope(true, ['  src//./pkg  ', 'docs'])).toEqual({
      ok: true,
      value: ['src/pkg', 'docs'],
    });
  });

  it('propagates the first invalid entry instead of silently dropping it', () => {
    expect(resolveEditingDispatchScope(true, ['src', '/etc/passwd'])).toMatchObject({
      ok: false,
      error: 'malformed',
    });
  });

  it('leaves a read-only dispatch unconstrained', () => {
    expect(resolveEditingDispatchScope(false, undefined)).toEqual({ ok: true, value: [] });
    expect(resolveEditingDispatchScope(false, [])).toEqual({ ok: true, value: [] });
  });
});
