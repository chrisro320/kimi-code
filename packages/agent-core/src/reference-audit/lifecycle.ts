export type ReferenceAuditLifecycleStatus = 'complete' | 'incomplete' | 'skipped' | 'cancelled';

export interface ReferenceAuditRunAttachment {
  readonly taskPath: string;
  readonly attachedAt: string;
  readonly confirmedBy: 'user';
}

export interface ReferenceAuditRunSnapshot {
  readonly runId: string;
  readonly referenceHash: string;
  readonly planHash?: string;
  readonly resultHash?: string;
  readonly status: ReferenceAuditLifecycleStatus;
  readonly missingEvidence: readonly string[];
  readonly riskOverrideUsed: boolean;
  readonly attachment?: ReferenceAuditRunAttachment;
}

export interface ReferenceAuditGateInput {
  readonly material: boolean;
  readonly currentReferenceHash?: string;
  readonly run?: ReferenceAuditRunSnapshot;
  readonly riskOverrideConfirmed?: boolean;
}

export interface ReferenceAuditGateDecision {
  readonly allowed: boolean;
  readonly state: 'not-required' | 'complete' | 'blocked' | 'audit-risk-accepted';
  readonly stale: boolean;
  readonly reason: string;
  readonly missingEvidence: readonly string[];
}

export function evaluateReferenceAuditGate(input: ReferenceAuditGateInput): ReferenceAuditGateDecision {
  if (!input.material) {
    return { allowed: true, state: 'not-required', stale: false, reason: 'No material reference dependency.', missingEvidence: [] };
  }
  const currentReferenceHashValid = input.currentReferenceHash !== undefined && /^[a-f0-9]{64}$/.test(input.currentReferenceHash);
  const stale = input.run !== undefined && currentReferenceHashValid &&
    input.run.referenceHash !== input.currentReferenceHash;
  const complete = currentReferenceHashValid
    && input.run?.status === 'complete'
    && /^[a-f0-9]{64}$/.test(input.run.referenceHash)
    && /^[a-f0-9]{64}$/.test(input.run.planHash ?? '')
    && /^[a-f0-9]{64}$/.test(input.run.resultHash ?? '')
    && input.run.missingEvidence.length === 0
    && !input.run.riskOverrideUsed
    && !stale;
  if (complete) {
    return { allowed: true, state: 'complete', stale: false, reason: 'Material references have a current complete audit.', missingEvidence: [] };
  }
  const missingEvidence = input.run?.missingEvidence ?? ['Reference audit has not been run.'];
  const reason = !currentReferenceHashValid
    ? 'Material reference state has no valid current reference hash.'
    : stale
      ? 'The material reference set changed after the recorded audit.'
      : `The material reference audit is ${input.run?.status ?? 'not-run'}.`;
  if (input.riskOverrideConfirmed === true && currentReferenceHashValid) {
    return { allowed: true, state: 'audit-risk-accepted', stale, reason, missingEvidence };
  }
  return { allowed: false, state: 'blocked', stale, reason, missingEvidence };
}

export function attachReferenceAuditRun(
  run: ReferenceAuditRunSnapshot,
  input: { readonly taskPath: string; readonly userConfirmed: boolean; readonly attachedAt?: string },
): ReferenceAuditRunSnapshot {
  if (!input.userConfirmed) throw new Error('Attaching a session-scoped reference audit requires per-run user confirmation.');
  const taskPath = input.taskPath.trim().replaceAll('\\', '/');
  if (!taskPath.startsWith('.trellis/tasks/') || taskPath.includes('..')) {
    throw new Error('Reference audit attachment requires a safe Trellis task path.');
  }
  if (run.attachment !== undefined && run.attachment.taskPath !== taskPath) {
    throw new Error('Reference audit run is already attached to another Trellis task.');
  }
  return {
    ...run,
    attachment: {
      taskPath,
      attachedAt: input.attachedAt ?? new Date().toISOString(),
      confirmedBy: 'user',
    },
  };
}
