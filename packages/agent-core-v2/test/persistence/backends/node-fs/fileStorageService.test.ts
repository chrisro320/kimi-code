/**
 * File storage durability, permissions, and error translation with real
 * temporary files and a controlled directory-fsync boundary.
 */

import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';

const fsBoundary = vi.hoisted(() => ({
  open: vi.fn<typeof import('node:fs/promises').open>(),
  syncDir: vi.fn<(dir: string) => Promise<void>>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: fsBoundary.open };
});

vi.mock('#/_base/utils/fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('#/_base/utils/fs')>();
  return { ...original, syncDir: fsBoundary.syncDir };
});

const isWin = process.platform === 'win32';
const encoder = new TextEncoder();

beforeEach(async () => {
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  fsBoundary.open.mockReset();
  fsBoundary.open.mockImplementation(original.open);
  fsBoundary.syncDir.mockReset();
  fsBoundary.syncDir.mockResolvedValue(undefined);
});

afterEach(() => {
  fsBoundary.open.mockReset();
  fsBoundary.syncDir.mockReset();
});

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe('FileStorageService — durable directory entries', () => {
  let dir: string;
  let service: FileStorageService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fss-durable-'));
    service = new FileStorageService(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('syncs the directory when a second key is atomically created in the same scope', async () => {
    await service.write('scope', 'first.json', encoder.encode('first'));
    await service.write('scope', 'second.json', encoder.encode('second'));

    expect(fsBoundary.syncDir.mock.calls).toEqual([
      [join(dir, 'scope')],
      [join(dir, 'scope')],
    ]);
  });

  it('syncs the directory after replacing an existing atomic document', async () => {
    await service.write('scope', 'state.json', encoder.encode('first'));
    await service.write('scope', 'state.json', encoder.encode('second'));

    expect(fsBoundary.syncDir.mock.calls).toEqual([
      [join(dir, 'scope')],
      [join(dir, 'scope')],
    ]);
  });

  it('waits for directory durability when two instances first append the same log', async () => {
    const other = new FileStorageService(dir);
    const firstEntered = deferred();
    const secondEntered = deferred();
    const release = deferred();
    let entries = 0;
    fsBoundary.syncDir.mockImplementation(async () => {
      entries++;
      if (entries === 1) firstEntered.resolve();
      if (entries === 2) secondEntered.resolve();
      await release.promise;
    });
    let successes = 0;

    const first = service.append('scope', 'wire.jsonl', encoder.encode('first\n')).then(() => {
      successes++;
    });
    await firstEntered.promise;
    expect(successes).toBe(0);

    const second = other.append('scope', 'wire.jsonl', encoder.encode('second\n')).then(() => {
      successes++;
    });
    const secondBeforeDurability = await Promise.race([
      secondEntered.promise.then(() => 'syncing'),
      second.then(() => 'succeeded'),
    ]);
    expect(secondBeforeDurability).toBe('syncing');
    expect(successes).toBe(0);

    release.resolve();
    await Promise.all([first, second]);
    expect(successes).toBe(2);
    expect(fsBoundary.syncDir).toHaveBeenCalledTimes(2);
  });

  it('resyncs the directory when another instance recreates a known log', async () => {
    const other = new FileStorageService(dir);
    const probe = await open(join(dir, 'probe'), 'a');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      stat(options: { bigint: true }): Promise<{
        birthtimeNs: bigint;
        dev: bigint;
        ino: bigint;
      }>;
    };
    await probe.close();
    const fileStat = vi
      .spyOn(fileHandlePrototype, 'stat')
      .mockResolvedValueOnce({ birthtimeNs: 10n, dev: 1n, ino: 7n })
      .mockResolvedValueOnce({ birthtimeNs: 20n, dev: 1n, ino: 7n })
      .mockResolvedValueOnce({ birthtimeNs: 20n, dev: 1n, ino: 7n });
    const release = deferred();
    let recreate: Promise<void> | undefined;
    let appendFromStaleInstance: Promise<void> | undefined;

    try {
      await service.append('scope', 'wire.jsonl', encoder.encode('old\n'));
      await other.delete('scope', 'wire.jsonl');
      fsBoundary.syncDir.mockClear();

      const firstEntered = deferred();
      const secondEntered = deferred();
      let entries = 0;
      fsBoundary.syncDir.mockImplementation(async () => {
        entries++;
        if (entries === 1) firstEntered.resolve();
        if (entries === 2) secondEntered.resolve();
        await release.promise;
      });
      recreate = other.append('scope', 'wire.jsonl', encoder.encode('new\n'));
      await firstEntered.promise;
      appendFromStaleInstance = service.append(
        'scope',
        'wire.jsonl',
        encoder.encode('later\n'),
      );

      const beforeDurability = await Promise.race([
        secondEntered.promise.then(() => 'syncing'),
        appendFromStaleInstance.then(() => 'succeeded'),
      ]);
      expect(beforeDurability).toBe('syncing');

      release.resolve();
      await Promise.all([recreate, appendFromStaleInstance]);
      expect(fsBoundary.syncDir).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await Promise.allSettled(
        [recreate, appendFromStaleInstance].filter(
          (operation): operation is Promise<void> => operation !== undefined,
        ),
      );
      fileStat.mockRestore();
    }
  });

  it('resyncs each append when the filesystem exposes no stable file identity', async () => {
    const probe = await open(join(dir, 'probe'), 'a');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      stat(options: { bigint: true }): Promise<{
        birthtimeNs: bigint;
        dev: bigint;
        ino: bigint;
      }>;
    };
    await probe.close();
    const fileStat = vi
      .spyOn(fileHandlePrototype, 'stat')
      .mockResolvedValue({ birthtimeNs: 0n, dev: 0n, ino: 0n });

    try {
      await service.append('scope', 'wire.jsonl', encoder.encode('first\n'));
      await service.append('scope', 'wire.jsonl', encoder.encode('second\n'));
      expect(fsBoundary.syncDir).toHaveBeenCalledTimes(2);
    } finally {
      fileStat.mockRestore();
    }
  });

  it('reclaims a log that disappears before the non-creating append open', async () => {
    fsBoundary.open
      .mockRejectedValueOnce(fsError('EEXIST'))
      .mockRejectedValueOnce(fsError('ENOENT'));

    await service.append('scope', 'wire.jsonl', encoder.encode('first\n'));

    expect(fsBoundary.open).toHaveBeenCalledTimes(3);
    expect(fsBoundary.open.mock.calls[0]?.[1]).toBe('ax');
    const fallbackFlags = fsBoundary.open.mock.calls[1]?.[1];
    expect(typeof fallbackFlags).toBe('number');
    expect((fallbackFlags as number) & constants.O_CREAT).toBe(0);
    expect(fsBoundary.open.mock.calls[2]?.[1]).toBe('ax');
    expect(fsBoundary.syncDir).toHaveBeenCalledOnce();
  });

  it('appends when another writer creates the key after a non-creating open misses', async () => {
    const filePath = join(dir, 'scope', 'wire.jsonl');
    fsBoundary.open
      .mockRejectedValueOnce(fsError('EEXIST'))
      .mockImplementationOnce(async () => {
        await mkdir(join(dir, 'scope'), { recursive: true });
        await writeFile(filePath, 'other\n');
        throw fsError('ENOENT');
      });

    await service.append('scope', 'wire.jsonl', encoder.encode('first\n'));

    expect(new TextDecoder().decode(await service.read('scope', 'wire.jsonl'))).toBe(
      'other\nfirst\n',
    );
    expect(fsBoundary.syncDir).toHaveBeenCalledOnce();
  });

  it.skipIf(isWin)('rejects append when the key is a dangling symlink', async () => {
    await mkdir(join(dir, 'scope'), { recursive: true });
    await symlink('missing-target', join(dir, 'scope', 'wire.jsonl'));

    await expect(
      service.append('scope', 'wire.jsonl', encoder.encode('first\n')),
    ).rejects.toMatchObject({
      code: 'storage.io_failed',
      details: { errno: 'ENOENT', op: 'append' },
    });
    expect(fsBoundary.syncDir).not.toHaveBeenCalled();
  });

  it('does not resync the directory for durable appends to an existing log', async () => {
    await service.append('scope', 'wire.jsonl', encoder.encode('first\n'));
    await service.append('scope', 'wire.jsonl', encoder.encode('second\n'));
    await service.append('scope', 'wire.jsonl', encoder.encode('third\n'));

    expect(fsBoundary.syncDir).toHaveBeenCalledTimes(1);
    expect(fsBoundary.syncDir).toHaveBeenCalledWith(join(dir, 'scope'));
  });

  it('resyncs the directory when a deleted append log is recreated', async () => {
    await service.append('scope', 'wire.jsonl', encoder.encode('first\n'));
    await service.delete('scope', 'wire.jsonl');
    await service.append('scope', 'wire.jsonl', encoder.encode('second\n'));

    expect(fsBoundary.syncDir.mock.calls).toEqual([
      [join(dir, 'scope')],
      [join(dir, 'scope')],
    ]);
  });

  it('retries directory fsync after an atomic replacement directory fsync fails', async () => {
    await service.write('scope', 'state.json', encoder.encode('first'));
    fsBoundary.syncDir.mockRejectedValueOnce(new Error('directory fsync failed'));

    await expect(
      service.write('scope', 'state.json', encoder.encode('second')),
    ).rejects.toMatchObject({
      code: 'storage.io_failed',
      details: { op: 'write' },
      cause: new Error('directory fsync failed'),
    });

    await expect(
      service.append('scope', 'state.json', encoder.encode('third')),
    ).resolves.toBeUndefined();
    expect(fsBoundary.syncDir).toHaveBeenCalledTimes(3);
    expect(fsBoundary.syncDir).toHaveBeenLastCalledWith(join(dir, 'scope'));
  });

  it('retries the directory fsync after a new log file fsync fails', async () => {
    const probe = await open(join(dir, 'probe'), 'a');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      sync(): Promise<void>;
    };
    await probe.close();
    const fileSync = vi
      .spyOn(fileHandlePrototype, 'sync')
      .mockRejectedValueOnce(new Error('file fsync failed'));

    try {
      await expect(
        service.append('scope', 'wire.jsonl', encoder.encode('first\n')),
      ).rejects.toMatchObject({
        code: 'storage.io_failed',
        details: { op: 'append' },
        cause: new Error('file fsync failed'),
      });
      expect(fsBoundary.syncDir).not.toHaveBeenCalled();

      await expect(
        service.append('scope', 'wire.jsonl', encoder.encode('second\n')),
      ).resolves.toBeUndefined();
      expect(fsBoundary.syncDir).toHaveBeenCalledOnce();
      expect(fsBoundary.syncDir).toHaveBeenCalledWith(join(dir, 'scope'));
    } finally {
      fileSync.mockRestore();
    }
  });

  it('retries the directory fsync after a new log directory fsync fails', async () => {
    fsBoundary.syncDir.mockRejectedValueOnce(new Error('directory fsync failed'));

    await expect(
      service.append('scope', 'wire.jsonl', encoder.encode('first\n')),
    ).rejects.toMatchObject({
      code: 'storage.io_failed',
      details: { op: 'append' },
      cause: new Error('directory fsync failed'),
    });

    await expect(
      service.append('scope', 'wire.jsonl', encoder.encode('second\n')),
    ).resolves.toBeUndefined();
    expect(fsBoundary.syncDir).toHaveBeenCalledTimes(2);
    expect(fsBoundary.syncDir).toHaveBeenLastCalledWith(join(dir, 'scope'));
  });
});

