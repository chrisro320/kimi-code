import { describe, expect, it, vi } from 'vitest';

import {
  buildAgoraExecutionEnvelope,
  hashAgoraExecutionEnvelope,
  type AgoraExecutionEnvelope,
} from '../../src/agora/approval';
import { AgoraTool, type AgoraToolInput } from '../../src/tools/builtin/collaboration/agora';
import { hashReferenceSet } from '../../src/reference-audit';

const signal = new AbortController().signal;

function runnable(execution: ReturnType<AgoraTool['resolveExecution']>) {
  if ('execute' in execution) return execution;
  throw new Error(execution.message ?? 'expected runnable tool execution');
}

function baseInput(overrides: Partial<AgoraToolInput> = {}): AgoraToolInput {
  return {
    run_id: 'run-adv',
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
    ambiguous_sensitive_content_confirmed: false,
    reference_audit_gate: { material: false },
    necessity: {
      impact_if_wrong: 'high',
      uncertainty_or_disagreement: 'high',
      expected_information_gain: 'high',
      incremental_cost_latency: 'medium',
      force_after_decline: false,
    },
    recovery: false,
    ...overrides,
  };
}

function envelopeForInput(input: AgoraToolInput): AgoraExecutionEnvelope {
  const routes = input.peers === undefined
    ? { claude: { backend: 'claude-code', modelOverride: 'Opus 4.8' }, grok: { backend: 'kimi', modelOverride: 'kimicode-grok-4.5' } }
    : Object.fromEntries(
        Object.entries(input.peers).map(([peerId, route]) => [peerId, {
          backend: route.backend,
          modelOverride: route.model_override,
          profileName: route.profile_name,
          displayName: route.display_name,
          role: route.role,
        }]),
      );
  const referenceMaterial = input.reference_audit_gate.material;
  const referenceHash = referenceMaterial
    ? hashReferenceSet(input.reference_audit_gate.references)
    : undefined;
  return {
    runId: input.run_id,
    mode: input.mode,
    exactQuestion: input.exact_question,
    desiredDecision: input.desired_decision,
    projectState: input.project_state,
    dissatisfactionOrUncertainty: input.dissatisfaction_or_uncertainty,
    userGoal: input.user_goal,
    packetRevision: input.packet_revision,
    redactionSummary: input.redaction_summary,
    recovery: input.recovery,
    priorCoderResultOrDiff: input.prior_coder_result_or_diff,
    currentArtifactOrDiff: input.current_artifact_or_diff,
    expectedResultOrAcceptanceCriteria: input.expected_result_or_acceptance_criteria,
    actualResultOrCurrentProposal: input.actual_result_or_current_proposal,
    relevantEvidence: input.relevant_evidence ?? [],
    validationSignals: input.validation_signals ?? [],
    constraints: input.constraints ?? [],
    userPrioritiesAndTradeoffs: input.user_priorities_and_tradeoffs ?? [],
    qualityDeficiencies: input.quality_deficiencies ?? [],
    failedOrMissingValidation: input.failed_or_missing_validation ?? [],
    peerRoutes: routes,
    referenceMaterial,
    referenceHash,
    necessitySignals: {
      impactIfWrong: input.necessity.impact_if_wrong,
      uncertaintyOrDisagreement: input.necessity.uncertainty_or_disagreement,
      expectedInformationGain: input.necessity.expected_information_gain,
      incrementalCostLatency: input.necessity.incremental_cost_latency,
    },
    ambiguousSensitiveContentConfirmed: input.ambiguous_sensitive_content_confirmed === true,
    necessityForceAfterDecline: input.necessity.force_after_decline === true,
    referenceAuditGateRiskOverrideConfirmed: referenceMaterial && input.reference_audit_gate.risk_override_confirmed === true,
    lifecycleEpoch: '',
  };
}

