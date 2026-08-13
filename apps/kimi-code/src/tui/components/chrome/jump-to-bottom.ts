import type { Component } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

export const JUMP_TO_BOTTOM_HINT = 'Jump to bottom (ctrl+End) ↓';
export const JUMP_TO_BOTTOM_WIDTH = JUMP_TO_BOTTOM_HINT.length;

export function isJumpToBottomHit(
  column: number,
  row: number,
  terminalColumns: number,
  terminalRows: number,
): boolean {
  if (terminalColumns < JUMP_TO_BOTTOM_WIDTH) return false;
  const left = Math.floor((terminalColumns - JUMP_TO_BOTTOM_WIDTH) / 2);
  const overlayRow = Math.max(0, terminalRows - 4);
  return row === overlayRow && column >= left && column < left + JUMP_TO_BOTTOM_WIDTH;
}

export class JumpToBottomComponent implements Component {
  constructor(private readonly isVisible: () => boolean) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.isVisible() || width < JUMP_TO_BOTTOM_WIDTH) return [];
    return [currentTheme.boldFg('warning', JUMP_TO_BOTTOM_HINT)];
  }
}
