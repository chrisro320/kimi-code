import { createHash } from 'node:crypto';

import type { AgentRecords } from '../agent/records';
import type { AgoraConfig } from '../config/schema';
import { hashReferenceSet } from '../reference-audit/hash';
import type { ReferenceDescriptor } from '../reference-audit/types';

import { DEFAULT_AGORA_PEER_ROUTES } from './packet';
import type { AgoraPeerRoutes } from './types';

/**
 * Canonical execution envelope for an Agora dispatch. The host computes a
 * SHA-256 over this envelope at approval time; the tool recomputes it at
 * execution time and rejects any mismatch (TOCTOU). No field in this
 * envelope may be caller-self-reported without being part of the hash.
 */
export interface AgoraExecutionEnvelope {
  readonly runId: string;
  readonly mode: 'planning' | 'acceptance';
  readonly exactQuestion: string;
  readonly desiredDecision: string;
  readonly projectState: string;
  readonly dissatisfactionOrUncertainty: string;
  readonly userGoal: string;
  readonly packetRevision: number;
  readonly redactionSummary: string;
  readonly recovery: boolean;
  readonly priorCoderResultOrDiff?: string;
  readonly currentArtifactOrDiff?: string;
  readonly expectedResultOrAcceptanceCriteria?: string;
  readonly actualResultOrCurrentProposal?: string;
  readonly relevantEvidence: readonly string[];
  readonly validationSignals: readonly string[];
  readonly constraints: readonly string[];
  readonly userPrioritiesAndTradeoffs: readonly string[];
  readonly qualityDeficiencies: readonly string[];
  readonly failedOrMissingValidation: readonly string[];
  readonly peerRoutes: AgoraPeerRoutes;
  readonly referenceMaterial: boolean;
  readonly referenceHash?: string;
  readonly necessitySignals: {
    readonly impactIfWrong: 'low' | 'medium' | 'high';
    readonly uncertaintyOrDisagreement: 'low' | 'medium' | 'high';
    readonly expectedInformationGain: 'low' | 'medium' | 'high';
    readonly incrementalCostLatency: 'low' | 'medium' | 'high';
  };
  readonly ambiguousSensitiveContentConfirmed: boolean;
  readonly necessityForceAfterDecline: boolean;
  readonly referenceAuditGateRiskOverrideConfirmed: boolean;
  readonly lifecycleEpoch: string;
}

/**
 * A one-time, hash-bound override approval. Each override (necessity
 * force-after-decline, reference risk-accept) is approved independently and
 * consumed exactly once at execution. A generic packet approval does NOT
 * cover either override.
 */
export interface AgoraOverrideApproval {
  readonly kind: 'necessity_force_after_decline' | 'reference_risk_override';
  readonly envelopeHash: string;
  /** Consumed when the tool execution reads it; cannot be reused. */
  consumed?: boolean;
}

/**
 * Metadata written by the permission policy into the execution context.
 * The packet approval binds the frozen envelope hash; the two override
 * approvals are independent and each carries the same envelope hash so a
 * generic approval cannot silently enable them.
 */
export interface AgoraApprovalMetadata {
  readonly agoraPacketConfirmed: true;
  readonly agoraEnvelopeHash: string;
  readonly agoraNecessityForceAfterDecline?: AgoraOverrideApproval;
  readonly agoraReferenceRiskOverride?: AgoraOverrideApproval;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
}

/**
 * Compute the SHA-256 of the canonical execution envelope. The same
 * envelope must produce the same hash at approval time and execution time.
 */
