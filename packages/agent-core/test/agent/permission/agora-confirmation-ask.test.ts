import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import type { PermissionMode, PermissionPolicyContext } from '../../../src/agent/permission';
import { AgoraConfirmationAskPermissionPolicy } from '../../../src/agent/permission/policies/agora-confirmation-ask';
import { ToolAccesses } from '../../../src/loop';

const signal = new AbortController().signal;

function context(
  name = 'Agora',
  forceAfterDecline = false,
  riskOverrideConfirmed = false,
): PermissionPolicyContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {},
    args: {
      run_id: 'run-test',
      mode: 'planning',
      user_goal: 'goal',
      exact_question: 'question',
      desired_decision: 'decision',
      project_state: 'state',
      dissatisfaction_or_uncertainty: 'uncertainty',
      host_initial_view: { position: 'pos', evidence: [], assumptions: [], confidence: 'low' },
      packet_revision: 1,
      redaction_summary: 'none',
      packet_confirmed: true,
      recovery: false,
      necessity: {
        impact_if_wrong: 'high',
        uncertainty_or_disagreement: 'high',
        expected_information_gain: 'high',
        incremental_cost_latency: 'medium',
        force_after_decline: forceAfterDecline,
      },
      reference_audit_gate: riskOverrideConfirmed
        ? { material: true, references: [{ id: 'ref1', label: 'Ref', kind: 'product', role: 'mixed' }], risk_override_confirmed: true }
        : { material: false },
    },
    toolCall: {
      type: 'function',
      id: 'call_agora',
      name,
      arguments: '{}',
    } satisfies ToolCall,
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: name,
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

function policy(mode: PermissionMode, withApproval = true) {
  return new AgoraConfirmationAskPermissionPolicy({
    permission: { mode },
    rpc: withApproval ? { requestApproval: async () => ({ decision: 'approved' as const }) } : undefined,
  } as never);
}

describe('AgoraConfirmationAskPermissionPolicy', () => {
  it('ignores non-Agora tools', () => {
    expect(policy('auto').evaluate(context('Bash'))).toBeUndefined();
  });

  it.each(['manual', 'yolo', 'auto'] as const)('requires a per-run user decision in %s mode', (mode) => {
    expect(policy(mode).evaluate(context())).toMatchObject({ kind: 'ask' });
  });

  it.each(['manual', 'yolo', 'auto'] as const)('fails closed without an approval surface in %s mode', (mode) => {
    expect(policy(mode, false).evaluate(context())).toMatchObject({
      kind: 'deny',
      message: expect.stringContaining('interactive user approval surface'),
    });
  });

  it('passes confirmation metadata only after explicit approval', () => {
    const result = policy('auto').evaluate(context('Agora', true, true));
    if (result?.kind !== 'ask') throw new Error('expected ask');
    const approved = result.resolveApproval?.({ decision: 'approved' });
    if (approved?.kind !== 'approve') throw new Error('expected approved result');
    const metadata = approved.executionMetadata as Record<string, unknown>;
    expect(metadata['agoraPacketConfirmed']).toBe(true);
    expect(typeof metadata['agoraEnvelopeHash']).toBe('string');
    expect(metadata['agoraEnvelopeHash']).toHaveLength(64);
    expect(metadata['agoraNecessityForceAfterDecline']).toMatchObject({
      kind: 'necessity_force_after_decline',
      envelopeHash: metadata['agoraEnvelopeHash'],
    });
    expect(metadata['agoraReferenceRiskOverride']).toMatchObject({
      kind: 'reference_risk_override',
      envelopeHash: metadata['agoraEnvelopeHash'],
    });
    expect(result.resolveApproval?.({ decision: 'rejected' })).toBeUndefined();
  });
});