function metadataFor(input: AgoraToolInput, overrides: {
  forceAfterDecline?: boolean;
  referenceRiskOverride?: boolean;
} = {}): Record<string, unknown> {
  const envelope = envelopeForInput(input);
  const hash = hashAgoraExecutionEnvelope(envelope);
  const metadata: Record<string, unknown> = { agoraPacketConfirmed: true, agoraEnvelopeHash: hash };
  if (overrides.forceAfterDecline) {
    metadata['agoraNecessityForceAfterDecline'] = { kind: 'necessity_force_after_decline', envelopeHash: hash };
  }
  if (overrides.referenceRiskOverride) {
    metadata['agoraReferenceRiskOverride'] = { kind: 'reference_risk_override', envelopeHash: hash };
  }
  return metadata;
}

function recordsWithLifecycle(runId = 'run-adv', insertedTask = '.trellis/tasks/adv-review') {
  return {
    logRecord: vi.fn(),
    latest: vi.fn((type: string) => {
      if (type === 'agora.run') {
        return { runId, phase: 'packet_confirmation', insertedTask, originTask: '.trellis/tasks/origin' };
      }
      return undefined;
    }),
    latestAgoraLifecycle: vi.fn((id: string) => {
      if (id === runId) {
        return {
          runId,
          transitionId: 'transition-1',
          phase: 'packet_confirmation',
          insertedTask,
          originTask: '.trellis/tasks/origin',
          sourceSessionId: 'session-1',
          capabilityEpoch: '',
          capabilityHash: 'hash-1',
        };
      }
      return undefined;
    }),
  };
}

const complete = [
  'position: support',
  'answer: verified',
  'evidence: trace',
  'assumptions: none',
  'risks: none',
  'confidence: high',
].join('\n');

