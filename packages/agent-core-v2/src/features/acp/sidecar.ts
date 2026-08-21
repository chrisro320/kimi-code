/**
 * `acp` domain — schema-versioned per-agent sidecar persistence.
 *
 * Stable refs are allocated monotonically and persisted through the atomic
 * document access pattern. Only SHA-256 message digests are stored; ambiguous
 * duplicate edits fail open rather than transferring refs between messages.
 */

import { createHash } from 'node:crypto';

import type { Message } from '#/kosong/contract/message';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import { ACP_MANAGER_ID, ACP_MANAGER_VERSION } from './acp';

/**
 * Thrown by `ensureStableRefs` when the live transcript no longer matches the
 * persisted sequence and content digests cannot distinguish duplicate
 * messages whose refs are covered by a compression block (or whose block
 * coverage cannot be determined), so refs cannot be safely remapped.
 */
export class AcpDuplicateRemapError extends Error {
  constructor() {
    super(
      'ACP cannot safely remap duplicate messages after the live transcript changed; run /acp reset to rebuild stable refs',
    );
    this.name = 'AcpDuplicateRemapError';
  }
}

export const ACP_SIDECAR_KEY = 'sidecar.json';
const SCHEMA_VERSION = 2;
const MAX_REF = 99_999;

export interface AcpRefRecord {
  readonly digest: string;
  readonly ref: string;
}

export interface AcpSidecar {
  readonly schemaVersion: 2;
  readonly managerId: string;
  readonly managerVersion: string;
  readonly enabled?: boolean;
  readonly nextRef: number;
  readonly refs: readonly AcpRefRecord[];
  readonly liveSequence: readonly string[];
  readonly compressionState: unknown;
}

export function emptyAcpSidecar(): AcpSidecar {
  return {
    schemaVersion: SCHEMA_VERSION,
    managerId: ACP_MANAGER_ID,
    managerVersion: ACP_MANAGER_VERSION,
    nextRef: 1,
    refs: [],
    liveSequence: [],
    compressionState: null,
  };
}

export async function loadAcpSidecar(
  store: IAtomicDocumentStore,
  scope: string,
): Promise<AcpSidecar> {
  const value = await store.get<unknown>(scope, ACP_SIDECAR_KEY);
  if (value === undefined) return emptyAcpSidecar();
  if (!isAcpSidecar(value)) throw new Error('ACP sidecar schema is invalid or incompatible');
  return value;
}

export async function saveAcpSidecar(
  store: IAtomicDocumentStore,
  scope: string,
  sidecar: AcpSidecar,
): Promise<void> {
  await store.set(scope, ACP_SIDECAR_KEY, sidecar);
}

export async function resetAcpSidecar(
  store: IAtomicDocumentStore,
  scope: string,
): Promise<void> {
  let preservedEnabled: boolean | undefined;
  try {
    const current = await store.get<unknown>(scope, ACP_SIDECAR_KEY);
    if (current !== undefined && isAcpSidecar(current)) {
      preservedEnabled = current.enabled;
    }
  } catch {
    // Read/validation failed on a corrupt sidecar; fall through to clean delete.
  }
  if (preservedEnabled !== undefined) {
    await store.set(scope, ACP_SIDECAR_KEY, {
      ...emptyAcpSidecar(),
      enabled: preservedEnabled,
    });
    return;
  }
  await store.delete(scope, ACP_SIDECAR_KEY);
}

/**
 * Reconciles durable refs with the live transcript. `coveredRefs` must list
 * the durable base refs pinned by compression blocks (callers normalize
 * derived core ids like `m00009#reasoning:0` back to their base ref). A
 * duplicated digest may shrink by occurrence-order remap only when none of
 * its old refs are covered; unknown coverage (`undefined`) fails closed.
 */
