import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import {
  buildAgoraExecutionEnvelope,
  hashAgoraExecutionEnvelope,
  type AgoraApprovalMetadata,
  type AgoraOverrideApproval,
} from '../../../agora/approval';

interface AgoraToolArgs {
  readonly run_id: string;
  readonly mode: 'planning' | 'acceptance';
  readonly user_goal: string;
  readonly exact_question: string;
  readonly desired_decision: string;
  readonly project_state: string;
  readonly dissatisfaction_or_uncertainty: string;
  readonly packet_revision: number;
  readonly redaction_summary: string;
  readonly recovery: boolean;
  readonly prior_coder_result_or_diff?: string;
  readonly current_artifact_or_diff?: string;
  readonly expected_result_or_acceptance_criteria?: string;
  readonly actual_result_or_current_proposal?: string;
  readonly relevant_evidence?: readonly string[];
  readonly validation_signals?: readonly string[];
  readonly constraints?: readonly string[];
  readonly user_priorities_and_tradeoffs?: readonly string[];
  readonly quality_deficiencies?: readonly string[];
  readonly failed_or_missing_validation?: readonly string[];
  readonly peers?: Readonly<Record<string, {
    readonly backend: string;
    readonly model_override?: string;
    readonly profile_name?: string;
    readonly display_name?: string;
    readonly role?: string;
  }>>;
  readonly ambiguous_sensitive_content_confirmed?: boolean;
  readonly reference_audit_gate?: {
    readonly material: boolean;
    readonly references?: readonly { id: string; label: string; kind: string; role: string; location?: string; trivial?: boolean }[];
    readonly risk_override_confirmed?: boolean;
  };
  readonly necessity: {
    readonly impact_if_wrong: 'low' | 'medium' | 'high';
    readonly uncertainty_or_disagreement: 'low' | 'medium' | 'high';
    readonly expected_information_gain: 'low' | 'medium' | 'high';
    readonly incremental_cost_latency: 'low' | 'medium' | 'high';
    readonly force_after_decline?: boolean;
  };
}

/** Agora packet dispatch must be approved by the host UI, not asserted by model args. */
export class AgoraConfirmationAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'agora-confirmation-ask';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'Agora') return;
    if (this.agent.rpc?.requestApproval === undefined) {
      return {
        kind: 'deny',
        message: 'Agora requires an interactive user approval surface; this session cannot confirm the packet.',
      };
    }
    const args = context.args as AgoraToolArgs | undefined;
    if (args === undefined) {
      return {
        kind: 'deny',
        message: 'Agora tool call is missing required arguments for packet approval.',
      };
    }
    // Compute the canonical execution envelope hash from the exact args the
    // model is submitting and the durable lifecycle epoch. This hash is frozen
    // at approval time; the tool recomputes it at execution time and rejects
    // any mismatch (TOCTOU).
    const envelope = buildAgoraExecutionEnvelope(args, this.agent.records, this.agent.kimiConfig?.agora);
    const envelopeHash = hashAgoraExecutionEnvelope(envelope);
    const needsNecessityOverride = args.necessity.force_after_decline === true;
    const needsReferenceOverride =
      args.reference_audit_gate?.material === true
      && args.reference_audit_gate.risk_override_confirmed === true;

    return {
      kind: 'ask',
      resolveApproval: (response) => {
        if (response.decision !== 'approved') return undefined;
        // Necessity force-after-decline and reference risk-accept are
        // independent, hash-bound, one-time approvals. A generic packet
        // approval does NOT cover either override. The model must request
        // and the user must grant each override explicitly and separately.
        const necessityOverride: AgoraOverrideApproval | undefined = needsNecessityOverride
          ? { kind: 'necessity_force_after_decline', envelopeHash }
          : undefined;
        const referenceOverride: AgoraOverrideApproval | undefined = needsReferenceOverride
          ? { kind: 'reference_risk_override', envelopeHash }
          : undefined;
        const metadata: AgoraApprovalMetadata = {
          agoraPacketConfirmed: true,
          agoraEnvelopeHash: envelopeHash,
          agoraNecessityForceAfterDecline: necessityOverride,
          agoraReferenceRiskOverride: referenceOverride,
        };
        return { kind: 'approve', executionMetadata: metadata };
      },
    };
  }
}
