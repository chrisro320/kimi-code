import { describe, expect, it, vi } from 'vitest';

import type { TUIState } from '#/tui/tui-state';
import {
  DISABLE_TERMINAL_MOUSE_REPORTING,
  ENABLE_TERMINAL_MOUSE_REPORTING,
  JUMP_TO_BOTTOM_HINT,
  type TerminalMouseEvent,
  WHEEL_SCROLL_ROWS,
  decodeTerminalMouseEvent,
  installTerminalMouseTracking,
  installViewportScrollControls,
} from '#/tui/utils/terminal-mouse';

describe('terminal mouse tracking', () => {
  it('decodes press, release and wheel reports', () => {
    expect(decodeTerminalMouseEvent('\x1b[<0;12;5M')).toMatchObject({
      kind: 'press',
      button: 'left',
      column: 12,
      row: 5,
    });
    expect(decodeTerminalMouseEvent('\x1b[<0;12;5m')).toMatchObject({ kind: 'release', button: 'left' });
    expect(decodeTerminalMouseEvent('\x1b[<2;1;1M')).toMatchObject({ kind: 'press', button: 'right' });
    expect(decodeTerminalMouseEvent('\x1b[<64;3;4M')).toMatchObject({ kind: 'wheel', direction: 'up' });
    expect(decodeTerminalMouseEvent('\x1b[<65;3;4M')).toMatchObject({ kind: 'wheel', direction: 'down' });
  });

  it('decodes coordinates beyond the legacy 223 limit', () => {
    expect(decodeTerminalMouseEvent('\x1b[<0;240;180M')).toMatchObject({ column: 240, row: 180 });
  });

  it('decodes modifier flags', () => {
    // 0 (left) + 4 (shift) + 16 (ctrl)
    expect(decodeTerminalMouseEvent('\x1b[<20;1;1M')).toMatchObject({
      kind: 'press',
      button: 'left',
      shift: true,
      ctrl: true,
      meta: false,
    });
  });

  it('ignores anything that is not a complete SGR report', () => {
    // Keyboard input, a partial report, and the legacy encoding must all pass through.
    expect(decodeTerminalMouseEvent('a')).toBeUndefined();
    expect(decodeTerminalMouseEvent('\x1b[<0;12;5')).toBeUndefined();
    expect(decodeTerminalMouseEvent('\x1b[M abc')).toBeUndefined();
    expect(decodeTerminalMouseEvent('\x1b[A')).toBeUndefined();
  });

  it('enables reporting, consumes reports, and disables in reverse order on dispose', () => {
    const listeners: Array<(data: string) => { consume: true } | undefined> = [];
    const removeInputListener = vi.fn();
    const writes: string[] = [];
    const state = {
      terminal: {
        write: vi.fn((data: string) => {
          writes.push(data);
        }),
      },
      ui: {
        addInputListener: vi.fn((listener) => {
          listeners.push(listener);
          return removeInputListener;
        }),
      },
    } as unknown as TUIState;

    const seen: TerminalMouseEvent[] = [];
    const dispose = installTerminalMouseTracking(state, (event) => seen.push(event));

    expect(writes).toEqual([ENABLE_TERMINAL_MOUSE_REPORTING]);
    expect(ENABLE_TERMINAL_MOUSE_REPORTING).toBe('\x1b[?1000h\x1b[?1006h');

    // A mouse report is consumed so its bytes never reach the editor.
    expect(listeners[0]?.('\x1b[<0;7;3M')).toEqual({ consume: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'press', column: 7, row: 3 });

    // Ordinary keystrokes are left alone.
    expect(listeners[0]?.('q')).toBeUndefined();
    expect(seen).toHaveLength(1);

    dispose();

    expect(removeInputListener).toHaveBeenCalledOnce();
    expect(writes[1]).toBe(DISABLE_TERMINAL_MOUSE_REPORTING);
    // Encoding (1006) is withdrawn before the mode (1000), so a report already in
    // flight is still decodable.
    expect(DISABLE_TERMINAL_MOUSE_REPORTING).toBe('\x1b[?1006l\x1b[?1000l');
  });
});

