import type { StatResult } from './types';

export type KaosFileKind = 'regular' | 'directory' | 'symlink' | 'other';

export interface KaosFileIdentity {
  readonly token: string;
}

export interface KaosTransactionalFileStat {
  readonly kind: KaosFileKind;
  readonly identity: KaosFileIdentity;
  readonly sizeBytes: number;
  readonly mode: number;
}

export interface KaosValidatedPath {
  readonly path: string;
  readonly parent: string;
  readonly parentIdentity: KaosFileIdentity;
  readonly leaf: KaosTransactionalFileStat | null;
}

export interface KaosBinaryReader {
  stat(): Promise<KaosTransactionalFileStat>;
  chunks(signal?: AbortSignal): AsyncIterable<Buffer>;
  close(): Promise<void>;
}

export interface KaosBinaryWriter {
  readonly path: string;
  stat(): Promise<KaosTransactionalFileStat>;
  write(chunk: Buffer): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface KaosTransactionalFileCapability {
  readonly chunkSize: number;
  realpath(path: string): Promise<string>;
  validateComponents(root: string, path: string, options?: { readonly allowMissingLeaf?: boolean }): Promise<KaosValidatedPath>;
  openReadNoFollow(path: string): Promise<KaosBinaryReader>;
  createExclusiveNoFollow(path: string, options?: { readonly mode?: number }): Promise<KaosBinaryWriter>;
  publishNoReplace(temporary: KaosBinaryWriter, target: string): Promise<void>;
  unlink(path: string, expectedIdentity?: KaosFileIdentity): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}

export function statKind(stat: StatResult): KaosFileKind {
  const kind = stat.stMode & 0o170000;
  if (kind === 0o100000) return 'regular';
  if (kind === 0o040000) return 'directory';
  if (kind === 0o120000) return 'symlink';
  return 'other';
}

export function fileIdentity(stat: StatResult): KaosFileIdentity {
  return { token: `${String(stat.stDev)}:${String(stat.stIno)}` };
}
