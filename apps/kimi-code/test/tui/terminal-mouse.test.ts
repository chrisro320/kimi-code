import { describe, expect, it, vi } from 'vitest';

import type { TUIState } from '#/tui/tui-state';
import {
  DISABLE_TERMINAL_MOUSE_REPORTING,
  ENABLE_TERMINAL_MOUSE_REPORTING,
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
    const scrollViewportBy = vi.fn();
    const resetViewportScroll = vi.fn();
    const state = {
      terminal: { write: vi.fn() },
      ui: {
        addInputListener: vi.fn((listener) => {
          listeners.push(listener);
          return vi.fn();
        }),
        scrollViewportBy,
        resetViewportScroll,
      },
    } as unknown as TUIState;
    return { state, listeners, scrollViewportBy, resetViewportScroll };
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
});
