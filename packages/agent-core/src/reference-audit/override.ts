import { sha256 } from './hash';

export interface ReferenceAuditOverrideChallenge {
  readonly referenceHash: string;
  readonly auditRunId?: string;
  readonly purpose: 'agora' | 'editing-dispatch';
  /** Stable id of the single Agora run or editing dispatch this approval may authorize. */
  readonly operationId: string;
  readonly reason: string;
}

export function hashReferenceAuditOverride(challenge: ReferenceAuditOverrideChallenge): string {
  return sha256(challenge);
}
