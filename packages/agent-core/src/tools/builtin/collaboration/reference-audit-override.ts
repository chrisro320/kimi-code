import { z } from 'zod';

import type { Agent } from '../../../agent';
import type { BuiltinTool } from '../../../agent/tool';
import { hashReferenceAuditOverride } from '../../../reference-audit/override';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const ReferenceAuditOverrideSchema = z.object({
  reference_hash: z.string().regex(/^[a-f0-9]{64}$/),
  audit_run_id: z.string().min(1).optional(),
  purpose: z.enum(['agora', 'editing-dispatch']),
  operation_id: z.string().trim().min(1),
  reason: z.string().min(1),
});

type Input = z.infer<typeof ReferenceAuditOverrideSchema>;

export class ReferenceAuditOverrideTool implements BuiltinTool<Input> {
  readonly name = 'ReferenceAuditOverride' as const;
  readonly description = 'Request one explicit, hash-bound risk acceptance for an incomplete material reference audit; the approval is consumed once.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReferenceAuditOverrideSchema);

  constructor(private readonly records: Agent['records']) {}

  resolveExecution(args: Input): ToolExecution {
    const challenge = {
      referenceHash: args.reference_hash,
      auditRunId: args.audit_run_id,
      purpose: args.purpose,
      operationId: args.operation_id,
      reason: args.reason,
    };
    const hash = hashReferenceAuditOverride(challenge);
    return {
      description: `Accept incomplete reference evidence for one ${args.purpose} operation`,
      accesses: ToolAccesses.none(),
      display: { kind: 'generic', summary: `Accept reference-audit risk once (${hash})`, detail: challenge },
      approvalRule: this.name,
      execute: (context) => this.execution(challenge, hash, context),
    };
  }

  private async execution(
    challenge: Parameters<typeof hashReferenceAuditOverride>[0],
    hash: string,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const metadata = context.metadata as { referenceAuditOverrideHash?: unknown } | undefined;
    if (metadata?.referenceAuditOverrideHash !== hash) {
      return { output: 'Reference audit override requires current explicit approval bound to this challenge hash.', isError: true };
    }
    const existing = this.records.history('reference_audit.override')
      .find((record) => record.operationId === challenge.operationId);
    if (existing !== undefined) {
      return { output: 'Reference audit override has already been issued for this operation.', isError: true };
    }
    this.records.logRecord({ type: 'reference_audit.override', ...challenge, overrideHash: hash, state: 'approved' });
    return { output: JSON.stringify({ overrideHash: hash, operationId: challenge.operationId, state: 'approved', oneTime: true }) };
  }
}
