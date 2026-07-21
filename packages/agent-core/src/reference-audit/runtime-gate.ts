import type { Agent } from '../agent';
import { isCompleteReferenceAuditRecord, missingEvidenceForReferenceAuditRun } from './complete';
import { evaluateReferenceAuditGate } from './lifecycle';

/** Shared durable gate for reference-dependent editing dispatch. */
export function requireReferenceAuditForEditing(
  records: Agent['records'],
  overrideHash: string | undefined,
  consumedBy: string,
): void {
  const state = records.latest('reference_audit.state');
  if (state?.material !== true) return;
  if (state.referenceHash === undefined || !/^[a-f0-9]{64}$/.test(state.referenceHash)) {
    throw new Error('Reference-dependent editing dispatch blocked: material reference state has no valid current hash.');
  }

  const run = records.latest('reference_audit.run');
  const complete = isCompleteReferenceAuditRecord(run, state.referenceHash);
  const override = records.latest('reference_audit.override');
  const approved = overrideHash !== undefined
    && override?.state === 'approved'
    && override.purpose === 'editing-dispatch'
    && override.operationId === consumedBy
    && override.referenceHash === state.referenceHash
    && override.overrideHash === overrideHash;
  const decision = evaluateReferenceAuditGate({
    material: true,
    currentReferenceHash: state.referenceHash,
    run: run === undefined ? undefined : {
      runId: run.runId,
      referenceHash: run.referenceHash ?? '',
      planHash: run.planHash,
      resultHash: run.resultHash,
      status: complete ? 'complete' : 'incomplete',
      missingEvidence: missingEvidenceForReferenceAuditRun(run, state.referenceHash),
      riskOverrideUsed: false,
    },
    riskOverrideConfirmed: approved,
  });
  if (!decision.allowed) throw new Error(`Reference-dependent editing dispatch blocked: ${decision.reason}`);
  if (decision.state === 'audit-risk-accepted') {
    const claimed = records.claimReferenceAuditOverride({
      operationId: consumedBy,
      purpose: 'editing-dispatch',
      referenceHash: state.referenceHash,
      overrideHash,
      consumedBy,
    });
    if (!claimed) throw new Error('Reference-dependent editing dispatch blocked: override was already consumed or does not match this operation.');
  }
}
