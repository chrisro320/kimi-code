import { describe, expect, it } from 'vitest';

import {
  JUMP_TO_BOTTOM_HINT,
  JUMP_TO_BOTTOM_WIDTH,
  isJumpToBottomHit,
  JumpToBottomComponent,
} from '#/tui/components/chrome/jump-to-bottom';

describe('JumpToBottomComponent', () => {
  it('renders only while the managed viewport is scrolled back', () => {
    let visible = false;
    const component = new JumpToBottomComponent(() => visible);

    expect(component.render(JUMP_TO_BOTTOM_WIDTH)).toEqual([]);
    visible = true;
    expect(component.render(JUMP_TO_BOTTOM_WIDTH)).toHaveLength(1);
  });

  it('renders a compact label for bottom-center overlay placement', () => {
    const component = new JumpToBottomComponent(() => true);
    const line = component.render(JUMP_TO_BOTTOM_WIDTH)[0] ?? '';

    expect(line).toContain(JUMP_TO_BOTTOM_HINT);
    expect(component.render(JUMP_TO_BOTTOM_WIDTH - 1)).toEqual([]);
  });

  it('matches exactly the clickable bottom-center overlay rectangle', () => {
    const left = Math.floor((80 - JUMP_TO_BOTTOM_WIDTH) / 2);
    expect(isJumpToBottomHit(left, 20, 80, 24)).toBe(true);
    expect(isJumpToBottomHit(left + JUMP_TO_BOTTOM_WIDTH - 1, 20, 80, 24)).toBe(true);
    expect(isJumpToBottomHit(left - 1, 20, 80, 24)).toBe(false);
    expect(isJumpToBottomHit(left, 21, 80, 24)).toBe(false);
  });

  it('has no invisible hit target when the terminal is too narrow to render', () => {
    const width = JUMP_TO_BOTTOM_WIDTH - 1;
    const component = new JumpToBottomComponent(() => true);
    expect(component.render(width)).toEqual([]);
    expect(isJumpToBottomHit(0, 20, width, 24)).toBe(false);
    expect(isJumpToBottomHit(width - 1, 20, width, 24)).toBe(false);
  });
});
