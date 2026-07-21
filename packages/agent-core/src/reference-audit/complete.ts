import type { AgentRecordOf } from '../agent/records/types';
import { hashReferenceAuditResult } from './hash';

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Terminal state alone is insufficient for a complete material audit. */
export function isCompleteReferenceAuditRecord(
  run: AgentRecordOf<'reference_audit.run'> | undefined,
  expectedReferenceHash?: string,
): boolean {
  if (run === undefined || run.terminalState !== 'completed') return false;
  if (!SHA256_HEX.test(run.referenceHash ?? '') || !SHA256_HEX.test(run.planHash ?? '') || !SHA256_HEX.test(run.resultHash ?? '')) return false;
  if (expectedReferenceHash === undefined || !SHA256_HEX.test(expectedReferenceHash) || run.referenceHash !== expectedReferenceHash) return false;
  if (run.result === undefined || run.tracks.length === 0) return false;
  const resultTrackIds = run.result.tracks.map((track) => track.id);
  const recordTrackIds = run.tracks.map((track) => track.trackId);
  if (new Set(resultTrackIds).size !== resultTrackIds.length || new Set(recordTrackIds).size !== recordTrackIds.length) return false;
  if (resultTrackIds.length !== recordTrackIds.length || !resultTrackIds.every((trackId) => recordTrackIds.includes(trackId))) return false;
  if (hashReferenceAuditResult(run.result) !== run.resultHash) return false;
  return run.tracks.every((track) => track.status === 'completed');
}

export function missingEvidenceForReferenceAuditRun(
  run: AgentRecordOf<'reference_audit.run'> | undefined,
  expectedReferenceHash?: string,
): readonly string[] {
  if (run === undefined) return ['Reference audit has not been run.'];
  if (isCompleteReferenceAuditRecord(run, expectedReferenceHash)) return [];
  const missing: string[] = [];
  if (run.terminalState !== 'completed') missing.push(`terminalState=${run.terminalState}`);
  if (!SHA256_HEX.test(run.referenceHash ?? '')) missing.push('referenceHash');
  if (!SHA256_HEX.test(run.planHash ?? '')) missing.push('planHash');
  if (!SHA256_HEX.test(run.resultHash ?? '')) missing.push('resultHash');
  if (expectedReferenceHash === undefined || !SHA256_HEX.test(expectedReferenceHash)) missing.push('current referenceHash');
  else if (run.referenceHash !== expectedReferenceHash) missing.push('referenceHash stale');
  if (run.result === undefined) missing.push('normalized result');
  else if (run.resultHash !== hashReferenceAuditResult(run.result)) missing.push('resultHash mismatch');
  const resultTrackIds = run.result?.tracks.map((track) => track.id) ?? [];
  const recordTrackIds = run.tracks.map((track) => track.trackId);
  if (new Set(resultTrackIds).size !== resultTrackIds.length || new Set(recordTrackIds).size !== recordTrackIds.length || resultTrackIds.length !== recordTrackIds.length || !resultTrackIds.every((trackId) => recordTrackIds.includes(trackId))) missing.push('plan/track identity');
  if (run.tracks.length === 0 || !run.tracks.every((track) => track.status === 'completed')) missing.push('required tracks completed');
  if (run.error !== undefined) missing.push(run.error);
  return missing.length > 0 ? missing : ['Audit record is incomplete.'];
}
