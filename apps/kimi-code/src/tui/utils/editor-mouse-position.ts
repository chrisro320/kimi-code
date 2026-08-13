import { visibleWidth, wordWrapLine } from '@moonshot-ai/pi-tui';

export interface EditorCursorPosition {
  /** Index into the logical lines array. */
  readonly line: number;
  /** Character offset within that logical line. */
  readonly column: number;
}

export interface LocateEditorCursorParams {
  /** The editor's logical lines, before soft wrapping. */
  readonly lines: readonly string[];
  /** Usable text width, in terminal columns. */
  readonly width: number;
  /** Clicked row, 0-based, relative to the editor's first rendered row. */
  readonly screenRow: number;
  /** Clicked column, 0-based, relative to the editor's first text column. */
  readonly screenColumn: number;
}

/**
 * Maps a click inside the editor onto a cursor position.
 *
 * Soft wrapping is resolved with `wordWrapLine` — the same function the editor
 * renders through — because a second wrapping implementation would drift from
 * the rendered layout and put the cursor on the wrong character. `TextChunk`
 * carries `startIndex`, so a screen row maps back to a character offset without
 * re-deriving anything.
 *
 * Widths are measured with `visibleWidth` per grapheme, so a CJK character
 * counts as two columns and a ZWJ emoji stays a single cursor stop. Clicking
 * past the end of a row lands at that row's end; clicking below the last row
 * lands at the end of the text. Returns undefined only when there is nothing to
 * land on.
 */
export function locateEditorCursor(params: LocateEditorCursorParams): EditorCursorPosition | undefined {
  const { lines, width, screenRow, screenColumn } = params;
  if (lines.length === 0 || width <= 0 || screenRow < 0) return undefined;

  let rowsConsumed = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';
    const chunks = wordWrapLine(line, width);
    if (screenRow >= rowsConsumed + chunks.length) {
      rowsConsumed += chunks.length;
      continue;
    }

    const chunk = chunks[screenRow - rowsConsumed];
    if (!chunk) return undefined;
    return {
      line: lineIndex,
      column: offsetWithinChunk(line, chunk.startIndex, chunk.endIndex, screenColumn),
    };
  }

  // Below the last rendered row: land at the very end of the text.
  const lastIndex = lines.length - 1;
  return { line: lastIndex, column: (lines[lastIndex] ?? '').length };
}

/**
 * Walks the chunk one grapheme at a time, accumulating rendered width, and
 * returns the character offset whose cell the click landed in. A click on the
 * right half of a double-width grapheme still selects that grapheme's start,
 * matching how a terminal reports the cell.
 */
function offsetWithinChunk(line: string, startIndex: number, endIndex: number, screenColumn: number): number {
  if (screenColumn <= 0) return startIndex;

  const text = line.slice(startIndex, endIndex);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let consumedWidth = 0;
  let offset = startIndex;

  for (const { segment } of segmenter.segment(text)) {
    const segmentWidth = visibleWidth(segment);
    if (consumedWidth + segmentWidth > screenColumn) return offset;
    consumedWidth += segmentWidth;
    offset += segment.length;
  }

  // Past the last grapheme on this row.
  return endIndex;
}
