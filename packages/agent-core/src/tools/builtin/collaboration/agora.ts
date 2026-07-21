import { z } from 'zod';

import {
  buildAgoraPeerPacket,
  buildAgoraRecoveryTask,
  evaluateAgoraNecessity,
  runAgoraPeerReview,
  scanAgoraPacket,
  buildAgoraExecutionEnvelope,
  hashAgoraExecutionEnvelope,
  verifyAgoraOverride,
  resolveAgoraLifecycleForDispatch,
  type AgoraApprovalMetadata,
  type AgoraPacketInput,
} from '../../../agora';
import type { BuiltinTool } from '../../../agent/tool';
import type { Agent } from '../../../agent';
import { isAbortError } from '../../../loop/errors';
import {
  evaluateReferenceAuditGate,
  hashReferenceSet,
  isCompleteReferenceAuditRecord,
  missingEvidenceForReferenceAuditRun,
} from '../../../reference-audit';
import { redactUntrustedRaw, redactUntrustedValue } from '../../../security/redaction';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';

const StringList = z.array(z.string().trim().min(1)).optional();
const ReferenceDescriptorSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  kind: z.enum(['product', 'project', 'repository', 'link', 'media']),
  role: z.enum(['behavioral', 'visual', 'technical', 'mixed']),
  location: z.string().trim().min(1).optional(),
  trivial: z.boolean().optional(),
});

export const AgoraToolInputSchema = z.object({
  run_id: z.string().trim().min(1),
  mode: z.enum(['planning', 'acceptance']),
  user_goal: z.string().trim().min(1),
  exact_question: z.string().trim().min(1),
  desired_decision: z.string().trim().min(1),
  project_state: z.string().trim().min(1),
  dissatisfaction_or_uncertainty: z.string().trim().min(1),
  host_initial_view: z.object({
    position: z.string().trim().min(1),
    evidence: z.array(z.string()),
    assumptions: z.array(z.string()),
    confidence: z.enum(['low', 'medium', 'high']),
    strongest_counterexample: z.string().trim().min(1).optional(),
  }),
  current_artifact_or_diff: z.string().optional(),
  expected_result_or_acceptance_criteria: z.string().optional(),
  actual_result_or_current_proposal: z.string().optional(),
  relevant_evidence: StringList,
  validation_signals: StringList,
  constraints: StringList,
  user_priorities_and_tradeoffs: StringList,
  quality_deficiencies: StringList,
  failed_or_missing_validation: StringList,
  prior_coder_result_or_diff: z.string().optional(),
  packet_revision: z.number().int().min(1),
  redaction_summary: z.string(),
  packet_confirmed: z.literal(true),
  ambiguous_sensitive_content_confirmed: z.boolean().default(false),
  reference_audit_gate: z.discriminatedUnion('material', [
    z.object({ material: z.literal(false) }),
    z.object({
      material: z.literal(true),
      references: z.array(ReferenceDescriptorSchema).min(1),
      risk_override_confirmed: z.boolean().default(false),
    }),
  ]),
  necessity: z.object({
    impact_if_wrong: z.enum(['low', 'medium', 'high']),
    uncertainty_or_disagreement: z.enum(['low', 'medium', 'high']),
    expected_information_gain: z.enum(['low', 'medium', 'high']),
    incremental_cost_latency: z.enum(['low', 'medium', 'high']),
    force_after_decline: z.boolean().default(false),
  }),
  recovery: z.boolean(),
  peers: z.record(z.string().trim().min(1), z.object({
    backend: z.string().trim().min(1),
    model_override: z.string().trim().min(1).optional(),
    profile_name: z.string().trim().min(1).optional(),
    display_name: z.string().trim().min(1).optional(),
    role: z.string().trim().min(1).optional(),
  })).optional(),
});

export type AgoraToolInput = z.infer<typeof AgoraToolInputSchema>;

