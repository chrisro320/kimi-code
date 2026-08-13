import type { Component } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

export interface ViewportScrollState {
  readonly offset: number;
  readonly maxOffset: number;
}

export interface ScrollbarGeometry {
  readonly thumbStart: number;
  readonly thumbSize: number;
  readonly travel: number;
}

export function scrollbarGeometry(height: number, state: ViewportScrollState): ScrollbarGeometry {
  const safeHeight = Math.max(1, Math.floor(height));
  const maxOffset = Math.max(0, state.maxOffset);
  const totalRows = safeHeight + maxOffset;
  const thumbSize = Math.max(1, Math.min(safeHeight, Math.round((safeHeight * safeHeight) / totalRows)));
  const travel = safeHeight - thumbSize;
  if (travel === 0 || maxOffset === 0) return { thumbStart: travel, thumbSize, travel };

  const clampedOffset = Math.max(0, Math.min(maxOffset, state.offset));
  const thumbStart = Math.round(((maxOffset - clampedOffset) / maxOffset) * travel);
  return { thumbStart, thumbSize, travel };
}

export function scrollOffsetForThumbStart(
  thumbStart: number,
  geometry: ScrollbarGeometry,
  maxOffset: number,
): number {
  if (geometry.travel <= 0 || maxOffset <= 0) return 0;
  const clampedStart = Math.max(0, Math.min(geometry.travel, thumbStart));
  return Math.round(maxOffset * (1 - clampedStart / geometry.travel));
}

export class ViewportScrollbarComponent implements Component {
  constructor(
    private readonly getState: () => ViewportScrollState,
    private readonly getHeight: () => number,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.getState();
    if (width < 1 || state.maxOffset <= 0) return [];

    const height = Math.max(1, this.getHeight());
    const geometry = scrollbarGeometry(height, state);
    return Array.from({ length: height }, (_, row) => {
      const inThumb = row >= geometry.thumbStart && row < geometry.thumbStart + geometry.thumbSize;
      return inThumb ? currentTheme.fg('primary', '┃') : currentTheme.fg('textDim', '│');
    });
  }
}
