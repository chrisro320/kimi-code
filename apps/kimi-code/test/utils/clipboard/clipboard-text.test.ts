import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clipboard } from '#/utils/clipboard/clipboard-native';
import { buildClipboardOSC52 } from '#/utils/clipboard/clipboard-osc52';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('#/utils/clipboard/clipboard-native', () => ({
  clipboard: {
    setText: vi.fn(),
  },
}));

const clipboardMock = clipboard as unknown as { setText: ReturnType<typeof vi.fn> };
const spawnMock = vi.mocked(spawn);

function mockClipboardCommandResult(code: number, stderr = ''): void {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.stderr.end(stderr);
      child.emit('close', code);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
}

function mockClipboardCommandFailure(stderr = 'missing'): void {
  mockClipboardCommandResult(1, stderr);
}

const originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function restoreIsTTY(): void {
  if (originalIsTTYDescriptor !== undefined) {
    Object.defineProperty(process.stdout, 'isTTY', originalIsTTYDescriptor);
  }
}

function stubStdoutTTY(isTTY: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    writable: true,
    value: isTTY,
  });
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

afterEach(() => {
  restoreIsTTY();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

beforeEach(() => {
  spawnMock.mockImplementation(() => {
    throw new Error('platform clipboard fallback should not run');
  });
});

describe('copyTextToClipboard', () => {
  it('uses the contained command path on Linux instead of the noisy native binding', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    clipboardMock.setText.mockResolvedValue(undefined);
    mockClipboardCommandResult(0);

    await expect(copyTextToClipboard('cd "/tmp/proj-b"')).resolves.toBe('native');
    expect(clipboardMock.setText).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith('wl-copy', [], { stdio: ['pipe', 'ignore', 'pipe'] });
  });

  it('copies text with the native clipboard outside Linux when available', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    clipboardMock.setText.mockResolvedValue(undefined);

    await expect(copyTextToClipboard('cd "/tmp/proj-b"')).resolves.toBe('native');
    expect(clipboardMock.setText).toHaveBeenCalledWith('cd "/tmp/proj-b"');
  });

  it('keeps native clipboard method context when copying text', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    clipboardMock.setText.mockImplementation(function (this: unknown, text: string): void {
      expect(this).toBe(clipboardMock);
      expect(text).toBe('cd "/tmp/proj-b"');
    });

    await expect(copyTextToClipboard('cd "/tmp/proj-b"')).resolves.toBe('native');
  });

  it('throws an Error when all platform clipboard commands fail', async () => {
    stubStdoutTTY(false);
    clipboardMock.setText = undefined as unknown as ReturnType<typeof vi.fn>;
    mockClipboardCommandFailure();

    await expect(copyTextToClipboard('cd "/tmp/proj-b"')).rejects.toBeInstanceOf(Error);
    await expect(copyTextToClipboard('cd "/tmp/proj-b"')).rejects.toThrow(
      /(?:clip\.exe|pbcopy|wl-copy|xclip) exited with code 1: missing/,
    );
  });
});

describe('buildClipboardOSC52', () => {
  it('emits a bare OSC 52 sequence outside tmux', () => {
    expect(buildClipboardOSC52('hi', false)).toBe(`\u001B]52;c;${base64('hi')}\u0007`);
  });

  it('wraps the sequence in a tmux passthrough with doubled ESC bytes', () => {
    expect(buildClipboardOSC52('hi', true)).toBe(
      `\u001BPtmux;\u001B\u001B]52;c;${base64('hi')}\u0007\u001B\\`,
    );
  });
});

describe('OSC 52 fallback in copyTextToClipboard', () => {
  it('resolves via OSC 52 when native clipboards fail on a terminal', async () => {
    stubStdoutTTY(true);
    clipboardMock.setText = undefined as unknown as ReturnType<typeof vi.fn>;
    mockClipboardCommandFailure();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(copyTextToClipboard('hello world')).resolves.toBe('osc52');

    const written = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain(`]52;c;${base64('hello world')}`);
  });

  it('does not write escape sequences when stdout is not a terminal', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    stubStdoutTTY(false);
    clipboardMock.setText = vi.fn().mockResolvedValue(undefined);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await copyTextToClipboard('hello');

    expect(writeSpy).not.toHaveBeenCalled();
  });
});
