import type { Agent } from '../..';
import { hashReferenceAuditOverride } from '../../../reference-audit/override';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class ReferenceAuditOverrideAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'reference-audit-override-ask';
  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'ReferenceAuditOverride') return;
    if (this.agent.rpc?.requestApproval === undefined) return { kind: 'deny', message: 'Reference risk override requires an interactive approval surface.' };
    const args = context.args as { reference_hash?: unknown; audit_run_id?: unknown; purpose?: unknown; operation_id?: unknown; reason?: unknown } | undefined;
    if (typeof args?.reference_hash !== 'string' || (args.purpose !== 'agora' && args.purpose !== 'editing-dispatch') || typeof args.operation_id !== 'string' || args.operation_id.trim().length === 0 || typeof args.reason !== 'string') {
      return { kind: 'deny', message: 'Reference risk override challenge is invalid.' };
    }
    const hash = hashReferenceAuditOverride({
      referenceHash: args.reference_hash,
      auditRunId: typeof args.audit_run_id === 'string' ? args.audit_run_id : undefined,
      purpose: args.purpose,
      operationId: args.operation_id,
      reason: args.reason,
    });
    return {
      kind: 'ask',
      resolveApproval: (response) => response.decision === 'approved'
        ? { kind: 'approve', executionMetadata: { referenceAuditOverrideHash: hash, referenceAuditOverrideOperationId: args.operation_id } }
        : undefined,
    };
  }
}