export function ensureStableRefs(
  sidecar: AcpSidecar,
  messages: readonly Message[],
  coveredRefs?: ReadonlySet<string>,
): { readonly sidecar: AcpSidecar; readonly refs: readonly string[]; readonly changed: boolean } {
  const digests = messages.map(messageDigest);
  if (sameStrings(digests, sidecar.liveSequence.map((ref) => recordForRef(sidecar, ref).digest))) {
    return { sidecar, refs: sidecar.liveSequence, changed: false };
  }

  const oldByDigest = groupRecords(sidecar.refs);
  const newCounts = countStrings(digests);
  for (const [digest, oldRecords] of oldByDigest) {
    const newCount = newCounts.get(digest) ?? 0;
    if (newCount < oldRecords.length && oldRecords.length > 1) {
      const guarded =
        coveredRefs === undefined || oldRecords.some((record) => coveredRefs.has(record.ref));
      if (guarded) throw new AcpDuplicateRemapError();
    }
  }

  const available = new Map<string, AcpRefRecord[]>();
  for (const [digest, recordsForDigest] of oldByDigest) {
    available.set(digest, [...recordsForDigest]);
  }
  const records = [...sidecar.refs];
  const refs: string[] = [];
  let nextRef = sidecar.nextRef;
  for (const digest of digests) {
    let record = available.get(digest)?.shift();
    if (record === undefined) {
      if (nextRef > MAX_REF) throw new Error('ACP stable ref space is exhausted');
      record = { digest, ref: formatRef(nextRef++) };
      records.push(record);
    }
    refs.push(record.ref);
  }

  return {
    sidecar: { ...sidecar, nextRef, refs: records, liveSequence: refs },
    refs,
    changed: true,
  };
}

export function acpCompressionStatesEqual(left: unknown, right: unknown): boolean {
  return stableSerialize(normalizeJson(left)) === stableSerialize(normalizeJson(right));
}

function normalizeJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function messageDigest(message: Message): string {
  return createHash('sha256').update(stableSerialize(message)).digest('hex');
}

function formatRef(value: number): string {
  return `m${value.toString().padStart(5, '0')}`;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

function groupRecords(records: readonly AcpRefRecord[]): Map<string, AcpRefRecord[]> {
  const grouped = new Map<string, AcpRefRecord[]>();
  for (const record of records) {
    const group = grouped.get(record.digest) ?? [];
    group.push(record);
    grouped.set(record.digest, group);
  }
  return grouped;
}

function countStrings(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function recordForRef(sidecar: AcpSidecar, ref: string): AcpRefRecord {
  return sidecar.refs.find((record) => record.ref === ref)!;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isAcpSidecar(value: unknown): value is AcpSidecar {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<AcpSidecar>;
  if (
    candidate.schemaVersion !== SCHEMA_VERSION ||
    candidate.managerId !== ACP_MANAGER_ID ||
    candidate.managerVersion !== ACP_MANAGER_VERSION ||
    (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean') ||
    !Number.isSafeInteger(candidate.nextRef) ||
    (candidate.nextRef ?? 0) < 1 ||
    (candidate.nextRef ?? 0) > MAX_REF + 1 ||
    !Array.isArray(candidate.refs) ||
    !Array.isArray(candidate.liveSequence)
  ) {
    return false;
  }

  const seenRefs = new Set<string>();
  let greatestRef = 0;
  for (const record of candidate.refs) {
    if (
      record === null ||
      typeof record !== 'object' ||
      typeof record.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.digest) ||
      typeof record.ref !== 'string' ||
      !/^m\d{5}$/.test(record.ref) ||
      seenRefs.has(record.ref)
    ) {
      return false;
    }
    const numericRef = Number(record.ref.slice(1));
    if (numericRef < 1 || numericRef > MAX_REF) return false;
    greatestRef = Math.max(greatestRef, numericRef);
    seenRefs.add(record.ref);
  }
  if ((candidate.nextRef ?? 0) <= greatestRef) return false;
  const liveRefs = new Set<string>();
  return candidate.liveSequence.every((ref) => {
    if (typeof ref !== 'string' || !seenRefs.has(ref) || liveRefs.has(ref)) return false;
    liveRefs.add(ref);
    return true;
  });
}
