import { describe, expect, it, vi } from 'vitest';

import type { TUIState } from '#/tui/tui-state';
import {
  DISABLE_TERMINAL_MOUSE_REPORTING,
  ENABLE_TERMINAL_MOUSE_REPORTING,
  type TerminalMouseEvent,
  SELECTION_AUTOSCROLL_INTERVAL_MS,
  WHEEL_SCROLL_ROWS,
  decodeTerminalMouseEvent,
  installTerminalMouseTracking,
  installViewportScrollControls,
  isManagedMouseEnabled,
} from '#/tui/utils/terminal-mouse';

describe('terminal mouse tracking', () => {
  it('decodes press, release and wheel reports', () => {
    expect(decodeTerminalMouseEvent('\u001B[<0;12;5M')).toMatchObject({
      kind: 'press',
      button: 'left',
      column: 12,
      row: 5,
    });
    expect(decodeTerminalMouseEvent('\u001B[<0;12;5m')).toMatchObject({ kind: 'release', button: 'left' });
    expect(decodeTerminalMouseEvent('\u001B[<2;1;1M')).toMatchObject({ kind: 'press', button: 'right' });
    expect(decodeTerminalMouseEvent('\u001B[<64;3;4M')).toMatchObject({ kind: 'wheel', direction: 'up' });
    expect(decodeTerminalMouseEvent('\u001B[<65;3;4M')).toMatchObject({ kind: 'wheel', direction: 'down' });
    expect(decodeTerminalMouseEvent('\u001B[<32;8;6M')).toMatchObject({ kind: 'move', button: 'left' });
    expect(decodeTerminalMouseEvent('\u001B[<35;9;7M')).toMatchObject({ kind: 'move', button: 'none' });
  });

  it('decodes coordinates beyond the legacy 223 limit', () => {
    expect(decodeTerminalMouseEvent('\u001B[<0;240;180M')).toMatchObject({ column: 240, row: 180 });
  });

  it('decodes modifier flags', () => {
    // 0 (left) + 4 (shift) + 16 (ctrl)
    expect(decodeTerminalMouseEvent('\u001B[<20;1;1M')).toMatchObject({
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
    expect(decodeTerminalMouseEvent('\u001B[<0;12;5')).toBeUndefined();
    expect(decodeTerminalMouseEvent('\u001B[M abc')).toBeUndefined();
    expect(decodeTerminalMouseEvent('\u001B[A')).toBeUndefined();
  });

  it('enables managed mouse reporting by default with an emergency opt-out', () => {
    expect(isManagedMouseEnabled({})).toBe(true);
    expect(isManagedMouseEnabled({ KIMI_TUI_MOUSE: '0' })).toBe(true);
    expect(isManagedMouseEnabled({ KIMI_TUI_NO_MOUSE: '1' })).toBe(false);
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
    expect(ENABLE_TERMINAL_MOUSE_REPORTING).toBe('\u001B[?1000h\u001B[?1002h\u001B[?1003h\u001B[?1006h');

    // A mouse report is consumed so its bytes never reach the editor.
    expect(listeners[0]?.('\u001B[<0;7;3M')).toEqual({ consume: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'press', column: 7, row: 3 });

    // Ordinary keystrokes are left alone.
    expect(listeners[0]?.('q')).toBeUndefined();
    expect(seen).toHaveLength(1);

    dispose();

    expect(removeInputListener).toHaveBeenCalledOnce();
    expect(writes[1]).toBe(DISABLE_TERMINAL_MOUSE_REPORTING);
    // Encoding is withdrawn before motion/button modes, in exact reverse order.
    expect(DISABLE_TERMINAL_MOUSE_REPORTING).toBe('\u001B[?1006l\u001B[?1003l\u001B[?1002l\u001B[?1000l');
  });
});

describe('viewport scroll controls', () => {
  function createState() {
    const listeners: Array<(data: string) => { consume: true } | undefined> = [];
    const placeCursorAtComponentRow = vi.fn(() => true);
    const requestRender = vi.fn();
    const jumpToBottom = { id: 'jump-to-bottom' };
    const editorContainer = { id: 'editor-container' };
    let hit: { component: unknown; rowWithinComponent: number } | undefined;
    const setHit = (next: typeof hit) => {
      hit = next;
    };
    let offset = 0;
    const maxOffset = 90;
    const scrollViewportBy = vi.fn((delta: number) => {
      offset = Math.max(0, Math.min(maxOffset, offset + delta));
    });
    const setViewportScrollOffset = vi.fn((next: number) => {
      offset = Math.max(0, Math.min(maxOffset, next));
    });
    const resetViewportScroll = vi.fn(() => {
      offset = 0;
    });
    const beginTextSelection = vi.fn(() => true);
    const updateTextSelection = vi.fn(() => true);
    const scrollAndUpdateTextSelection = vi.fn((delta: number) => {
      offset = Math.max(0, Math.min(maxOffset, offset + delta));
      return true;
    });
    const clearTextSelection = vi.fn(() => true);
    let selectedText = '';
    const setSelectedText = (text: string) => {
      selectedText = text;
    };
    const state = {
      terminal: { write: vi.fn(), columns: 80, rows: 10 },
      jumpToBottom,
      editorContainer,
      editor: { placeCursorAtComponentRow },
      ui: {
        addInputListener: vi.fn((listener) => {
          listeners.push(listener);
          return vi.fn();
        }),
        scrollViewportBy,
        setViewportScrollOffset,
        resetViewportScroll,
        beginTextSelection,
        updateTextSelection,
        scrollAndUpdateTextSelection,
        clearTextSelection,
        requestRender,
        hitTestScreenRow: vi.fn(() => hit),
        get selectedText() {
          return selectedText;
        },
        get viewportScrollOffset() {
          return offset;
        },
        get viewportScrollState() {
          return { offset, maxOffset };
        },
      },
    } as unknown as TUIState;
    return {
      state,
      listeners,
      scrollViewportBy,
      setViewportScrollOffset,
      resetViewportScroll,
      beginTextSelection,
      updateTextSelection,
      scrollAndUpdateTextSelection,
      clearTextSelection,
      setSelectedText,
      placeCursorAtComponentRow,
      requestRender,
      jumpToBottom,
      editorContainer,
      setHit,
    };
  }

  it('scrolls the viewport on wheel events', () => {
    const { state, listeners, scrollViewportBy } = createState();
    installViewportScrollControls(state);

    // The mouse listener is registered first, the key listener second.
    const mouseListener = listeners[0];
    expect(mouseListener?.('\u001B[<64;1;1M')).toEqual({ consume: true });
    expect(scrollViewportBy).toHaveBeenLastCalledWith(WHEEL_SCROLL_ROWS);

    expect(mouseListener?.('\u001B[<65;1;1M')).toEqual({ consume: true });
    expect(scrollViewportBy).toHaveBeenLastCalledWith(-WHEEL_SCROLL_ROWS);
  });

  it('drags the scrollbar thumb through the same absolute ledger offset', () => {
    const { state, listeners, setViewportScrollOffset } = createState();
    installViewportScrollControls(state);
    const mouseListener = listeners[0];

    // Bottom thumb occupies the last row at offset 0. Press it, then drag to top.
    expect(mouseListener?.('\u001B[<0;80;10M')).toEqual({ consume: true });
    expect(mouseListener?.('\u001B[<32;80;1M')).toEqual({ consume: true });
    expect(setViewportScrollOffset).toHaveBeenLastCalledWith(90);

    mouseListener?.('\u001B[<0;80;1m');
    mouseListener?.('\u001B[<32;80;10M');
    expect(setViewportScrollOffset).toHaveBeenCalledTimes(2);
  });

  it('jumps back to the bottom on ctrl+end, and leaves other keys alone', () => {
    const { state, listeners, resetViewportScroll } = createState();
    installViewportScrollControls(state);

    const keyListener = listeners[1];
    expect(keyListener?.('\u001B[1;5F')).toEqual({ consume: true });
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
    mouseListener?.('\u001B[<0;9;7M');
    // Column loses the 1-based offset and the gutter inset (CHROME_GUTTER = 1).
    expect(placeCursorAtComponentRow).toHaveBeenCalledWith(2, 7);
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it('selects transcript text directly and copies it on release', () => {
    const {
      state,
      listeners,
      beginTextSelection,
      updateTextSelection,
      setSelectedText,
      placeCursorAtComponentRow,
      setHit,
    } = createState();
    const copyText = vi.fn();
    installViewportScrollControls(state, { copyText });
    const mouseListener = listeners[0];

    setHit({ component: { id: 'transcript' }, rowWithinComponent: 0 });
    setSelectedText('甲乙\nsecond');
    mouseListener?.('\u001B[<0;9;7M');
    mouseListener?.('\u001B[<32;13;8M');
    mouseListener?.('\u001B[<0;13;8m');

    expect(beginTextSelection).toHaveBeenCalledWith(6, 8);
    expect(updateTextSelection).toHaveBeenNthCalledWith(1, 7, 12);
    expect(updateTextSelection).toHaveBeenNthCalledWith(2, 7, 12);
    expect(copyText).toHaveBeenCalledOnce();
    expect(copyText).toHaveBeenCalledWith('甲乙\nsecond');
    expect(placeCursorAtComponentRow).not.toHaveBeenCalled();
  });

  it('atomically auto-scrolls across multiple viewports while held at an edge', () => {
    vi.useFakeTimers();
    try {
      const { state, listeners, scrollAndUpdateTextSelection, setHit } = createState();
      const dispose = installViewportScrollControls(state, { copyText: vi.fn() });
      const mouseListener = listeners[0];

      setHit({ component: { id: 'transcript' }, rowWithinComponent: 0 });
      mouseListener?.('\u001B[<0;9;7M');
      mouseListener?.('\u001B[<32;5;1M');
      expect(scrollAndUpdateTextSelection).toHaveBeenLastCalledWith(1, 0, 4);

      vi.advanceTimersByTime(SELECTION_AUTOSCROLL_INTERVAL_MS * 25);
      expect(scrollAndUpdateTextSelection).toHaveBeenCalledTimes(26);
      expect(state.ui.viewportScrollOffset).toBe(26);

      const offsetBeforeRelease = state.ui.viewportScrollOffset;
      const nonzeroCallsBeforeRelease = scrollAndUpdateTextSelection.mock.calls.filter(([delta]) => delta !== 0).length;
      mouseListener?.('\u001B[<0;5;1m');
      const callsAtRelease = scrollAndUpdateTextSelection.mock.calls.length;
      expect(scrollAndUpdateTextSelection).toHaveBeenLastCalledWith(0, 0, 4);
      expect(scrollAndUpdateTextSelection.mock.calls.filter(([delta]) => delta !== 0)).toHaveLength(
        nonzeroCallsBeforeRelease,
      );
      expect(state.ui.viewportScrollOffset).toBe(offsetBeforeRelease);
      vi.advanceTimersByTime(SELECTION_AUTOSCROLL_INTERVAL_MS * 5);
      expect(scrollAndUpdateTextSelection).toHaveBeenCalledTimes(callsAtRelease);
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores non-left buttons inside the editor', () => {
    const { state, listeners, beginTextSelection, placeCursorAtComponentRow, setHit } = createState();
    installViewportScrollControls(state);
    const mouseListener = listeners[0];

    setHit({ component: state.editorContainer, rowWithinComponent: 1 });
    mouseListener?.('\u001B[<2;9;7M');

    expect(placeCursorAtComponentRow).not.toHaveBeenCalled();
    expect(beginTextSelection).not.toHaveBeenCalled();
  });

  it('jumps to the bottom when the bottom-center overlay is clicked', () => {
    const { state, listeners, resetViewportScroll } = createState();
    installViewportScrollControls(state);
    const mouseListener = listeners[0];

    mouseListener?.('\u001B[<64;1;1M');
    // 80x10: the 27-column overlay begins at zero-based col 26, row 6.
    expect(mouseListener?.('\u001B[<0;27;7M')).toEqual({ consume: true });
    expect(resetViewportScroll).toHaveBeenCalledOnce();
  });

  it('gives a full-width jump overlay hit priority over the scrollbar', () => {
    const { state, listeners, resetViewportScroll, setViewportScrollOffset } = createState();
    (state.terminal as { columns: number }).columns = 27;
    installViewportScrollControls(state);
    const mouseListener = listeners[0];

    mouseListener?.('\u001B[<64;1;1M');
    // At exactly 27 columns the jump hint occupies the whole overlay row,
    // including the rightmost cell where the scrollbar also renders.
    expect(mouseListener?.('\u001B[<0;27;7M')).toEqual({ consume: true });
    expect(resetViewportScroll).toHaveBeenCalledOnce();
    expect(setViewportScrollOffset).not.toHaveBeenCalled();
  });
});