/**
 * Explicit, default-off Agora peer-review primitive. The host remains the only
 * user-facing synthesizer; this tool runs a configured roster of independent,
 * read-only peers.
 */
export class AgoraTool implements BuiltinTool<AgoraToolInput> {
  readonly name = 'Agora' as const;
  readonly description = [
    'Run the explicitly confirmed Agora cross-agent review stack.',
    'Default off. Use only after the necessity gate, old-task decoupling, packet redaction, and user packet confirmation.',
    'It dispatches a byte-equivalent packet to every configured read-only peer through the existing SessionSubagentHost; it never edits files or materializes tasks.',
  ].join(' ');
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgoraToolInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly records?: Agent['records'],
  ) {}

  resolveExecution(args: AgoraToolInput): ToolExecution {
    return {
      description: `Running Agora peer review: ${args.exact_question}`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'agent_call',
        agent_name: 'Agora',
        prompt: args.exact_question,
      },
      approvalRule: this.name,
      execute: (context) => this.execution(args, context),
    };
  }

  private async execution(
    args: AgoraToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const confirmation = context.metadata as AgoraApprovalMetadata | undefined;
    if (confirmation?.agoraPacketConfirmed !== true) {
      return { output: 'Agora requires explicit host/user packet confirmation.', isError: true };
    }
    // TOCTOU gate: recompute the canonical execution envelope hash from the
    // current tool args and durable lifecycle state. Approval uses the same
    // builder, so any mutation of a hashed field invalidates authorization.
    const envelope = buildAgoraExecutionEnvelope(args, this.records);
    const envelopeHash = hashAgoraExecutionEnvelope(envelope);
    if (confirmation.agoraEnvelopeHash !== envelopeHash) {
      return {
        output:
          'Agora packet was modified after user approval (envelope hash mismatch); re-confirm the frozen packet before dispatch.',
        isError: true,
      };
    }
    // Lifecycle gate: the durable `agora.lifecycle` record (not any caller-
    // supplied token) is the authorization source for peer dispatch. It must
    // describe a real inserted task in a dispatch-allowed phase.
    const lifecycle = resolveAgoraLifecycleForDispatch(this.records, args.run_id);
    if (lifecycle === undefined) {
      return {
        output:
          'Agora run has no durable inserted-task record in a dispatch-allowed phase; refusing peer dispatch.',
        isError: true,
      };
    }
    // Independent override approvals: necessity force-after-decline and
    // reference risk-accept are each hash-bound, one-time, and approved
    // separately. A generic packet approval does NOT cover either override.
    let necessityForceAfterDecline = false;
    if (args.necessity.force_after_decline) {
      try {
        verifyAgoraOverride(
          confirmation.agoraNecessityForceAfterDecline,
          'necessity_force_after_decline',
          envelopeHash,
        );
        if (this.records?.claimAgoraOverride({ operationId: args.run_id, kind: 'necessity_force_after_decline', envelopeHash }) !== true) {
          throw new Error('Agora necessity override was already consumed for this run.');
        }
        necessityForceAfterDecline = true;
      } catch (error) {
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    }
    const routes = envelope.peerRoutes;
    const auditGate = args.reference_audit_gate;
    const referenceMaterial = auditGate.material === true;
    const referenceHash = auditGate.material === true
      ? hashReferenceSet(auditGate.references)
      : undefined;
    const durableReferenceState = this.records?.latest('reference_audit.state');
    const effectiveMaterial = durableReferenceState?.material === true || referenceMaterial;
    const currentReferenceHash = durableReferenceState?.material === true
      ? (durableReferenceState.referenceHash ?? hashReferenceSet(durableReferenceState.references))
      : referenceHash;
    const latestAudit = effectiveMaterial
      ? this.records?.latest('reference_audit.run')
      : undefined;
    let referenceRiskOverrideConfirmed = false;
    if (auditGate.material === true && auditGate.risk_override_confirmed === true) {
      try {
        verifyAgoraOverride(
          confirmation.agoraReferenceRiskOverride,
          'reference_risk_override',
          envelopeHash,
        );
        if (this.records?.claimAgoraOverride({ operationId: args.run_id, kind: 'reference_risk_override', envelopeHash }) !== true) {
          throw new Error('Agora reference risk override was already consumed for this run.');
        }
        referenceRiskOverrideConfirmed = true;
      } catch (error) {
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    }
    const durableOverride = this.records?.latest('reference_audit.override');
    const durableOverrideApproved = durableOverride?.state === 'approved'
      && durableOverride.purpose === 'agora'
      && durableOverride.operationId === args.run_id
      && durableOverride.referenceHash === currentReferenceHash;
    if (durableOverrideApproved) referenceRiskOverrideConfirmed = true;
    const completeRecord = isCompleteReferenceAuditRecord(latestAudit, currentReferenceHash);
    const auditDecision = effectiveMaterial
      ? evaluateReferenceAuditGate({
          material: true,
          currentReferenceHash,
          run: latestAudit === undefined ? undefined : {
            runId: latestAudit.runId,
            referenceHash: latestAudit.referenceHash ?? '',
            planHash: latestAudit.planHash,
            resultHash: latestAudit.resultHash,
            status: completeRecord ? 'complete' : 'incomplete',
            missingEvidence: missingEvidenceForReferenceAuditRun(latestAudit, currentReferenceHash),
            riskOverrideUsed: false,
          },
          riskOverrideConfirmed: referenceRiskOverrideConfirmed,
        })
      : evaluateReferenceAuditGate({ material: false });
    if (!auditDecision.allowed) {
      return {
        output: `Agora blocked: ${auditDecision.reason} Complete or refresh ReferenceAudit, or obtain one explicit user risk override that preserves the incomplete/stale status.`,
        isError: true,
      };
    }
    if (auditDecision.state === 'audit-risk-accepted' && durableOverrideApproved && durableOverride !== undefined) {
      const claimed = this.records?.claimReferenceAuditOverride({
        operationId: args.run_id,
        purpose: 'agora',
        referenceHash: durableOverride.referenceHash,
        overrideHash: durableOverride.overrideHash,
        consumedBy: args.run_id,
      });
      if (claimed !== true) {
        return { output: 'Agora blocked: reference audit override was already consumed or does not match this run.', isError: true };
      }
    }
    const referenceAuditGateRecord = {
      state: auditDecision.state,
      currentReferenceHash,
      auditRunId: latestAudit?.runId,
      auditReferenceHash: latestAudit?.referenceHash,
      riskOverrideConfirmed: auditDecision.state === 'audit-risk-accepted',
      reason: auditDecision.reason,
    };
    let packet: ReturnType<typeof buildAgoraPeerPacket> | undefined;
    let durablePacket: Record<string, unknown> | undefined;
    let necessity: ReturnType<typeof evaluateAgoraNecessity> | undefined;
    try {
      context.signal.throwIfAborted();
      necessity = evaluateAgoraNecessity({
        impactIfWrong: args.necessity.impact_if_wrong,
        uncertaintyOrDisagreement: args.necessity.uncertainty_or_disagreement,
        expectedInformationGain: args.necessity.expected_information_gain,
        incrementalCostLatency: args.necessity.incremental_cost_latency,
      }, { forceAfterDecline: necessityForceAfterDecline });
      packet = buildAgoraPeerPacket(toPacketInput(args), routes);
      durablePacket = redactUntrustedValue(packet) as Record<string, unknown>;
      if (necessity.outcome === 'declined' && !necessity.forcedByUser) {
        const peerIds = Object.keys(routes);
        this.records?.logRecord({
          type: 'agora.run',
          runId: packet.runId,
          phase: 'declined',
          packetRevision: packet.packetRevision,
          packet: durablePacket,
          insertedTask: lifecycle.insertedTask,
          originTask: lifecycle.originTask,
          necessity,
          referenceAuditGate: referenceAuditGateRecord,
          routes,
          peers: peerIds.map((peer) => ({ peer, status: 'unavailable' as const, repairCount: 0 })),
          temporaryOverrides: Object.fromEntries(peerIds.map((peer) => [peer, 'disposed' as const])),
          hostRoute: packet.hostRoute,
          routeUpgrade: packet.routeUpgrade,
          terminalState: 'declined',
        });
        return {
          output: `Agora declined: ${necessity.explanation} ${necessity.normalWorkflowRecommendation}`,
          isError: true,
        };
      }
      const security = scanAgoraPacket(packet);
      if (security.blocked.length > 0) {
        throw new Error(`Agora packet contains blocked sensitive content: ${security.blocked.join(', ')}.`);
      }
      if (security.requiresConfirmation.length > 0 && !args.ambiguous_sensitive_content_confirmed) {
        throw new Error(
          `Agora packet contains ambiguous sensitive content requiring explicit confirmation: ${security.requiresConfirmation.join(', ')}.`,
        );
      }
      let hostRecoveryResult: string | undefined;
      let hostRecoveryFallbackReason: string | undefined;
      if (args.recovery) {
        const [hostResult] = await this.subagentHost.runQueued([
          { ...buildAgoraRecoveryTask(packet, context.toolCallId), signal: context.signal },
        ]);
        if (hostResult?.status === 'completed') {
          hostRecoveryResult = hostResult.result ?? '';
        } else {
          hostRecoveryFallbackReason = hostResult?.error ?? hostResult?.status ?? 'missing result';
        }
      }
      const peerIds = Object.keys(routes);
      const activeOverrides = Object.fromEntries(peerIds.map((peer) => [peer, 'active' as const]));
      this.records?.logRecord({
        type: 'agora.run',
        runId: packet.runId,
        phase: 'peer_review',
        packetRevision: packet.packetRevision,
        packet: durablePacket,
        insertedTask: lifecycle.insertedTask,
        originTask: lifecycle.originTask,
        necessity,
        referenceAuditGate: referenceAuditGateRecord,
        routes,
        peers: peerIds.map((peer) => ({ peer, status: 'pending' as const, repairCount: 0 })),
        temporaryOverrides: activeOverrides,
        hostRoute: packet.hostRoute,
        routeUpgrade: packet.routeUpgrade,
      });
      let results: Awaited<ReturnType<typeof runAgoraPeerReview>>;
      try {
        results = await runAgoraPeerReview(
          this.subagentHost,
          packet,
          routes,
          context.toolCallId,
          context.signal,
        );
      } catch (error) {
        if (isAbortError(error) || context.signal.aborted) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        const redactedReason = redactUntrustedRaw(reason).redacted;
        const redactedHostRecoveryResult = hostRecoveryResult === undefined
          ? undefined
          : redactUntrustedRaw(hostRecoveryResult).redacted;
        const redactedHostRecoveryFallbackReason = hostRecoveryFallbackReason === undefined
          ? undefined
          : redactUntrustedRaw(hostRecoveryFallbackReason).redacted;
        const unavailablePeers = peerIds.map((peer) => ({
          peer,
          backend: routes?.[peer]?.backend,
          model: routes?.[peer]?.modelOverride,
          role: routes?.[peer]?.role,
          reason: redactedReason,
          packet: durablePacket,
        }));
        this.records?.logRecord({
          type: 'agora.run',
          runId: packet.runId,
          phase: 'synthesis',
          packetRevision: packet.packetRevision,
          packet: durablePacket,
          insertedTask: lifecycle.insertedTask,
          originTask: lifecycle.originTask,
          necessity,
          referenceAuditGate: referenceAuditGateRecord,
          routes,
          peers: peerIds.map((peer) => ({
            peer,
            backend: routes?.[peer]?.backend,
            model: routes?.[peer]?.modelOverride,
            status: 'unavailable' as const,
            error: redactedReason,
            repairCount: 0,
          })),
          temporaryOverrides: Object.fromEntries(peerIds.map((peer) => [peer, 'disposed' as const])),
          hostRoute: packet.hostRoute,
          routeUpgrade: packet.routeUpgrade,
          hostRecoveryResult: redactedHostRecoveryResult,
          terminalState: 'fallback_required',
        });
        return {
          output: JSON.stringify({
            runId: packet.runId,
            fallbackRequired: true,
            fallbackPolicy: 'The peer runtime failed before usable peer results were returned. The main model must cover each missing peer separately, label it main-model fallback, preserve unknowns and dissent, and never count it as independent peer agreement or Agora consensus.',
            fallbackPeers: unavailablePeers,
            hostRecoveryFallback: redactedHostRecoveryFallbackReason === undefined
              ? undefined
              : { reason: redactedHostRecoveryFallbackReason, packet: durablePacket },
            packetRevision: packet.packetRevision,
            hostRoute: packet.hostRoute,
            routeUpgrade: packet.routeUpgrade,
            hostRecoveryResult: redactedHostRecoveryResult,
            routes,
            results: [],
          }),
        };
      }
      context.signal.throwIfAborted();
      const fallbackPeers = results.flatMap(({ peer, normalization }) =>
        normalization.status === 'completed'
          ? []
          : [{
              peer,
              backend: routes?.[peer]?.backend,
              model: routes?.[peer]?.modelOverride,
              role: routes?.[peer]?.role,
              reason: normalization.status === 'unavailable'
                ? redactUntrustedRaw(normalization.reason).redacted
                : 'peer response requires unresolved contract repair',
              packet: durablePacket,
            }],
      );
      const fallbackRequired = fallbackPeers.length > 0 || hostRecoveryFallbackReason !== undefined;
      const redactedHostRecoveryResult = hostRecoveryResult === undefined
        ? undefined
        : redactUntrustedRaw(hostRecoveryResult).redacted;
      const redactedHostRecoveryFallbackReason = hostRecoveryFallbackReason === undefined
        ? undefined
        : redactUntrustedRaw(hostRecoveryFallbackReason).redacted;
      const persistedPeers = results.map(({
        peer,
        result,
        normalization,
        initialRawResponse,
        repairRawResponse,
        repairCount,
      }) => ({
        peer,
        backend: routes?.[peer]?.backend,
        model: routes?.[peer]?.modelOverride,
        status: normalization.status === 'completed' ? 'completed' as const : 'unavailable' as const,
        initialRawResponse: redactUntrustedRaw(initialRawResponse).redacted,
        repairRawResponse: repairRawResponse === undefined ? undefined : redactUntrustedRaw(repairRawResponse).redacted,
        normalizedResponse: normalization.status === 'completed'
          ? redactUntrustedValue(normalization.response) as Record<string, unknown>
          : undefined,
        error: normalization.status === 'unavailable'
          ? redactUntrustedRaw(normalization.reason).redacted
          : result.error === undefined ? undefined : redactUntrustedRaw(result.error).redacted,
        repairCount,
      }));
      this.records?.logRecord({
        type: 'agora.run',
        runId: packet.runId,
        phase: 'synthesis',
        packetRevision: packet.packetRevision,
        packet: durablePacket,
        insertedTask: lifecycle.insertedTask,
        originTask: lifecycle.originTask,
        necessity,
        referenceAuditGate: referenceAuditGateRecord,
        routes,
        peers: persistedPeers,
        temporaryOverrides: Object.fromEntries(peerIds.map((peer) => [peer, 'disposed' as const])),
        hostRoute: packet.hostRoute,
        routeUpgrade: packet.routeUpgrade,
        hostRecoveryResult: redactedHostRecoveryResult,
        terminalState: fallbackRequired ? 'fallback_required' : 'converged',
      });
      return {
        output: JSON.stringify({
          runId: packet.runId,
          fallbackRequired,
          fallbackPolicy: fallbackRequired
            ? 'The main model must cover each missing peer/recovery analysis separately, label it main-model fallback, preserve unknowns and dissent, and never count it as independent peer agreement or Agora consensus.'
            : undefined,
          fallbackPeers,
          hostRecoveryFallback: redactedHostRecoveryFallbackReason === undefined
            ? undefined
            : { reason: redactedHostRecoveryFallbackReason, packet: durablePacket },
          packetRevision: packet.packetRevision,
          hostRoute: packet.hostRoute,
          routeUpgrade: packet.routeUpgrade,
          hostRecoveryResult: redactedHostRecoveryResult,
          routes,
          results: results.map(({ peer, result, normalization, repairCount }) => ({
            peer,
            backend: routes?.[peer]?.backend,
            model: routes?.[peer]?.modelOverride,
            agentId: result.agentId,
            status: result.status,
            normalization: redactUntrustedValue(normalization),
            repairCount,
            state: result.state,
            result: redactUntrustedValue(result.result),
            error: result.error === undefined ? undefined : redactUntrustedRaw(result.error).redacted,
          })),
        }),
      };
    } catch (error) {
      if (isAbortError(error) || context.signal.aborted) throw error;
      const redactedOuterError = redactUntrustedRaw(
        error instanceof Error ? error.message : String(error),
      ).redacted;
      if (packet !== undefined && necessity !== undefined) {
        const peerIds = Object.keys(routes);
        this.records?.logRecord({
          type: 'agora.run',
          runId: packet.runId,
          phase: 'failed',
          packetRevision: packet.packetRevision,
          packet: durablePacket ?? (redactUntrustedValue(packet) as Record<string, unknown>),
          insertedTask: lifecycle.insertedTask,
          originTask: lifecycle.originTask,
          necessity,
          referenceAuditGate: referenceAuditGateRecord,
          routes,
          peers: peerIds.map((peer) => ({
            peer,
            status: 'unavailable' as const,
            error: redactedOuterError,
            repairCount: 0,
          })),
          temporaryOverrides: Object.fromEntries(peerIds.map((peer) => [peer, 'disposed' as const])),
          hostRoute: packet.hostRoute,
          routeUpgrade: packet.routeUpgrade,
          terminalState: 'failed',
        });
      }
      return {
        output: `Agora peer review unavailable: ${redactedOuterError}`,
        isError: true,
      };
    }
  }
}

function toPacketInput(args: AgoraToolInput): AgoraPacketInput {
  return {
    runId: args.run_id,
    mode: args.mode,
    userGoal: args.user_goal,
    exactQuestion: args.exact_question,
    desiredDecision: args.desired_decision,
    projectState: args.project_state,
    dissatisfactionOrUncertainty: args.dissatisfaction_or_uncertainty,
    hostInitialView: {
      position: args.host_initial_view.position,
      evidence: args.host_initial_view.evidence,
      assumptions: args.host_initial_view.assumptions,
      confidence: args.host_initial_view.confidence,
      strongestCounterexample: args.host_initial_view.strongest_counterexample,
    },
    currentArtifactOrDiff: args.current_artifact_or_diff,
    expectedResultOrAcceptanceCriteria: args.expected_result_or_acceptance_criteria,
    actualResultOrCurrentProposal: args.actual_result_or_current_proposal,
    relevantEvidence: args.relevant_evidence,
    validationSignals: args.validation_signals,
    constraints: args.constraints,
    userPrioritiesAndTradeoffs: args.user_priorities_and_tradeoffs,
    qualityDeficiencies: args.quality_deficiencies,
    failedOrMissingValidation: args.failed_or_missing_validation,
    priorCoderResultOrDiff: args.prior_coder_result_or_diff,
    packetRevision: args.packet_revision,
    redactionSummary: args.redaction_summary,
    recovery: args.recovery,
  };
}
