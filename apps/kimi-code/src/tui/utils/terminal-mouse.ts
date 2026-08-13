import { Key, matchesKey } from '@moonshot-ai/pi-tui';

import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { isJumpToBottomHit } from '#/tui/components/chrome/jump-to-bottom';
import { scrollbarGeometry, scrollOffsetForThumbStart } from '#/tui/components/chrome/viewport-scrollbar';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import {
  DISABLE_TERMINAL_MOUSE_REPORTING,
  ENABLE_TERMINAL_MOUSE_REPORTING,
  SGR_MOUSE_REPORT,
} from '#/tui/constant/terminal';
import type { TUIState } from '#/tui/tui-state';

export {
  DISABLE_TERMINAL_MOUSE_REPORTING,
  ENABLE_TERMINAL_MOUSE_REPORTING,
  SGR_MOUSE_REPORT,
} from '#/tui/constant/terminal';

/** Bit 6 of the button field marks a wheel report; 64 is up, 65 is down. */
const WHEEL_FLAG = 0b100_0000;
/** Bit 5 marks motion; low bits identify the held button or 3 for hover. */
const MOTION_FLAG = 0b10_0000;
const SHIFT_FLAG = 0b100;
const META_FLAG = 0b1000;
const CTRL_FLAG = 0b1_0000;
/** The button itself lives in the low two bits: 0 left, 1 middle, 2 right. */
const BUTTON_MASK = 0b11;

export type TerminalMouseButton = 'left' | 'middle' | 'right';

interface TerminalMouseEventBase {
  /** 1-based, as reported by the terminal. */
  readonly column: number;
  readonly row: number;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly ctrl: boolean;
}

export type TerminalMouseEvent =
  | (TerminalMouseEventBase & {
      readonly kind: 'press' | 'release';
      readonly button: TerminalMouseButton;
    })
  | (TerminalMouseEventBase & {
      readonly kind: 'move';
      readonly button: TerminalMouseButton | 'none';
    })
  | (TerminalMouseEventBase & {
      readonly kind: 'wheel';
      readonly direction: 'up' | 'down';
    });

const BUTTONS: readonly TerminalMouseButton[] = ['left', 'middle', 'right'];

/**
 * Decodes a single SGR mouse report. Returns undefined for anything else, so
 * callers can pass every input sequence through without pre-filtering.
 *
 * Only SGR is recognised: we are the ones enabling 1006, so every report we ask
 * for arrives in that encoding. The legacy `ESC [ M` form is left alone.
 */
export function decodeTerminalMouseEvent(data: string): TerminalMouseEvent | undefined {
  const match = SGR_MOUSE_REPORT.exec(data);
  if (!match) return undefined;

  const raw = Number(match[1]);
  const column = Number(match[2]);
  const row = Number(match[3]);
  if (!Number.isFinite(raw) || !Number.isFinite(column) || !Number.isFinite(row)) return undefined;

  const shift = (raw & SHIFT_FLAG) !== 0;
  const meta = (raw & META_FLAG) !== 0;
  const ctrl = (raw & CTRL_FLAG) !== 0;

  const base = { column, row, shift, meta, ctrl };
  if ((raw & WHEEL_FLAG) !== 0) {
    return {
      ...base,
      kind: 'wheel',
      direction: (raw & BUTTON_MASK) === 0 ? 'up' : 'down',
    };
  }
  if ((raw & MOTION_FLAG) !== 0) {
    return {
      ...base,
      kind: 'move',
      button: BUTTONS[raw & BUTTON_MASK] ?? 'none',
    };
  }

  return {
    ...base,
    kind: match[4] === 'M' ? 'press' : 'release',
    button: BUTTONS[raw & BUTTON_MASK] ?? 'left',
  };
}

/**
 * Enables SGR mouse reporting for the lifetime of the returned disposer, and
 * consumes every mouse report so the bytes never reach the editor.
 *
 * `onEvent` is where a consumer (wheel scrolling, click-to-position) hooks in;
 * reports are consumed whether or not it handles them, because a half-decoded
 * report leaking into `handleInput` shows up as garbage characters in the input
 * box.
 */
/**
 * Rows advanced per wheel notch, matching the common terminal default.
 */
export const WHEEL_SCROLL_ROWS = 3;
export const SELECTION_AUTOSCROLL_INTERVAL_MS = 50;

export function isManagedMouseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['KIMI_TUI_NO_MOUSE'] !== '1';
}

/**
 * Wires the wheel to the TUI's own viewport scrolling and `ctrl+end` to jumping
 * back to the bottom.
 *
 * Enabling mouse reporting takes the wheel away from the terminal's scrollback,
 * so the TUI must provide the scrolling itself or the wheel simply stops
 * working. Typing deliberately does *not* snap back: an input line stays usable
 * while scrolled up, and new output must not yank the reader away from what they
 * are reading — the same contract `tail -f` has. `ctrl+end` is the explicit way
 * back, surfaced in the UI whenever `userScrollOffset > 0`.
 */
export interface ViewportScrollControlOptions {
  readonly copyText?: (text: string) => void | Promise<unknown>;
}

