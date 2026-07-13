/**
 * `sessionExport` domain (L6) — bounded file source ownership.
 *
 * Opens one stable file handle, snapshots its current size, and exposes an
 * idempotent close operation shared by normal completion and failure cleanup.
 */

import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

export interface ZipSource {
  readonly stream: Readable;
  readonly size: number;
  readonly mtime: Date;
  readonly mode: number;
  close(): Promise<void>;
}

export async function openZipSource(source: string, signal?: AbortSignal): Promise<ZipSource> {
  const handle = await open(source, 'r');
  let stream: Readable | undefined;
  try {
    signal?.throwIfAborted();
    const file = await handle.stat();
    if (!file.isFile()) throw new Error(`not a file: ${source}`);
    signal?.throwIfAborted();
    stream =
      file.size === 0
        ? Readable.from([])
        : handle.createReadStream({
            autoClose: false,
            start: 0,
            end: file.size - 1,
            signal,
          });
    let closing: Promise<void> | undefined;
    return {
      stream,
      size: file.size,
      mtime: file.mtime,
      mode: file.mode,
      close: () => {
        closing ??= closeZipSource(stream!, handle);
        return closing;
      },
    };
  } catch (error) {
    stream?.destroy();
    await handle.close().catch(() => {});
    throw error;
  }
}

async function closeZipSource(stream: Readable, handle: FileHandle): Promise<void> {
  stream.destroy();
  await finished(stream, { cleanup: true }).catch(() => {});
  await handle.close();
}
