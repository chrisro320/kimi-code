import { describe, expect, it, vi } from 'vitest';

import { hashReferenceAuditOverride, hashReferenceAuditResult, requireReferenceAuditForEditing } from '../../src/reference-audit';

function recordsStore(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  const history: Record<string, unknown>[] = [];
  const existingOverride = store['reference_audit.override'];
  if (existingOverride !== undefined) history.push(existingOverride as Record<string, unknown>);
  const logRecord = vi.fn((entry: { type: string } & Record<string, unknown>) => {
    store[entry.type] = entry;
    if (entry.type === 'reference_audit.override') history.push(entry);
  });
  const claimReferenceAuditOverride = vi.fn((input: { operationId: string; purpose: string; referenceHash: string; overrideHash?: string; consumedBy: string }) => {
    const approved = [...history].reverse().find((entry) =>
      entry['operationId'] === input.operationId
      && entry['purpose'] === input.purpose
      && entry['referenceHash'] === input.referenceHash
      && entry['state'] === 'approved'
      && (input.overrideHash === undefined || entry['overrideHash'] === input.overrideHash));
    if (approved === undefined || history.some((entry) => entry['operationId'] === input.operationId && entry['state'] === 'consumed')) return false;
    logRecord({ ...approved, type: 'reference_audit.override', state: 'consumed', consumedBy: input.consumedBy });
    return true;
  });
  return { latest: (type: string) => store[type] as never, logRecord, claimReferenceAuditOverride, store };
}

const referenceHash = 'a'.repeat(64);
const completeResult = {
  intensity: 'standard' as const,
  references: [],
  tracks: [{ id: 't1', label: 'track', workflowRole: 'source-explore' as const, subagentType: 'explore' as const, referenceIds: [], dimensions: [], prompt: 'audit' }],
  reports: [], claims: [], contradictions: [], unknowns: [], licenseNotes: [],
};
const completeRun = {
  type: 'reference_audit.run' as const,
  runId: 'audit-1',
  triggered: true,
  referenceHash,
  planHash: 'b'.repeat(64),
  resultHash: hashReferenceAuditResult(completeResult),
  tracks: [{ trackId: 't1', workflowRole: 'source-explore' as const, status: 'completed' as const, repairCount: 0 as const }],
  result: completeResult,
  terminalState: 'completed' as const,
};

describe('reference-dependent editing gate', () => {
  it('blocks a terminal completed record with missing hashes or result', () => {
    const records = recordsStore({
      'reference_audit.state': { material: true, references: [], referenceHash },
      'reference_audit.run': { ...completeRun, planHash: undefined, result: undefined },
    });
    expect(() => requireReferenceAuditForEditing(records as never, undefined, 'agent-1')).toThrow(/blocked/);
  });

  it('does not allow material:false caller state to clear durable material state', () => {
    const records = recordsStore({
      'reference_audit.state': { material: true, references: [], referenceHash },
      'reference_audit.run': { ...completeRun, terminalState: 'fallback_required', result: undefined, tracks: [] },
    });
    expect(() => requireReferenceAuditForEditing(records as never, undefined, 'agent-1')).toThrow(/blocked/);
  });

  it('consumes a matching override once and rejects a consumed record', () => {
    const challenge = { referenceHash, purpose: 'editing-dispatch' as const, operationId: 'agent-1', reason: 'known gap' };
    const overrideHash = hashReferenceAuditOverride(challenge);
    const records = recordsStore({
      'reference_audit.state': { material: true, references: [], referenceHash },
      'reference_audit.run': { ...completeRun, terminalState: 'fallback_required', result: undefined, tracks: [] },
      'reference_audit.override': { type: 'reference_audit.override' as const, ...challenge, overrideHash, state: 'approved' as const },
    });
    expect(() => requireReferenceAuditForEditing(records as never, overrideHash, 'agent-1')).not.toThrow();
    expect(records.logRecord).toHaveBeenCalledWith(expect.objectContaining({ state: 'consumed', consumedBy: 'agent-1' }));
    records.store['reference_audit.override'] = { type: 'reference_audit.override', ...challenge, overrideHash, state: 'consumed' };
    expect(() => requireReferenceAuditForEditing(records as never, overrideHash, 'agent-2')).toThrow(/blocked/);
  });

  it('rejects an approved override replayed for another operation', () => {
    const challenge = { referenceHash, purpose: 'editing-dispatch' as const, operationId: 'agent-1', reason: 'known gap' };
    const overrideHash = hashReferenceAuditOverride(challenge);
    const records = recordsStore({
      'reference_audit.state': { material: true, references: [], referenceHash },
      'reference_audit.run': { ...completeRun, terminalState: 'fallback_required', result: undefined, tracks: [] },
      'reference_audit.override': { type: 'reference_audit.override' as const, ...challenge, overrideHash, state: 'approved' as const },
    });
    expect(() => requireReferenceAuditForEditing(records as never, overrideHash, 'agent-2')).toThrow(/blocked/);
  });
});