export function installViewportScrollControls(
  state: TUIState,
  options: ViewportScrollControlOptions = {},
): () => void {
  let scrollbarDragOffset: number | undefined;
  let selecting = false;
  let selectionAutoscrollTimer: ReturnType<typeof setInterval> | undefined;
  let selectionEdge: { delta: number; screenRow: number; column: number } | undefined;
  const copyText = options.copyText ?? copyTextToClipboard;
  const jumpToBottom = (): void => {
    state.ui.resetViewportScroll();
  };
  const dragScrollbar = (row: number): void => {
    const scrollState = state.ui.viewportScrollState;
    const geometry = scrollbarGeometry(state.terminal.rows, scrollState);
    const thumbStart = row - 1 - (scrollbarDragOffset ?? Math.floor(geometry.thumbSize / 2));
    state.ui.setViewportScrollOffset(scrollOffsetForThumbStart(thumbStart, geometry, scrollState.maxOffset));
  };

  const stopSelectionAutoscroll = (): void => {
    selectionEdge = undefined;
    if (selectionAutoscrollTimer !== undefined) {
      clearInterval(selectionAutoscrollTimer);
      selectionAutoscrollTimer = undefined;
    }
  };
  const updateSelection = (row: number, column: number): void => {
    const screenRow = Math.max(0, Math.min(state.terminal.rows - 1, row - 1));
    const screenColumn = Math.max(0, column - 1);
    const delta = row <= 1 ? 1 : row >= state.terminal.rows ? -1 : 0;
    if (delta === 0) {
      stopSelectionAutoscroll();
      state.ui.updateTextSelection(screenRow, screenColumn);
      return;
    }
    selectionEdge = { delta, screenRow, column: screenColumn };
    state.ui.scrollAndUpdateTextSelection(delta, screenRow, screenColumn);
    if (selectionAutoscrollTimer !== undefined) return;
    selectionAutoscrollTimer = setInterval(() => {
      if (!selecting || selectionEdge === undefined) {
        stopSelectionAutoscroll();
        return;
      }
      state.ui.scrollAndUpdateTextSelection(selectionEdge.delta, selectionEdge.screenRow, selectionEdge.column);
    }, SELECTION_AUTOSCROLL_INTERVAL_MS);
    selectionAutoscrollTimer.unref();
  };

  const disposeMouse = installTerminalMouseTracking(state, (event) => {
    if (event.kind === 'wheel') {
      state.ui.scrollViewportBy(event.direction === 'up' ? WHEEL_SCROLL_ROWS : -WHEEL_SCROLL_ROWS);
      return;
    }
    if (event.kind === 'release') {
      scrollbarDragOffset = undefined;
      if (selecting) {
        const screenRow = Math.max(0, Math.min(state.terminal.rows - 1, event.row - 1));
        const screenColumn = Math.max(0, event.column - 1);
        const releasedAtEdge = event.row <= 1 || event.row >= state.terminal.rows;
        selecting = false;
        stopSelectionAutoscroll();
        if (releasedAtEdge) {
          // Map the final focus through the viewport produced by the last timer
          // tick without applying one more scroll step on button release.
          state.ui.scrollAndUpdateTextSelection(0, screenRow, screenColumn);
        } else {
          state.ui.updateTextSelection(screenRow, screenColumn);
        }
        const text = state.ui.selectedText;
        if (text.length > 0) void Promise.resolve(copyText(text)).catch(() => {});
      }
      return;
    }
    if (event.kind === 'move') {
      if (scrollbarDragOffset !== undefined && event.button === 'left') dragScrollbar(event.row);
      else if (selecting && event.button === 'left') updateSelection(event.row, event.column);
      return;
    }
    if (event.button !== 'left') return;

    state.ui.clearTextSelection();
    // Mouse reports are 1-based; overlay and component hit testing is 0-based.
    // The jump overlay is composed above the scrollbar, so hit testing must use
    // the same z-order when their rectangles overlap on a narrow terminal.
    if (
      state.ui.viewportScrollOffset > 0 &&
      isJumpToBottomHit(event.column - 1, event.row - 1, state.terminal.columns, state.terminal.rows)
    ) {
      jumpToBottom();
      return;
    }

    if (event.column === state.terminal.columns && state.ui.viewportScrollState.maxOffset > 0) {
      const geometry = scrollbarGeometry(state.terminal.rows, state.ui.viewportScrollState);
      const row = event.row - 1;
      scrollbarDragOffset = row >= geometry.thumbStart && row < geometry.thumbStart + geometry.thumbSize
        ? row - geometry.thumbStart
        : Math.floor(geometry.thumbSize / 2);
      dragScrollbar(event.row);
      return;
    }
    const hit = state.ui.hitTestScreenRow(event.row - 1);
    if (hit?.component === state.editorContainer) {
      // The editor sits inside a gutter container, so the click column has to
      // lose the left inset before the editor can resolve it.
      const placed = state.editor.placeCursorAtComponentRow(hit.rowWithinComponent, event.column - 1 - CHROME_GUTTER);
      if (placed) state.ui.requestRender();
      return;
    }

    selecting = state.ui.beginTextSelection(event.row - 1, event.column - 1);
  });

  const disposeKeys = state.ui.addInputListener((data) => {
    if (!matchesKey(data, Key.ctrl(Key.end))) return undefined;
    jumpToBottom();
    return { consume: true };
  });

  return () => {
    selecting = false;
    stopSelectionAutoscroll();
    disposeKeys();
    disposeMouse();
  };
}

export function installTerminalMouseTracking(
  state: TUIState,
  onEvent?: (event: TerminalMouseEvent) => void,
): () => void {
  const disposeInputListener = state.ui.addInputListener((data) => {
    const event = decodeTerminalMouseEvent(data);
    if (!event) return undefined;
    onEvent?.(event);
    return { consume: true };
  });
  state.terminal.write(ENABLE_TERMINAL_MOUSE_REPORTING);

  return () => {
    disposeInputListener();
    state.terminal.write(DISABLE_TERMINAL_MOUSE_REPORTING);
  };
}