describe('Agora adversarial regression: approval and lifecycle gates', () => {
  describe('TOCTOU: frozen packet hash-bound approval', () => {
    it.each([
      ['current_artifact_or_diff', 'diff-a', 'diff-b'],
      ['expected_result_or_acceptance_criteria', 'accept-a', 'accept-b'],
      ['actual_result_or_current_proposal', 'proposal-a', 'proposal-b'],
      ['ambiguous_sensitive_content_confirmed', false, true],
      ['necessity.force_after_decline', false, true],
      ['reference_audit_gate.risk_override_confirmed', false, true],
    ] as const)('changes %s when that field mutates', (field, before, after) => {
      const records = recordsWithLifecycle();
      const base = baseInput();
      const apply = (value: string | boolean): AgoraToolInput => {
        if (field === 'necessity.force_after_decline') {
          return { ...base, necessity: { ...base.necessity, force_after_decline: value as boolean } };
        }
        if (field === 'reference_audit_gate.risk_override_confirmed') {
          const references = [{ id: 'ref', label: 'Ref', kind: 'product' as const, role: 'mixed' as const }];
          return { ...base, reference_audit_gate: { material: true, references, risk_override_confirmed: value as boolean } };
        }
        return { ...base, [field]: value };
      };
      const first = hashAgoraExecutionEnvelope(buildAgoraExecutionEnvelope(apply(before), records as never));
      const second = hashAgoraExecutionEnvelope(buildAgoraExecutionEnvelope(apply(after), records as never));
      expect(second).not.toBe(first);
    });

    it('changes when the durable lifecycle epoch advances', () => {
      const records = recordsWithLifecycle();
      const input = baseInput();
      const first = hashAgoraExecutionEnvelope(buildAgoraExecutionEnvelope(input, records as never));
      const oldLifecycle = records.latestAgoraLifecycle('run-adv')!;
      records.latestAgoraLifecycle = vi.fn(() => ({
        ...oldLifecycle,
        capabilityEpoch: 'new-epoch',
      }));
      const second = hashAgoraExecutionEnvelope(buildAgoraExecutionEnvelope(input, records as never));
      expect(second).not.toBe(first);
    });

    it('rejects dispatch when exact_question is changed after approval', async () => {
      const runQueued = vi.fn();
      const records = recordsWithLifecycle();
      const tool = new AgoraTool({ runQueued } as never, records as never);
      const approvedInput = baseInput();
      const tamperedInput = baseInput({ exact_question: 'DIFFERENT question after approval' });
      const execution = runnable(tool.resolveExecution(tamperedInput));
      const result = await execution.execute({
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        metadata: metadataFor(approvedInput),
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('envelope hash mismatch');
      expect(runQueued).not.toHaveBeenCalled();
    });

    it('rejects dispatch when peer routes are changed after approval', async () => {
      const runQueued = vi.fn();
      const records = recordsWithLifecycle();
      const tool = new AgoraTool({ runQueued } as never, records as never);
      const approvedInput = baseInput({ peers: { judge: { backend: 'fb' } } });
      const tamperedInput = baseInput({ peers: { judge: { backend: 'different-backend' } } });
      const execution = runnable(tool.resolveExecution(tamperedInput));
      const result = await execution.execute({
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        metadata: metadataFor(approvedInput),
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('envelope hash mismatch');
    });

    it('rejects dispatch when packet revision is bumped after approval', async () => {
      const runQueued = vi.fn();
      const records = recordsWithLifecycle();
      const tool = new AgoraTool({ runQueued } as never, records as never);
      const approvedInput = baseInput({ packet_revision: 1 });
      const tamperedInput = baseInput({ packet_revision: 2 });
      const execution = runnable(tool.resolveExecution(tamperedInput));
      const result = await execution.execute({
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        metadata: metadataFor(approvedInput),
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('envelope hash mismatch');
    });
  });

  describe('necessity override: independent one-time approval', () => {
    it('rejects force_after_decline when the generic approval does not include the necessity override', async () => {
      const runQueued = vi.fn();
      const records = recordsWithLifecycle();
      const tool = new AgoraTool({ runQueued } as never, records as never);
      // force_after_decline=true in args, but metadata has NO necessity override
      const input = baseInput({
        necessity: {
          impact_if_wrong: 'low',
          uncertainty_or_disagreement: 'low',
          expected_information_gain: 'low',
          incremental_cost_latency: 'high',
          force_after_decline: true,
        },
      });
      const execution = runnable(tool.resolveExecution(input));
      const result = await execution.execute({
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        // metadata has the correct envelope hash but NO necessity override
        metadata: metadataFor(input),
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('necessity_force_after_decline');
      expect(result.output).toContain('independent');
      expect(runQueued).not.toHaveBeenCalled();
    });

    it('rejects force_after_decline when the override was approved for a different packet', async () => {
      const runQueued = vi.fn();
      const records = recordsWithLifecycle();
      const tool = new AgoraTool({ runQueued } as never, records as never);
      const approvedInput = baseInput({
        necessity: {
          impact_if_wrong: 'low',
          uncertainty_or_disagreement: 'low',
          expected_information_gain: 'low',
          incremental_cost_latency: 'high',
          force_after_decline: true,
        },
      });
      const tamperedInput = baseInput({
        exact_question: 'tampered',
        necessity: {
          impact_if_wrong: 'low',
          uncertainty_or_disagreement: 'low',
          expected_information_gain: 'low',
          incremental_cost_latency: 'high',
          force_after_decline: true,
        },
      });
      // The metadata has an override for approvedInput, but the tool args are tampered
      // The envelope hash mismatch should fire first
      const execution = runnable(tool.resolveExecution(tamperedInput));
      const result = await execution.execute({
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        metadata: metadataFor(approvedInput, { forceAfterDecline: true }),
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('envelope hash mismatch');
    });
  });

  describe('lifecycle gate: no-decouple dispatch rejection', () => {
    it('rejects peer dispatch when no durable inserted-task record exists', async () => {
      const runQueued = vi.fn();
      // records with no agora.run record at all
      const records = {
        logRecord: vi.fn(),
        latest: vi.fn(() => undefined),
        latestAgoraLifecycle: vi.fn(() => undefined),
      };
      const tool = new AgoraTool({ runQueued } as never, records as never);
      const input = baseInput();
      const execution = runnable(tool.resolveExecution(input));
      const result = await execution.execute({
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        metadata: metadataFor(input),
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('no durable inserted-task record');
      expect(runQueued).not.toHaveBeenCalled();
    });

    it('rejects peer dispatch when the durable lifecycle is for a different run', async () => {
      const runQueued = vi.fn();
      const records = recordsWithLifecycle('OTHER-run');
      const tool = new AgoraTool({ runQueued } as never, records as never);
      const input = baseInput({ run_id: 'run-adv' });
      const execution = runnable(tool.resolveExecution(input));
      const result = await execution.execute({
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        metadata: metadataFor(input),
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('no durable inserted-task record');
      expect(runQueued).not.toHaveBeenCalled();
    });

    it('rejects peer dispatch when the durable lifecycle phase is not dispatch-allowed', async () => {
      const runQueued = vi.fn();
      const records = recordsWithLifecycle('run-adv');
      records.latestAgoraLifecycle = vi.fn((id: string) => {
        if (id === 'run-adv') {
          return {
            runId: 'run-adv',
            transitionId: 'transition-1',
            phase: 'decoupling',
            insertedTask: '.trellis/tasks/adv-review',
            originTask: '.trellis/tasks/origin',
            sourceSessionId: 'session-1',
            capabilityEpoch: '',
            capabilityHash: 'hash-1',
          };
        }
        return undefined;
      });
      const tool = new AgoraTool({ runQueued } as never, records as never);
      const input = baseInput();
      const execution = runnable(tool.resolveExecution(input));
      const result = await execution.execute({
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        metadata: metadataFor(input),
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('no durable inserted-task record in a dispatch-allowed phase');
      expect(runQueued).not.toHaveBeenCalled();
    });

  });

  describe('reference risk override: independent one-time approval', () => {
    it('rejects reference risk override when the generic approval does not include it', async () => {
      const runQueued = vi.fn();
      const references = [{ id: 'ref', label: 'Ref', kind: 'product' as const, role: 'mixed' as const }];
      const records = recordsWithLifecycle();
      records.latest = vi.fn((type: string) => {
        if (type === 'agora.run') return { runId: 'run-adv', phase: 'packet_confirmation', insertedTask: '.trellis/tasks/adv-review', originTask: '.trellis/tasks/origin' };
        if (type === 'reference_audit.run') return undefined; // no audit -> needs override
        return undefined;
      });
      const tool = new AgoraTool({ runQueued } as never, records as never);
      const input = baseInput({
        reference_audit_gate: { material: true, references, risk_override_confirmed: true },
      });
      const execution = runnable(tool.resolveExecution(input));
      const result = await execution.execute({
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        // metadata has correct envelope hash but NO reference override
        metadata: metadataFor(input),
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('reference_risk_override');
      expect(result.output).toContain('independent');
      expect(runQueued).not.toHaveBeenCalled();
    });
  });

  describe('happy path: all gates pass and peers dispatch', () => {
    it('dispatches peers when envelope hash, lifecycle, and overrides all match', async () => {
      const runQueued = vi.fn(async (tasks: readonly { data: { peer: string } }[]) => {
        return tasks.map((task) => ({
          task,
          agentId: `agent-${task.data.peer}`,
          status: 'completed' as const,
          result: complete,
        }));
      });
      const records = recordsWithLifecycle();
      const tool = new AgoraTool({ runQueued } as never, records as never);
      const input = baseInput({ peers: { judge: { backend: 'future-backend' } } });
      const execution = runnable(tool.resolveExecution(input));
      const result = await execution.execute({
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        metadata: metadataFor(input),
        signal,
      });
      expect(result.isError).not.toBe(true);
      expect(runQueued).toHaveBeenCalled();
    });
  });
});
