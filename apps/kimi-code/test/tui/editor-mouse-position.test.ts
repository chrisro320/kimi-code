import { describe, expect, it } from 'vitest';

import { locateEditorCursor } from '#/tui/utils/editor-mouse-position';

describe('locateEditorCursor', () => {
  it('maps a click on a plain line', () => {
    expect(
      locateEditorCursor({ lines: ['hello world'], width: 40, screenRow: 0, screenColumn: 6 }),
    ).toEqual({ line: 0, column: 6 });
  });

  it('maps clicks across multiple logical lines', () => {
    const lines = ['first', 'second', 'third'];
    expect(locateEditorCursor({ lines, width: 40, screenRow: 1, screenColumn: 2 })).toEqual({
      line: 1,
      column: 2,
    });
    expect(locateEditorCursor({ lines, width: 40, screenRow: 2, screenColumn: 0 })).toEqual({
      line: 2,
      column: 0,
    });
  });

  it('resolves soft-wrapped rows back to the logical line', () => {
    // Width 10 forces this single logical line across several screen rows.
    const lines = ['aaaa bbbb cccc dddd'];
    const first = locateEditorCursor({ lines, width: 10, screenRow: 0, screenColumn: 0 });
    const second = locateEditorCursor({ lines, width: 10, screenRow: 1, screenColumn: 0 });

    expect(first).toEqual({ line: 0, column: 0 });
    expect(second?.line).toBe(0);
    // The second screen row must start further into the same logical line.
    expect(second?.column).toBeGreaterThan(0);
  });

  it('counts CJK characters as two columns', () => {
    // Each character is two cells wide, so column 4 is the third character.
    expect(
      locateEditorCursor({ lines: ['中文字測試'], width: 40, screenRow: 0, screenColumn: 4 }),
    ).toEqual({ line: 0, column: 2 });
  });

  it('treats a ZWJ emoji as a single cursor stop', () => {
    // Family emoji: one grapheme, several code units.
    const family = '👨‍👩‍👧';
    const lines = [`${family}ab`];
    const afterEmoji = locateEditorCursor({ lines, width: 40, screenRow: 0, screenColumn: 2 });

    expect(afterEmoji?.line).toBe(0);
    expect(afterEmoji?.column).toBe(family.length);
  });

  it('lands at the row end when clicking past the text', () => {
    expect(
      locateEditorCursor({ lines: ['abc'], width: 40, screenRow: 0, screenColumn: 99 }),
    ).toEqual({ line: 0, column: 3 });
  });

  it('lands at the end of the text when clicking below the last row', () => {
    expect(
      locateEditorCursor({ lines: ['abc', 'de'], width: 40, screenRow: 9, screenColumn: 0 }),
    ).toEqual({ line: 1, column: 2 });
  });

  it('returns undefined for degenerate input', () => {
    expect(locateEditorCursor({ lines: [], width: 40, screenRow: 0, screenColumn: 0 })).toBeUndefined();
    expect(locateEditorCursor({ lines: ['a'], width: 0, screenRow: 0, screenColumn: 0 })).toBeUndefined();
    expect(locateEditorCursor({ lines: ['a'], width: 40, screenRow: -1, screenColumn: 0 })).toBeUndefined();
  });
});