describe('FileStorageService — file permissions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fss-perm-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(isWin)('creates scope directories with dirMode (0700)', async () => {
    const svc = new FileStorageService(dir, 0o700, 0o600);
    await svc.write('cron/ws', 'abc.json', encoder.encode('{}'));

    const dirStat = await stat(join(dir, 'cron/ws'));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it.skipIf(isWin)('writes documents with fileMode (0600)', async () => {
    const svc = new FileStorageService(dir, 0o700, 0o600);
    await svc.write('cron/ws', 'abc.json', encoder.encode('{"x":1}'));

    const fileStat = await stat(join(dir, 'cron/ws', 'abc.json'));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWin)('defaults to the process umask when modes are omitted', async () => {
    // Backwards compatibility: an unconfigured FileStorageService must not
    // start tightening permissions on its own — bootstrap opts into 0700/0600.
    const svc = new FileStorageService(dir);
    await svc.write('scope', 'k.json', encoder.encode('{}'));
    const fileStat = await stat(join(dir, 'scope', 'k.json'));
    // Owner-read/write is always set; we only assert the file is readable by
    // its owner (the lower bound) rather than pinning an exact mode.
    expect(fileStat.mode & 0o400).toBe(0o400);
  });
});

describe('FileStorageService — error translation', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fss-err-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps ENOENT semantics: read returns undefined, list returns []', async () => {
    const svc = new FileStorageService(dir);
    expect(await svc.read('scope', 'missing.json')).toBeUndefined();
    expect(await svc.list('missing-scope')).toEqual([]);
    await expect(svc.delete('scope', 'missing.json')).resolves.toBeUndefined();
  });

  it.skipIf(isWin)('translates non-ENOENT failures into StorageError(io_failed)', async () => {
    const svc = new FileStorageService(dir);
    // Reading a directory fails with EISDIR — an I/O failure, not a miss.
    await mkdir(join(dir, 'scope', 'adir'), { recursive: true });
    await expect(svc.read('scope', 'adir')).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ code: 'storage.io_failed' });
      const io = error as { details?: Record<string, unknown>; cause?: unknown };
      expect(io.details).toMatchObject({
        path: join(dir, 'scope', 'adir'),
        op: 'read',
        errno: 'EISDIR',
      });
      expect(io.cause).toBeInstanceOf(Error);
      return true;
    });
  });

  it.skipIf(isWin)('translates write failures into StorageError(io_failed)', async () => {
    const svc = new FileStorageService(dir);
    // A file blocks the scope directory: mkdir('<dir>/blocked/k') fails
    // (EEXIST/ENOTDIR depending on platform and fs implementation).
    await writeFile(join(dir, 'blocked'), 'x');
    await expect(svc.write('blocked', 'k.json', encoder.encode('{}'))).rejects.toMatchObject({
      code: 'storage.io_failed',
      details: { op: 'write', errno: expect.any(String) },
    });
  });
});