describe('viewport scroll controls', () => {
  function createState() {
    const listeners: Array<(data: string) => { consume: true } | undefined> = [];
    const setTransientHint = vi.fn();
    const placeCursorAtComponentRow = vi.fn(() => true);
    const requestRender = vi.fn();
    const editorContainer = { id: 'editor-container' };
    let hit: { component: unknown; rowWithinComponent: number } | undefined;
    const setHit = (next: typeof hit) => {
      hit = next;
    };
    let offset = 0;
    const scrollViewportBy = vi.fn((delta: number) => {
      offset = Math.max(0, offset + delta);
    });
    const resetViewportScroll = vi.fn(() => {
      offset = 0;
    });
    const state = {
      terminal: { write: vi.fn() },
      footer: { setTransientHint },
      editorContainer,
      editor: { placeCursorAtComponentRow },
      ui: {
        addInputListener: vi.fn((listener) => {
          listeners.push(listener);
          return vi.fn();
        }),
        scrollViewportBy,
        resetViewportScroll,
        requestRender,
        hitTestScreenRow: vi.fn(() => hit),
        get viewportScrollOffset() {
          return offset;
        },
      },
    } as unknown as TUIState;
    return {
      state,
      listeners,
      scrollViewportBy,
      resetViewportScroll,
      setTransientHint,
      placeCursorAtComponentRow,
      requestRender,
      editorContainer,
      setHit,
    };
  }

  it('scrolls the viewport on wheel events', () => {
    const { state, listeners, scrollViewportBy } = createState();
    installViewportScrollControls(state);

    // The mouse listener is registered first, the key listener second.
    const mouseListener = listeners[0];
    expect(mouseListener?.('\x1b[<64;1;1M')).toEqual({ consume: true });
    expect(scrollViewportBy).toHaveBeenLastCalledWith(WHEEL_SCROLL_ROWS);

    expect(mouseListener?.('\x1b[<65;1;1M')).toEqual({ consume: true });
    expect(scrollViewportBy).toHaveBeenLastCalledWith(-WHEEL_SCROLL_ROWS);
  });

  it('jumps back to the bottom on ctrl+end, and leaves other keys alone', () => {
    const { state, listeners, resetViewportScroll } = createState();
    installViewportScrollControls(state);

    const keyListener = listeners[1];
    expect(keyListener?.('\x1b[1;5F')).toEqual({ consume: true });
    expect(resetViewportScroll).toHaveBeenCalledOnce();

    // Typing must not snap the view back — the input line stays usable while
    // scrolled up, the way Claude Code behaves.
    expect(keyListener?.('a')).toBeUndefined();
    expect(resetViewportScroll).toHaveBeenCalledOnce();
  });

  it('routes a left click inside the editor to a cursor placement', () => {
    const { state, listeners, placeCursorAtComponentRow, requestRender, editorContainer, setHit } = createState();
    installViewportScrollControls(state);
    const mouseListener = listeners[0];

    setHit({ component: editorContainer, rowWithinComponent: 2 });
    // Row 7, column 9 in the terminal's 1-based reporting.
    mouseListener?.('\x1b[<0;9;7M');
    // Column loses the 1-based offset and the gutter inset (CHROME_GUTTER = 1).
    expect(placeCursorAtComponentRow).toHaveBeenCalledWith(2, 7);
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it('ignores clicks outside the editor and non-left buttons', () => {
    const { state, listeners, placeCursorAtComponentRow, setHit } = createState();
    installViewportScrollControls(state);
    const mouseListener = listeners[0];

    // A click landing on some other component.
    setHit({ component: { id: 'transcript' }, rowWithinComponent: 0 });
    mouseListener?.('\x1b[<0;9;7M');
    expect(placeCursorAtComponentRow).not.toHaveBeenCalled();

    // Right button inside the editor.
    setHit({ component: state.editorContainer, rowWithinComponent: 1 });
    mouseListener?.('\x1b[<2;9;7M');
    expect(placeCursorAtComponentRow).not.toHaveBeenCalled();

    // Release events must not move the cursor either.
    mouseListener?.('\x1b[<0;9;7m');
    expect(placeCursorAtComponentRow).not.toHaveBeenCalled();
  });

  it('shows the jump-to-bottom hint only while scrolled back', () => {
    const { state, listeners, setTransientHint } = createState();
    const dispose = installViewportScrollControls(state);
    const [mouseListener, keyListener] = listeners;

    // Scrolling back raises the hint exactly once.
    mouseListener?.('\x1b[<64;1;1M');
    expect(setTransientHint).toHaveBeenCalledWith(JUMP_TO_BOTTOM_HINT);
    mouseListener?.('\x1b[<64;1;1M');
    expect(setTransientHint).toHaveBeenCalledOnce();

    // Returning to the bottom clears it.
    keyListener?.('\x1b[1;5F');
    expect(setTransientHint).toHaveBeenLastCalledWith(null);

    // Already at the bottom: nothing further to clear.
    setTransientHint.mockClear();
    dispose();
    expect(setTransientHint).not.toHaveBeenCalled();
  });
});
