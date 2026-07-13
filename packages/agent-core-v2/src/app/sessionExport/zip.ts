/**
 * `sessionExport` domain (L6) — export zip writer.
 *
 * Collects the session directory's regular files and writes a diagnostic zip
 * archive with a generated manifest plus optional extra entries. This module
 * owns the byte packaging detail; callers provide already-resolved paths.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { dirname, join, relative } from 'pathe';
import { ZipFile, type ReadStreamOptions } from 'yazl';

import { ErrorCodes, Error2 } from '#/errors';

import { openZipSource, type ZipSource } from './file-source';
import type { ExportSessionManifest } from './sessionExport';

export async function collectFilesRecursive(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .toSorted((a, b) => a.localeCompare(b));
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return [];
  }
}

export type ExtraZipEntry =
  | { readonly source: ZipSource; readonly target: string }
  | { readonly data: Buffer; readonly target: string };

export async function writeExportZip(args: {
  readonly outputPath: string;
  readonly manifest: ExportSessionManifest;
  readonly sessionDir: string;
  readonly sessionFiles: readonly string[];
  readonly extraEntries?: readonly ExtraZipEntry[];
  readonly signal?: AbortSignal;
  readonly maxArchiveBytes?: number;
}): Promise<readonly string[]> {
  const unusedSources = new Set(
    (args.extraEntries ?? []).flatMap((entry) => ('source' in entry ? [entry.source] : [])),
  );
  const pendingOpens = new Set<Promise<void>>();
  let activeSource: ZipSource | undefined;
  let releaseActive: (() => void) | undefined;
  let closing = Promise.resolve();
  let output: Readable | undefined;
  let writing: Promise<void> | undefined;
  let stopped: Error | undefined;
  let failure: { readonly error: unknown } | undefined;
  let onAbort: (() => void) | undefined;

  const getStopError = (): Error | undefined => stopped;
  const stop = (error: Error): void => {
    stopped ??= error;
    releaseActive?.();
    if (output !== undefined && !output.destroyed) output.destroy(stopped);
  };
  const queueClose = (source: ZipSource): void => {
    const next = closing.catch(() => {}).then(() => source.close());
    closing = next;
    void next.catch((error: unknown) => {
      stop(asError(error));
    });
  };

  try {
    await mkdir(dirname(args.outputPath), { recursive: true });
    args.signal?.throwIfAborted();

    const zip = new ZipFile() as LazyZipFile;
    output = zip.outputStream as unknown as Readable;
    zip.on('error', (error: Error) => {
      stop(error);
    });
    output.on('error', (error: Error) => {
      stop(error);
    });
    onAbort = (): void => {
      stop(abortReason(args.signal!));
    };
    args.signal?.addEventListener('abort', onAbort, { once: true });

    const destination = createWriteStream(args.outputPath);
    writing =
      args.maxArchiveBytes === undefined
        ? pipeline(output, destination, { signal: args.signal })
        : pipeline(output, createArchiveLimit(args.maxArchiveBytes), destination, {
            signal: args.signal,
          });

    const activate = (source: ZipSource): Readable => {
      unusedSources.delete(source);
      activeSource = source;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        if (activeSource === source) activeSource = undefined;
        if (releaseActive === release) releaseActive = undefined;
        queueClose(source);
      };
      releaseActive = release;
      source.stream.once('end', release);
      source.stream.once('close', release);
      source.stream.once('error', (error: Error) => {
        release();
        zip.emit('error', error);
      });
      return source.stream;
    };

    const addLazySource = (
      target: string,
      options: Partial<ReadStreamOptions>,
      getSource: () => Promise<ZipSource>,
    ): void => {
      zip.addReadStreamLazy(target, options, (callback) => {
        const pending = (async (): Promise<void> => {
          try {
            await closing;
            if (stopped !== undefined) throw stopped;
            const source = await getSource();
            const stopError = getStopError();
            if (stopError !== undefined) {
              await source.close().catch(() => {});
              throw stopError;
            }
            callback(null, activate(source));
          } catch (error) {
            callback(asError(error));
          }
        })();
        pendingOpens.add(pending);
        void pending.then(
          () => pendingOpens.delete(pending),
          (error: unknown) => {
            pendingOpens.delete(pending);
            zip.emit('error', asError(error));
          },
        );
      });
    };

    zip.addBuffer(Buffer.from(JSON.stringify(args.manifest, null, 2), 'utf8'), 'manifest.json');

    for (const source of args.sessionFiles) {
      const target = relative(args.sessionDir, source).split(/[\\/]/).join('/');
      addLazySource(target, {}, () => openZipSource(source, args.signal));
    }

    for (const extra of args.extraEntries ?? []) {
      if ('data' in extra) {
        zip.addBuffer(extra.data, extra.target);
      } else {
        addLazySource(
          extra.target,
          { size: extra.source.size, mtime: extra.source.mtime, mode: extra.source.mode },
          async () => extra.source,
        );
      }
    }

    zip.end();
    await writing;
  } catch (error) {
    failure = { error };
    stop(asError(error));
    await writing?.catch(() => {});
  } finally {
    if (onAbort !== undefined) args.signal?.removeEventListener('abort', onAbort);
    await Promise.allSettled(pendingOpens);
    releaseActive?.();
    for (const source of unusedSources) queueClose(source);
    unusedSources.clear();
    try {
      await closing;
    } catch (error) {
      failure ??= { error };
    }
  }

  if (failure !== undefined) throw failure.error;
  if (stopped !== undefined) throw stopped;
  return [
    'manifest.json',
    ...args.sessionFiles.map((source) =>
      relative(args.sessionDir, source).split(/[\\/]/).join('/'),
    ),
    ...(args.extraEntries ?? []).map((entry) => entry.target),
  ];
}

interface LazyZipFile extends ZipFile {
  addReadStreamLazy(
    target: string,
    options: Partial<ReadStreamOptions>,
    getReadStream: (
      callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void,
    ) => void,
  ): void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function createArchiveLimit(maxArchiveBytes: number): Transform {
  let archiveBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      archiveBytes += chunk.length;
      if (archiveBytes > maxArchiveBytes) {
        callback(
          new Error2(
            ErrorCodes.SESSION_EXPORT_TOO_LARGE,
            `Session export exceeds the ${maxArchiveBytes} byte archive limit.`,
            { details: { archiveBytes, maxArchiveBytes } },
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
