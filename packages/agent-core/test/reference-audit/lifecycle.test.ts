import { describe, expect, it } from 'vitest';

import {
  attachReferenceAuditRun,
  evaluateReferenceAuditGate,
  isCompleteReferenceAuditRecord,
  type ReferenceAuditRunSnapshot,
} from '../../src/reference-audit';

const run: ReferenceAuditRunSnapshot = {
  runId: 'audit-1',
  referenceHash: 'a'.repeat(64),
  planHash: 'c'.repeat(64),
  resultHash: 'b'.repeat(64),
  status: 'complete',
  missingEvidence: [],
  riskOverrideUsed: false,
};

describe('reference audit lifecycle gate', () => {
  it('blocks incomplete, missing-current-hash, or stale material references', () => {
    expect(evaluateReferenceAuditGate({ material: true })).toMatchObject({ allowed: false, state: 'blocked' });
    expect(evaluateReferenceAuditGate({ material: true, run: { ...run, planHash: 'b'.repeat(64) } })).toMatchObject({ allowed: false, state: 'blocked' });
    expect(evaluateReferenceAuditGate({
      material: true,
      currentReferenceHash: 'c'.repeat(64),
      run,
    })).toMatchObject({ allowed: false, state: 'blocked', stale: true });
  });

  it('allows one explicit risk override without hiding missing evidence', () => {
    expect(evaluateReferenceAuditGate({
      material: true,
      currentReferenceHash: 'c'.repeat(64),
      run: { ...run, status: 'incomplete', missingEvidence: ['license unknown'] },
      riskOverrideConfirmed: true,
    })).toEqual({
      allowed: true,
      state: 'audit-risk-accepted',
      stale: true,
      reason: 'The material reference set changed after the recorded audit.',
      missingEvidence: ['license unknown'],
    });
  });

  it('attaches a session-scoped run only after per-run user confirmation', () => {
    expect(() => attachReferenceAuditRun(run, {
      taskPath: '.trellis/tasks/07-20-audit',
      userConfirmed: false,
    })).toThrow('per-run user confirmation');
    expect(attachReferenceAuditRun(run, {
      taskPath: '.trellis/tasks/07-20-audit',
      userConfirmed: true,
      attachedAt: '2026-07-20T00:00:00.000Z',
    }).attachment).toEqual({
      taskPath: '.trellis/tasks/07-20-audit',
      attachedAt: '2026-07-20T00:00:00.000Z',
      confirmedBy: 'user',
    });
  });
});