export function hashAgoraExecutionEnvelope(envelope: AgoraExecutionEnvelope): string {
  const canonical = canonicalJson({
    runId: envelope.runId,
    mode: envelope.mode,
    exactQuestion: envelope.exactQuestion,
    desiredDecision: envelope.desiredDecision,
    projectState: envelope.projectState,
    dissatisfactionOrUncertainty: envelope.dissatisfactionOrUncertainty,
    userGoal: envelope.userGoal,
    packetRevision: envelope.packetRevision,
    redactionSummary: envelope.redactionSummary,
    recovery: envelope.recovery,
    priorCoderResultOrDiff: envelope.priorCoderResultOrDiff,
    currentArtifactOrDiff: envelope.currentArtifactOrDiff,
    expectedResultOrAcceptanceCriteria: envelope.expectedResultOrAcceptanceCriteria,
    actualResultOrCurrentProposal: envelope.actualResultOrCurrentProposal,
    relevantEvidence: envelope.relevantEvidence,
    validationSignals: envelope.validationSignals,
    constraints: envelope.constraints,
    userPrioritiesAndTradeoffs: envelope.userPrioritiesAndTradeoffs,
    qualityDeficiencies: envelope.qualityDeficiencies,
    failedOrMissingValidation: envelope.failedOrMissingValidation,
    peerRoutes: envelope.peerRoutes,
    referenceMaterial: envelope.referenceMaterial,
    referenceHash: envelope.referenceHash,
    necessitySignals: envelope.necessitySignals,
    ambiguousSensitiveContentConfirmed: envelope.ambiguousSensitiveContentConfirmed,
    necessityForceAfterDecline: envelope.necessityForceAfterDecline,
    referenceAuditGateRiskOverrideConfirmed: envelope.referenceAuditGateRiskOverrideConfirmed,
    lifecycleEpoch: envelope.lifecycleEpoch,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

interface AgoraToolInputLike {
  readonly run_id: string;
  readonly mode: 'planning' | 'acceptance';
  readonly exact_question: string;
  readonly desired_decision: string;
  readonly project_state: string;
  readonly dissatisfaction_or_uncertainty: string;
  readonly user_goal: string;
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
  readonly reference_audit_gate?: {
    readonly material: boolean;
    readonly references?: readonly {
      readonly id: string;
      readonly label: string;
      readonly kind: string;
      readonly role: string;
      readonly location?: string;
      readonly trivial?: boolean;
    }[];
    readonly risk_override_confirmed?: boolean;
  };
  readonly necessity: {
    readonly impact_if_wrong: 'low' | 'medium' | 'high';
    readonly uncertainty_or_disagreement: 'low' | 'medium' | 'high';
    readonly expected_information_gain: 'low' | 'medium' | 'high';
    readonly incremental_cost_latency: 'low' | 'medium' | 'high';
    readonly force_after_decline?: boolean;
  };
  readonly ambiguous_sensitive_content_confirmed?: boolean;
}

/**
 * Resolve the default peer roster from config (`agora.peers` in config.toml).
 * An absent or empty roster falls back to the built-in default so Agora keeps
 * working before any roster is configured.
 */
export function resolveDefaultAgoraPeerRoutes(agoraConfig: AgoraConfig | undefined): AgoraPeerRoutes {
  const configured = agoraConfig?.peers;
  if (configured === undefined || Object.keys(configured).length === 0) {
    return DEFAULT_AGORA_PEER_ROUTES;
  }
  return Object.fromEntries(
    Object.entries(configured).map(([peerId, route]) => [peerId, {
      backend: route.backend,
      modelOverride: route.modelOverride,
      profileName: route.profileName,
      displayName: route.displayName,
      role: route.role,
    }]),
  );
}

function toPeerRoutes(args: AgoraToolInputLike, agoraConfig?: AgoraConfig): AgoraPeerRoutes {
  if (args.peers === undefined) {
    return resolveDefaultAgoraPeerRoutes(agoraConfig);
  }
  const routes = Object.fromEntries(
    Object.entries(args.peers).map(([peerId, route]) => [peerId, {
      backend: route.backend,
      modelOverride: route.model_override,
      profileName: route.profile_name,
      displayName: route.display_name,
      role: route.role,
    }]),
  );
  if (Object.keys(routes).length === 0) throw new Error('Agora requires at least one configured peer.');
  return routes;
}

/**
 * Build the canonical execution envelope from tool args, the durable
 * lifecycle record, and the configured default peer roster. Approval and
 * execution must both call this builder with the same inputs so that any
 * mutation of a hashed field invalidates authorization.
 */
export function buildAgoraExecutionEnvelope(
  args: AgoraToolInputLike,
  records: AgentRecords | undefined,
  agoraConfig?: AgoraConfig,
): AgoraExecutionEnvelope {
  const routes = toPeerRoutes(args, agoraConfig);
  const auditGate = args.reference_audit_gate ?? { material: false };
  const referenceMaterial = auditGate.material === true;
  const referenceHash = referenceMaterial && auditGate.references !== undefined
    ? hashReferenceSet(auditGate.references as readonly ReferenceDescriptor[])
    : undefined;
  const lifecycle = records?.latestAgoraLifecycle(args.run_id);
  return {
    runId: args.run_id,
    mode: args.mode,
    exactQuestion: args.exact_question,
    desiredDecision: args.desired_decision,
    projectState: args.project_state,
    dissatisfactionOrUncertainty: args.dissatisfaction_or_uncertainty,
    userGoal: args.user_goal,
    packetRevision: args.packet_revision,
    redactionSummary: args.redaction_summary,
    recovery: args.recovery,
    priorCoderResultOrDiff: args.prior_coder_result_or_diff,
    currentArtifactOrDiff: args.current_artifact_or_diff,
    expectedResultOrAcceptanceCriteria: args.expected_result_or_acceptance_criteria,
    actualResultOrCurrentProposal: args.actual_result_or_current_proposal,
    relevantEvidence: args.relevant_evidence ?? [],
    validationSignals: args.validation_signals ?? [],
    constraints: args.constraints ?? [],
    userPrioritiesAndTradeoffs: args.user_priorities_and_tradeoffs ?? [],
    qualityDeficiencies: args.quality_deficiencies ?? [],
    failedOrMissingValidation: args.failed_or_missing_validation ?? [],
    peerRoutes: routes,
    referenceMaterial,
    referenceHash,
    necessitySignals: {
      impactIfWrong: args.necessity.impact_if_wrong,
      uncertaintyOrDisagreement: args.necessity.uncertainty_or_disagreement,
      expectedInformationGain: args.necessity.expected_information_gain,
      incrementalCostLatency: args.necessity.incremental_cost_latency,
    },
    ambiguousSensitiveContentConfirmed: args.ambiguous_sensitive_content_confirmed === true,
    necessityForceAfterDecline: args.necessity.force_after_decline === true,
    referenceAuditGateRiskOverrideConfirmed: referenceMaterial
      && auditGate.references !== undefined
      && (auditGate as { risk_override_confirmed?: boolean }).risk_override_confirmed === true,
    lifecycleEpoch: lifecycle?.capabilityEpoch ?? '',
  };
}

/**
 * Mark an override approval as consumed. Once consumed, the same metadata
 * object cannot authorize a second dispatch. The tool execution calls this
 * after reading each override.
 */
export function consumeAgoraOverride(
  approval: AgoraOverrideApproval,
): AgoraOverrideApproval {
  if (approval.consumed === true) {
    throw new Error(`Agora ${approval.kind} override already consumed; one approval per dispatch.`);
  }
  return { ...approval, consumed: true };
}

/**
 * Verify that an override approval matches the current envelope hash and has
 * not been consumed. Returns the consumed approval on success.
 */
export function verifyAgoraOverride(
  approval: AgoraOverrideApproval | undefined,
  kind: AgoraOverrideApproval['kind'],
  envelopeHash: string,
): AgoraOverrideApproval {
  if (approval === undefined) {
    throw new Error(`Agora ${kind} requires an independent, explicit user approval.`);
  }
  if (approval.kind !== kind) {
    throw new Error(`Agora override kind mismatch: expected ${kind}, got ${approval.kind}.`);
  }
  if (approval.envelopeHash !== envelopeHash) {
    throw new Error(`Agora ${kind} override was approved for a different packet; refusing to apply.`);
  }
  return consumeAgoraOverride(approval);
}
