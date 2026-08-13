import { Key, matchesKey } from '@moonshot-ai/pi-tui';

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
const SHIFT_FLAG = 0b100;
const META_FLAG = 0b1000;
const CTRL_FLAG = 0b1_0000;
/** The button itself lives in the low two bits: 0 left, 1 middle, 2 right. */
const BUTTON_MASK = 0b11;

export type TerminalMouseButton = 'left' | 'middle' | 'right';

export type TerminalMouseEvent =
  | {
      readonly kind: 'press' | 'release';
      readonly button: TerminalMouseButton;
      /** 1-based, as reported by the terminal. */
      readonly column: number;
      readonly row: number;
      readonly shift: boolean;
      readonly meta: boolean;
      readonly ctrl: boolean;
    }
  | {
      readonly kind: 'wheel';
      readonly direction: 'up' | 'down';
      readonly column: number;
      readonly row: number;
      readonly shift: boolean;
      readonly meta: boolean;
      readonly ctrl: boolean;
    };

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

  if ((raw & WHEEL_FLAG) !== 0) {
    return {
      kind: 'wheel',
      direction: (raw & BUTTON_MASK) === 0 ? 'up' : 'down',
      column,
      row,
      shift,
      meta,
      ctrl,
    };
  }

  return {
    kind: match[4] === 'M' ? 'press' : 'release',
    button: BUTTONS[raw & BUTTON_MASK] ?? 'left',
    column,
    row,
    shift,
    meta,
    ctrl,
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

/** Shown in the footer while the viewport is scrolled back. */
export const JUMP_TO_BOTTOM_HINT = 'Jump to bottom (ctrl+End) ↓';

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
export function installViewportScrollControls(state: TUIState): () => void {
  // Tracked so the hint is only cleared when this is the one that set it, and an
  // unrelated hint (the Ctrl+C exit prompt, say) is not wiped out.
  let hintShown = false;
  const syncJumpHint = (): void => {
    const scrolledBack = state.ui.viewportScrollOffset > 0;
    if (scrolledBack === hintShown) return;
    state.footer.setTransientHint(scrolledBack ? JUMP_TO_BOTTOM_HINT : null);
    hintShown = scrolledBack;
  };

  const disposeMouse = installTerminalMouseTracking(state, (event) => {
    if (event.kind === 'wheel') {
      state.ui.scrollViewportBy(event.direction === 'up' ? WHEEL_SCROLL_ROWS : -WHEEL_SCROLL_ROWS);
      syncJumpHint();
      return;
    }
    if (event.kind !== 'press' || event.button !== 'left') return;

    // Mouse reports are 1-based; hit testing is 0-based.
    const hit = state.ui.hitTestScreenRow(event.row - 1);
    if (hit?.component !== state.editorContainer) return;

    // The editor sits inside a gutter container, so the click column has to lose
    // the left inset before the editor can resolve it.
    const placed = state.editor.placeCursorAtComponentRow(hit.rowWithinComponent, event.column - 1 - CHROME_GUTTER);
    if (placed) state.ui.requestRender();
  });

  const disposeKeys = state.ui.addInputListener((data) => {
    if (!matchesKey(data, Key.ctrl(Key.end))) return undefined;
    state.ui.resetViewportScroll();
    syncJumpHint();
    return { consume: true };
  });

  return () => {
    disposeKeys();
    disposeMouse();
    if (hintShown) {
      state.footer.setTransientHint(null);
      hintShown = false;
    }
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
