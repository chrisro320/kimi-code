import { describe, expect, it } from 'vitest';

import {
  scrollbarGeometry,
  scrollOffsetForThumbStart,
  ViewportScrollbarComponent,
} from '#/tui/components/chrome/viewport-scrollbar';

describe('viewport scrollbar', () => {
  it('keeps the thumb at the bottom while following and moves it up with the ledger offset', () => {
    expect(scrollbarGeometry(10, { offset: 0, maxOffset: 90 })).toEqual({
      thumbStart: 9,
      thumbSize: 1,
      travel: 9,
    });
    expect(scrollbarGeometry(10, { offset: 45, maxOffset: 90 }).thumbStart).toBe(5);
    expect(scrollbarGeometry(10, { offset: 90, maxOffset: 90 }).thumbStart).toBe(0);
  });

  it('maps thumb dragging back to the same absolute ledger offset', () => {
    const geometry = scrollbarGeometry(10, { offset: 45, maxOffset: 90 });
    expect(scrollOffsetForThumbStart(geometry.thumbStart, geometry, 90)).toBe(40);
    expect(scrollOffsetForThumbStart(0, geometry, 90)).toBe(90);
    expect(scrollOffsetForThumbStart(geometry.travel, geometry, 90)).toBe(0);
  });

  it('renders exactly one terminal column and hides when no history exists', () => {
    const hidden = new ViewportScrollbarComponent(() => ({ offset: 0, maxOffset: 0 }), () => 5);
    expect(hidden.render(1)).toEqual([]);

    const visible = new ViewportScrollbarComponent(() => ({ offset: 0, maxOffset: 20 }), () => 5);
    expect(visible.render(1)).toHaveLength(5);
    expect(visible.render(1).every((line) => line.length > 0)).toBe(true);
  });
});
