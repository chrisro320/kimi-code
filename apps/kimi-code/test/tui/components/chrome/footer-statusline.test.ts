import { describe, expect, it } from 'vitest';

import { buildStatuslineRow } from '#/tui/components/chrome/footer';
import { currentTheme } from '#/tui/theme';
import type { AppState } from '#/tui/types';
import { formatTokenCount } from '#/utils/usage/usage-format';

// Strip ANSI colour codes so assertions target the visible text only.
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

function makeState(patch: Partial<AppState>): AppState {
  return {
    statusline: { enabled: true },
    managedUsage: {
      summary: { label: 'Weekly limit', used: 56, limit: 100, resetHint: 'resets in 5d 6h 49m' },
      limits: [{ label: '5h limit', used: 7, limit: 100, resetHint: 'resets in 3h 49m' }],
      extraUsage: null,
    },
    lastCacheHit: 0.91,
    sessionCacheHit: 0.83,
    totalTokens: 536_000,
    ...patch,
  } as AppState;
}

describe('buildStatuslineRow', () => {
  it('renders weekly + 5h quota, both cache-hit ratios, and total tokens', () => {
    const row = stripAnsi(buildStatuslineRow(makeState({}), currentTheme.palette) ?? '');
    expect(row).toContain('7d 56%');
    expect(row).toContain('5h 7%');
    expect(row).toContain('cache 91%/83%');
    expect(row).toContain(`${formatTokenCount(536_000)} tok`);
  });

  it('shows compact reset hints in full form and drops them when compact', () => {
    const full = stripAnsi(buildStatuslineRow(makeState({}), currentTheme.palette) ?? '');
    expect(full).toContain('(5d6h)');
    expect(full).toContain('(3h49m)');
    const compact = stripAnsi(buildStatuslineRow(makeState({}), currentTheme.palette, true) ?? '');
    expect(compact).not.toContain('(5d6h)');
    expect(compact).toContain('7d 56%');
  });

  it('renders `--` for quota when no managed usage snapshot is available', () => {
    const row = stripAnsi(
      buildStatuslineRow(makeState({ managedUsage: null }), currentTheme.palette) ?? '',
    );
    expect(row).toContain('7d --');
    expect(row).toContain('5h --');
    // Local cache/token data is unaffected by a missing quota snapshot.
    expect(row).toContain('cache 91%/83%');
  });

  it('renders `--` for cache ratios that are not yet known', () => {
    const row = stripAnsi(
      buildStatuslineRow(
        makeState({ lastCacheHit: null, sessionCacheHit: null }),
        currentTheme.palette,
      ) ?? '',
    );
    expect(row).toContain('cache --/--');
  });

  it('returns null when the statusline is disabled', () => {
    expect(buildStatuslineRow(makeState({ statusline: { enabled: false } }), currentTheme.palette)).toBeNull();
  });
});
