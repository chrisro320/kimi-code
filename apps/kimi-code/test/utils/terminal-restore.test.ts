import { afterEach, describe, expect, it, vi } from 'vitest';

import { TERMINAL_RESTORE_SEQUENCE, restoreTerminalModes } from '#/utils/terminal-restore';

const originalSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');

describe('terminal emergency restore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSetRawMode === undefined) {
      Reflect.deleteProperty(process.stdin, 'setRawMode');
    } else {
      Object.defineProperty(process.stdin, 'setRawMode', originalSetRawMode);
    }
  });

  it('withdraws every app-owned terminal mode and exits the alternate screen', () => {
    expect(TERMINAL_RESTORE_SEQUENCE).toBe(
      '\u001B[?1006l\u001B[?1003l\u001B[?1002l\u001B[?1000l' +
        '\u001B[?1004l\u001B[?2031l\u001B[?2004l\u001B[<u\u001B[>4;0m\u001B[?1049l\u001B[?25h',
    );
  });

  it('restores raw input and writes the complete sequence best-effort', () => {
    const setRawMode = vi.fn();
    Object.defineProperty(process.stdin, 'setRawMode', {
      value: setRawMode,
      configurable: true,
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    restoreTerminalModes();

    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(write).toHaveBeenCalledWith(TERMINAL_RESTORE_SEQUENCE);
  });
});
