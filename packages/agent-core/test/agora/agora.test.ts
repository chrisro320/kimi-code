import { describe, expect, it, vi } from 'vitest';

import {
  hashAgoraExecutionEnvelope,
  resolveDefaultAgoraPeerRoutes,
  type AgoraExecutionEnvelope,
  bindAgoraSessionHandoff,
  buildAgoraExecutionEnvelope,
  buildAgoraPeerPacket,
  buildAgoraPeerTasks,
  buildAgoraRecoveryTask,
  createAgoraRunState,
  createAgoraSessionHandoff,
  evaluateAgoraNecessity,
  normalizeAgoraPeerResponse,
  recordAgoraContractRepair,
  runAgoraPeerReview,
  synthesizeAgoraDecision,
  transitionAgoraRun,
  type AgoraPacketInput,
  type AgoraPeerResponse,
} from '../../src/agora';
import { AgoraTool, type AgoraToolInput } from '../../src/tools/builtin/collaboration/agora';
import { hashReferenceSet } from '../../src/reference-audit';

function packetInput(patch: Partial<AgoraPacketInput> = {}): AgoraPacketInput {
  return {
    runId: 'run-1',
    mode: 'acceptance',
    userGoal: 'Deliver the requested result',
    exactQuestion: 'What caused the result to miss the target?',
    desiredDecision: 'Choose a coherent repair direction',
    projectState: 'Implementation completed but user rejected the result',
    dissatisfactionOrUncertainty: 'The delivered result does not match the intended product experience.',
    hostInitialView: {
      position: 'The requirements may be incomplete.',
      evidence: ['Acceptance was ambiguous.'],
      assumptions: ['The implementation followed the written task.'],
      confidence: 'medium',
    },
    packetRevision: 1,
    redactionSummary: 'No sensitive content included.',
    recovery: false,
    ...patch,
  };
}

function envelopeForInput(input: AgoraToolInput, records?: { latestAgoraLifecycle: (runId: string) => { capabilityEpoch?: string } | undefined }): AgoraExecutionEnvelope {
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
    lifecycleEpoch: records?.latestAgoraLifecycle(input.run_id)?.capabilityEpoch ?? '',
  };
}

function approvalMetadata(input: AgoraToolInput, overrides: {
  forceAfterDecline?: boolean;
  referenceRiskOverride?: boolean;
} = {}, records?: { latestAgoraLifecycle: (runId: string) => { capabilityEpoch?: string } | undefined }): Record<string, unknown> {
  const envelope = envelopeForInput(input, records);
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

function recordsWithLifecycle(runId = 'run-1', insertedTask = '.trellis/tasks/agora-review'): {
  logRecord: ReturnType<typeof vi.fn>;
  latest: ReturnType<typeof vi.fn>;
  latestAgoraLifecycle: ReturnType<typeof vi.fn>;
  claimAgoraOverride: ReturnType<typeof vi.fn>;
  claimReferenceAuditOverride: ReturnType<typeof vi.fn>;
} {
  return {
    logRecord: vi.fn(),
    claimAgoraOverride: vi.fn(() => true),
    claimReferenceAuditOverride: vi.fn(() => true),
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

function peer(
  peerName: 'claude' | 'grok',
  position: AgoraPeerResponse['position'],
  evidence: readonly string[] = ['reproducible evidence'],
): AgoraPeerResponse {
  return {
    peer: peerName,
    position,
    answer: `${peerName} answer`,
    evidence,
    assumptions: [],
    risks: [],
    confidence: 'medium',
  };
}

describe('evaluateAgoraNecessity', () => {
  it('returns transparent recommended, allowed, and declined outcomes', () => {
    const recommended = evaluateAgoraNecessity({
      impactIfWrong: 'high',
      uncertaintyOrDisagreement: 'high',
      expectedInformationGain: 'high',
      incrementalCostLatency: 'medium',
    });
    expect(recommended).toMatchObject({ outcome: 'recommended', forcedByUser: false });
    expect(recommended.explanation).toContain('impact=high');

    expect(
      evaluateAgoraNecessity({
        impactIfWrong: 'medium',
        uncertaintyOrDisagreement: 'medium',
        expectedInformationGain: 'medium',
        incrementalCostLatency: 'low',
      }).outcome,
    ).toBe('allowed_on_request');

    const declined = evaluateAgoraNecessity(
      {
        impactIfWrong: 'low',
        uncertaintyOrDisagreement: 'low',
        expectedInformationGain: 'low',
        incrementalCostLatency: 'high',
      },
      { forceAfterDecline: true },
    );
    expect(declined).toMatchObject({ outcome: 'declined', forcedByUser: true });
    expect(declined.normalWorkflowRecommendation).not.toBe('');
  });
});

describe('buildAgoraPeerPacket', () => {
  it('excludes the host initial view and uses request-scoped Claude Opus 4.8', () => {
    const packet = buildAgoraPeerPacket(packetInput());

    expect(packet).not.toHaveProperty('hostInitialView');
    expect(packet.peerRoutes).toEqual({
      claude: { backend: 'claude-code', modelOverride: 'Opus 4.8' },
      grok: { backend: 'kimi', modelOverride: 'kimicode-grok-4.5' },
    });
    expect(packet).toMatchObject({ hostRoute: 'coder', routeUpgrade: 'none' });
  });

  it('requires concrete escalation evidence for recovery and records coder-ex replacement', () => {
    expect(() => buildAgoraPeerPacket(packetInput({ recovery: true }))).toThrow(
      'prior coder result or diff',
    );

    const packet = buildAgoraPeerPacket(
      packetInput({
        recovery: true,
        priorCoderResultOrDiff: 'prior diff',
        qualityDeficiencies: ['Missed a confirmed requirement.'],
        failedOrMissingValidation: ['Required acceptance smoke was not run.'],
      }),
    );

    expect(packet).toMatchObject({
      hostRoute: 'coder-ex',
      routeUpgrade: 'coder_to_coder-ex',
      qualityDeficiencies: ['Missed a confirmed requirement.'],
    });
    const recovery = buildAgoraRecoveryTask(packet);
    expect(recovery).toMatchObject({
      profileName: 'coder-ex',
      modelAlias: 'gpt5.6sol',
      dispatch: {
        discardChanges: true,
        qualityDeficiencies: ['Missed a confirmed requirement.'],
      },
    });
    expect(recovery.prompt).toContain('prior diff');
    expect(recovery.prompt).toContain('Required acceptance smoke was not run.');
  });

  it('produces equal independent packet values without shared mutable arrays', () => {
    const input = packetInput({ relevantEvidence: ['evidence-a'] });
    const claudePacket = buildAgoraPeerPacket(input);
    const grokPacket = buildAgoraPeerPacket(input);

    expect(claudePacket).toEqual(grokPacket);
    expect(claudePacket.relevantEvidence).not.toBe(grokPacket.relevantEvidence);
  });
});

describe('Agora orchestration and handoff contracts', () => {
  it('builds independent peer tasks with one-shot routes and byte-equivalent packets', () => {
    const packet = buildAgoraPeerPacket(packetInput());
    const tasks = buildAgoraPeerTasks(packet);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.data.packet).toEqual(tasks[1]!.data.packet);
    expect(tasks[0]!.dispatch?.workCard?.routeOverride).toEqual({
      backend: 'claude-code',
      model: 'Opus 4.8',
    });
    expect(tasks[1]!.dispatch?.workCard?.routeOverride).toEqual({
      backend: 'kimi',
      model: 'kimicode-grok-4.5',
    });
    expect(tasks[0]!.profileName).toBe('agora-peer');
    expect(tasks[0]!.dispatch).toMatchObject({ readOnly: true, discardChanges: true });
    expect(tasks[0]!.dispatch?.reviewReason).toContain('independent');
    expect(tasks[0]!.enforceDispatch).toBe(true);
    expect(tasks[0]!.prompt).toContain('read-only');
  });

  it('supports a configurable future roster without vendor-specific peer ids', () => {
    const routes = {
      local: {
        backend: 'kimi',
        modelOverride: 'future-local-model',
        profileName: 'reviewer',
        displayName: 'Local Judge',
      },
      judge: {
        backend: 'future-external',
        modelOverride: 'future-peer-model',
        profileName: 'explore',
      },
    };
    const packet = buildAgoraPeerPacket(packetInput(), routes);
    const tasks = buildAgoraPeerTasks(packet, routes);

    expect(tasks.map((task) => task.data.peer)).toEqual(['local', 'judge']);
    expect(tasks[0]).toMatchObject({ profileName: 'reviewer', description: 'Agora Local Judge peer review' });
    expect(tasks[0]!.dispatch?.workCard?.routeOverride).toEqual({
      backend: 'kimi',
      model: 'future-local-model',
    });
    expect(tasks[1]).toMatchObject({ profileName: 'explore' });
    expect(tasks[1]!.dispatch?.workCard?.routeOverride).toEqual({
      backend: 'future-external',
      model: 'future-peer-model',
    });
  });

  it('normalizes arbitrary peer identities while preserving the raw response', () => {
    const raw = [
      'position: conditional',
      'answer: Gather one more direct measurement.',
      'evidence: trace A; trace B',
      'assumptions: current build is reproducible',
      'risks: measurement drift',
      'confidence: medium',
      'dissent: current evidence is incomplete',
    ].join('\n');

    expect(normalizeAgoraPeerResponse('judge', raw)).toEqual({
      status: 'completed',
      rawResponse: raw,
      response: {
        peer: 'judge',
        position: 'conditional',
        answer: 'Gather one more direct measurement.',
        evidence: ['trace A', 'trace B'],
        assumptions: ['current build is reproducible'],
        risks: ['measurement drift'],
        confidence: 'medium',
        dissent: 'current evidence is incomplete',
      },
    });
  });

  it('sends one private repair only to malformed peers and accepts the repaired response', async () => {
    const packet = buildAgoraPeerPacket(packetInput(), {
      judge: { backend: 'future-external' },
      local: { backend: 'kimi' },
    });
    const complete = [
      'position: support',
      'answer: verified',
      'evidence: trace',
      'assumptions: none',
      'risks: none',
      'confidence: high',
    ].join('\n');
    const calls: Array<readonly { prompt: string; data: { peer: string } }[]> = [];
    const host = {
      runQueued: async (tasks: readonly { prompt: string; data: { peer: string } }[]) => {
        calls.push(tasks);
        return tasks.map((task, index) => ({
          task,
          agentId: `agent-${task.data.peer}-${String(index)}`,
          status: 'completed' as const,
          result: calls.length === 1 && task.data.peer === 'judge' ? 'answer: malformed' : complete,
        }));
      },
    };

    const results = await runAgoraPeerReview(host as never, packet);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.map((task) => task.data.peer)).toEqual(['judge']);
    expect(calls[1]![0]!.prompt).toContain('one allowed private');
    expect(calls[1]![0]!.prompt).not.toContain('verified');
    expect(results.find((result) => result.peer === 'judge')).toMatchObject({
      repairCount: 1,
      initialRawResponse: 'answer: malformed',
      repairRawResponse: complete,
      normalization: { status: 'completed' },
    });
    expect(results.find((result) => result.peer === 'local')).toMatchObject({ repairCount: 0 });
  });

  it('marks a peer unavailable after its only repair remains malformed', async () => {
    const packet = buildAgoraPeerPacket(packetInput(), { judge: { backend: 'future-external' } });
    let calls = 0;
    const host = {
      runQueued: async (tasks: readonly { data: { peer: string } }[]) => {
        calls += 1;
        return tasks.map((task) => ({
          task,
          agentId: `agent-${task.data.peer}-${String(calls)}`,
          status: 'completed' as const,
          result: 'answer: still malformed',
        }));
      },
    };

    const [result] = await runAgoraPeerReview(host as never, packet);
    expect(calls).toBe(2);
    expect(result).toMatchObject({
      repairCount: 1,
      normalization: {
        status: 'unavailable',
        reason: 'peer response remained malformed after one contract repair',
      },
    });
  });

  it('returns an explicit main-model fallback packet when every peer dispatch fails', async () => {
    const runQueued = vi.fn(async () => { throw new Error('provider quota exhausted'); });
    const records = recordsWithLifecycle('run-fallback');
    const tool = new AgoraTool({ runQueued } as never, records as never);
    const input: AgoraToolInput = {
      run_id: 'run-fallback',
      mode: 'planning',
      user_goal: 'Choose a design',
      exact_question: 'Which design is grounded?',
      desired_decision: 'Select a direction',
      project_state: 'Planning',
      dissatisfaction_or_uncertainty: 'Uncertain',
      host_initial_view: { position: 'Unknown', evidence: [], assumptions: [], confidence: 'low' },
      packet_revision: 1,
      redaction_summary: 'No sensitive content.',
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
      peers: {
        judge: { backend: 'future-backend', role: 'architecture' },
      },
    };
    const execution = tool.resolveExecution(input);
    if ('isError' in execution && execution.isError === true) throw new Error(execution.message);
    const result = await execution.execute({
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      metadata: approvalMetadata(input),
      signal: new AbortController().signal,
    });
    expect(result.isError).not.toBe(true);
    const output = JSON.parse(result.output as string);
    expect(output).toMatchObject({
      fallbackRequired: true,
      fallbackPeers: [{ peer: 'judge', reason: 'provider quota exhausted' }],
      results: [],
    });
    expect(output.fallbackPolicy).toContain('main model');
    expect(output.fallbackPolicy).toContain('never count');
    expect(records.logRecord.mock.calls.at(-1)?.[0]).toMatchObject({
      phase: 'synthesis',
      terminalState: 'fallback_required',
      peers: [{ peer: 'judge', status: 'unavailable', error: 'provider quota exhausted' }],
      temporaryOverrides: { judge: 'disposed' },
    });
  });

  it('redacts backend stderr secrets from durable peer errors and fallback output', async () => {
    const secret = 'SUPERSECRET_BACKEND_STDERR_999999';
    const runQueued = vi.fn(async () => {
      throw new Error(`External subagent backend "future-backend" exited with code 1: api_key=${secret}`);
    });
    const records = recordsWithLifecycle('run-secret-stderr');
    const tool = new AgoraTool({ runQueued } as never, records as never);
    const input: AgoraToolInput = {
      run_id: 'run-secret-stderr',
      mode: 'planning',
      user_goal: 'Choose a design',
      exact_question: 'Which design is grounded?',
      desired_decision: 'Select a direction',
      project_state: 'Planning',
      dissatisfaction_or_uncertainty: 'Uncertain',
      host_initial_view: { position: 'Unknown', evidence: [], assumptions: [], confidence: 'low' },
      packet_revision: 1,
      redaction_summary: 'No sensitive content.',
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
      peers: { judge: { backend: 'future-backend', role: 'architecture' } },
    };
    const execution = tool.resolveExecution(input);
    if ('isError' in execution && execution.isError === true) throw new Error(execution.message);
    const result = await execution.execute({
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      metadata: approvalMetadata(input),
      signal: new AbortController().signal,
    });

    const outputText = result.output as string;
    expect(outputText).not.toContain(secret);
    expect(outputText).toContain('[REDACTED_SECRET]');
    const durable = records.logRecord.mock.calls.at(-1)?.[0] as { peers: Array<{ error?: string }> };
    expect(JSON.stringify(durable)).not.toContain(secret);
    expect(durable.peers[0]!.error).toContain('[REDACTED_SECRET]');
  });

  it('redacts host recovery secrets from durable records and tool output', async () => {
    const secret = 'SUPERSECRET_HOST_RECOVERY_888888';
    const complete = [
      'position: support',
      'answer: verified',
      'evidence: trace',
      'assumptions: none',
      'risks: none',
      'confidence: high',
    ].join('\n');
    const runQueued = vi.fn(async (tasks: readonly { data?: { kind?: string; peer?: string } }[]) =>
      tasks.map((task, index) => task.data?.kind === 'recovery'
        ? {
            task,
            agentId: `agent-recovery-${String(index)}`,
            status: 'completed' as const,
            result: `host recovery notes api_key=${secret}`,
          }
        : {
            task,
            agentId: `agent-${task.data?.peer ?? 'peer'}-${String(index)}`,
            status: 'completed' as const,
            result: complete,
          }),
    );
    const records = recordsWithLifecycle('run-secret-recovery');
    const tool = new AgoraTool({ runQueued } as never, records as never);
    const input: AgoraToolInput = {
      run_id: 'run-secret-recovery',
      mode: 'planning',
      user_goal: 'Choose a design',
      exact_question: 'Which design is grounded?',
      desired_decision: 'Select a direction',
      project_state: 'Planning',
      dissatisfaction_or_uncertainty: 'Uncertain',
      host_initial_view: { position: 'Unknown', evidence: [], assumptions: [], confidence: 'low' },
      packet_revision: 1,
      redaction_summary: 'No sensitive content.',
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
      recovery: true,
      prior_coder_result_or_diff: 'prior coder result',
      quality_deficiencies: ['incomplete handoff'],
      failed_or_missing_validation: ['no regression proof'],
      peers: { judge: { backend: 'future-backend', role: 'architecture' } },
    };
    const execution = tool.resolveExecution(input);
    if ('isError' in execution && execution.isError === true) throw new Error(execution.message);
    const result = await execution.execute({
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      metadata: approvalMetadata(input),
      signal: new AbortController().signal,
    });

    const outputText = result.output as string;
    expect(outputText).not.toContain(secret);
    expect(outputText).toContain('[REDACTED_SECRET]');
    const durable = records.logRecord.mock.calls.at(-1)?.[0] as { hostRecoveryResult?: string };
    expect(JSON.stringify(durable)).not.toContain(secret);
    expect(durable.hostRecoveryResult).toContain('[REDACTED_SECRET]');
  });

  it('redacts secrets from outermost tool errors and failed durable records', async () => {
    const secret = 'SUPERSECRET_OUTER_ERROR_777777';
    const records = recordsWithLifecycle('run-secret-outer');
    const runQueued = vi.fn(async () => {
      throw new Error(`host recovery crashed Bearer ${secret}`);
    });
    const tool = new AgoraTool({ runQueued } as never, records as never);
    const input: AgoraToolInput = {
      run_id: 'run-secret-outer',
      mode: 'planning',
      user_goal: 'Choose a design',
      exact_question: 'Which design is grounded?',
      desired_decision: 'Select a direction',
      project_state: 'Planning',
      dissatisfaction_or_uncertainty: 'Uncertain',
      host_initial_view: { position: 'Unknown', evidence: [], assumptions: [], confidence: 'low' },
      packet_revision: 1,
      redaction_summary: 'No sensitive content.',
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
      recovery: true,
      prior_coder_result_or_diff: 'prior',
      quality_deficiencies: ['incomplete handoff'],
      failed_or_missing_validation: ['no regression proof'],
      peers: { judge: { backend: 'future-backend', role: 'architecture' } },
    };
    const execution = tool.resolveExecution(input);
    if ('isError' in execution && execution.isError === true) throw new Error(execution.message);
    const result = await execution.execute({
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      metadata: approvalMetadata(input),
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).not.toContain(secret);
    expect(result.output).toContain('[REDACTED_SECRET]');
    expect(JSON.stringify(records.logRecord.mock.calls.at(-1)?.[0])).not.toContain(secret);
  });

  it('persists dynamic routes, repair raws, and disposed overrides through AgoraTool', async () => {
    const complete = [
      'position: support',
      'answer: verified',
      'evidence: trace',
      'assumptions: none',
      'risks: none',
      'confidence: high',
    ].join('\n');
    let calls = 0;
    const runQueued = vi.fn(async (tasks: readonly { data: { peer: string } }[]) => {
      calls += 1;
      return tasks.map((task) => ({
        task,
        agentId: `agent-${task.data.peer}-${String(calls)}`,
        status: 'completed' as const,
        result: calls === 1 ? 'answer: malformed' : complete,
      }));
    });
    const records = recordsWithLifecycle('run-tool');
    const tool = new AgoraTool({ runQueued } as never, records as never);
    const input: AgoraToolInput = {
      run_id: 'run-tool',
      mode: 'planning',
      user_goal: 'Choose a design',
      exact_question: 'Which design is grounded?',
      desired_decision: 'Select a direction',
      project_state: 'Planning',
      dissatisfaction_or_uncertainty: 'Uncertain',
      host_initial_view: { position: 'Unknown', evidence: [], assumptions: [], confidence: 'low' },
      packet_revision: 1,
      redaction_summary: 'No sensitive content.',
      packet_confirmed: true,
      ambiguous_sensitive_content_confirmed: false,
      reference_audit_gate: { material: false },
      necessity: {
        impact_if_wrong: 'high',
        uncertainty_or_disagreement: 'high',
        expected_information_gain: 'high',
        incremental_cost_latency: 'medium',
        force_after_decline: true,
      },
      recovery: false,
      peers: {
        judge: {
          backend: 'future-backend',
          model_override: 'future-model',
          profile_name: 'reviewer',
          display_name: 'Future Judge',
          role: 'architecture',
        },
      },
    };
    const execution = tool.resolveExecution(input);
    if ('isError' in execution && execution.isError === true) throw new Error(execution.message);
    const result = await execution.execute({
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      metadata: approvalMetadata({ ...input, necessity: { ...input.necessity, force_after_decline: true } }, { forceAfterDecline: true }),
      signal: new AbortController().signal,
    });

    expect(result.isError).not.toBe(true);
    expect(records.logRecord).toHaveBeenCalledTimes(2);
    expect(records.logRecord.mock.calls[0]![0]).toMatchObject({
      phase: 'peer_review',
      referenceAuditGate: {
        state: 'not-required',
        riskOverrideConfirmed: false,
      },
      routes: {
        judge: {
          backend: 'future-backend',
          modelOverride: 'future-model',
          profileName: 'reviewer',
          displayName: 'Future Judge',
          role: 'architecture',
        },
      },
      peers: [{ peer: 'judge', status: 'pending', repairCount: 0 }],
      temporaryOverrides: { judge: 'active' },
    });
    expect(records.logRecord.mock.calls[1]![0]).toMatchObject({
      phase: 'synthesis',
      peers: [{
        peer: 'judge',
        status: 'completed',
        initialRawResponse: 'answer: malformed',
        repairRawResponse: complete,
        repairCount: 1,
      }],
      temporaryOverrides: { judge: 'disposed' },
      terminalState: 'converged',
    });
  });

  it('uses the latest durable audit and permission metadata for material-reference gating', async () => {
    const runQueued = vi.fn();
    const references = [{ id: 'minecraft', label: 'Minecraft', kind: 'product' as const, role: 'mixed' as const }];
    const referenceHash = (await import('../../src/reference-audit')).hashReferenceSet(references);
    const base: AgoraToolInput = {
      run_id: 'run-reference-gate',
      mode: 'planning',
      user_goal: 'Build from references',
      exact_question: 'Which design is grounded?',
      desired_decision: 'Select a direction',
      project_state: 'Planning',
      dissatisfaction_or_uncertainty: 'Uncertain',
      host_initial_view: { position: 'Unknown', evidence: [], assumptions: [], confidence: 'low' },
      packet_revision: 1,
      redaction_summary: 'No sensitive content.',
      packet_confirmed: true,
      ambiguous_sensitive_content_confirmed: false,
      reference_audit_gate: { material: true, references, risk_override_confirmed: false },
      necessity: {
        impact_if_wrong: 'high', uncertainty_or_disagreement: 'high',
        expected_information_gain: 'high', incremental_cost_latency: 'medium',
        force_after_decline: false,
      },
      recovery: false,
    };
    const execute = async (
      records: { latest: (type?: string) => unknown; logRecord?: ReturnType<typeof vi.fn>; claimAgoraOverride?: ReturnType<typeof vi.fn>; claimReferenceAuditOverride?: ReturnType<typeof vi.fn> },
      input: AgoraToolInput = base,
      metadata: Record<string, unknown> = approvalMetadata(base),
    ) => {
      const tool = new AgoraTool(
        { runQueued } as never,
        { logRecord: vi.fn(), claimAgoraOverride: vi.fn(() => true), claimReferenceAuditOverride: vi.fn(() => true), ...records, latest: vi.fn((type: string) => {
          if (type === 'agora.run') return { runId: 'run-reference-gate', phase: 'packet_confirmation', insertedTask: '.trellis/tasks/agora-review', originTask: '.trellis/tasks/origin' };
          return records.latest?.(type);
        }), latestAgoraLifecycle: vi.fn((runId: string) => runId === 'run-reference-gate' ? {
          runId,
          transitionId: 'transition-1',
          phase: 'packet_confirmation',
          insertedTask: '.trellis/tasks/agora-review',
          originTask: '.trellis/tasks/origin',
          sourceSessionId: 'session-1',
          capabilityEpoch: '',
          capabilityHash: 'hash-1',
        } : undefined) } as never,
      );
      const execution = tool.resolveExecution(input);
      if ('isError' in execution && execution.isError === true) throw new Error(execution.message);
      return execution.execute({
        turnId: 'turn-1', toolCallId: 'tool-1', metadata, signal: new AbortController().signal,
      });
    };

    const missing = await execute({ latest: () => undefined });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.output).toContain('not-run');

    const stale = await execute({ latest: () => ({
      runId: 'audit-stale', triggered: true, referenceHash: 'a'.repeat(64), resultHash: 'result',
      tracks: [], terminalState: 'completed',
    }) });
    expect(stale).toMatchObject({ isError: true });
    expect(stale.output).toContain('changed');

    const incomplete = await execute({ latest: () => ({
      runId: 'audit-incomplete', triggered: true, referenceHash, tracks: [], terminalState: 'fallback_required',
    }) });
    expect(incomplete).toMatchObject({ isError: true });

    const modelOnlyOverride = await execute(
      { latest: () => undefined },
      { ...base, reference_audit_gate: { material: true, references, risk_override_confirmed: true } },
    );
    expect(modelOnlyOverride).toMatchObject({ isError: true });

    const approvedOverride = await execute(
      { latest: () => undefined },
      { ...base, reference_audit_gate: { material: true, references, risk_override_confirmed: true } },
      approvalMetadata({ ...base, reference_audit_gate: { material: true, references, risk_override_confirmed: true } }, { referenceRiskOverride: true }),
    );
    expect(approvedOverride.isError).not.toBe(true);

    expect(runQueued).toHaveBeenCalledTimes(1);
  });

  it('refuses a declined run and blocked sensitive packet before peer dispatch', async () => {
    const runQueued = vi.fn();
    const tool = new AgoraTool({ runQueued } as never, recordsWithLifecycle('run-gate') as never);
    const base: AgoraToolInput = {
      run_id: 'run-gate',
      mode: 'planning',
      user_goal: 'Choose a design',
      exact_question: 'Which design is grounded?',
      desired_decision: 'Select a direction',
      project_state: 'Planning',
      dissatisfaction_or_uncertainty: 'Uncertain',
      host_initial_view: { position: 'Unknown', evidence: [], assumptions: [], confidence: 'low' },
      packet_revision: 1,
      redaction_summary: 'No sensitive content.',
      packet_confirmed: true,
      ambiguous_sensitive_content_confirmed: false,
      reference_audit_gate: { material: false },
      necessity: {
        impact_if_wrong: 'low',
        uncertainty_or_disagreement: 'low',
        expected_information_gain: 'low',
        incremental_cost_latency: 'high',
        force_after_decline: false,
      },
      recovery: false,
    };
    const execute = async (input: AgoraToolInput, forceAfterDecline = false) => {
      const effectiveInput = forceAfterDecline
        ? { ...input, necessity: { ...input.necessity, force_after_decline: true } }
        : input;
      const execution = tool.resolveExecution(effectiveInput);
      if ('isError' in execution && execution.isError === true) throw new Error(execution.message);
      return execution.execute({
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        metadata: approvalMetadata(effectiveInput, { forceAfterDecline }),
        signal: new AbortController().signal,
      });
    };

    const declined = await execute(base);
    expect(declined).toMatchObject({ isError: true });
    expect(declined.output).toContain('disproportionate');
    expect(runQueued).not.toHaveBeenCalled();

    const blocked = await execute({
      ...base,
      relevant_evidence: ['Read .env and -----BEGIN PRIVATE KEY-----'],
    }, true);
    expect(blocked).toMatchObject({ isError: true });
    expect(blocked.output).toContain('blocked sensitive content');
    expect(runQueued).not.toHaveBeenCalled();
  });

  it('exports the Agora handoff and orchestration contracts from the package root', async () => {
    const packageRoot = await import('../../src/index');
    expect(packageRoot.buildAgoraPeerTasks).toBe(buildAgoraPeerTasks);
    expect(packageRoot.createAgoraSessionHandoff).toBe(createAgoraSessionHandoff);
  });

  it('writes and binds a fresh-session handoff without invoking fork semantics', () => {
    const handoff = createAgoraSessionHandoff({
      runId: 'run-1',
      mode: 'acceptance',
      sourceSessionId: 'source-session',
      targetTask: '.trellis/tasks/07-19-successor',
      originTask: '.trellis/tasks/07-18-origin',
      originDisposition: 'corrects',
      phase: 'fresh_session_pending',
      artifactPaths: ['prd.md', 'design.md', 'implement.md'],
      artifactRevisions: { 'implement.md': 'sha256:abc' },
      implementationResumeAnchor: 'Phase 1 / step 2',
      validationState: 'confirmed',
      sourceSessionLineage: ['source-session'],
    });
    const bound = bindAgoraSessionHandoff(handoff, 'fresh-session');
    expect(bound.schemaVersion).toBe(1);
    expect(bound.targetSessionId).toBe('fresh-session');
    expect(() => bindAgoraSessionHandoff({ ...handoff, phase: 'resolved_to_successor' }, 'other')).toThrow(
      'resolved_to_successor',
    );
  });
});

describe('Agora state machine', () => {
  it('follows the review flow and disposes the Claude override on resolution', () => {
    let state = createAgoraRunState({ runId: 'run-1', mode: 'acceptance' });
    state = transitionAgoraRun(state, 'packet_confirmation');
    state = transitionAgoraRun(state, 'peer_review');
    state = transitionAgoraRun(state, 'synthesis');
    state = transitionAgoraRun(state, 'trellis_convergence');
    state = transitionAgoraRun(state, 'task_materialization');
    state = transitionAgoraRun(state, 'materialization_executing');
    state = transitionAgoraRun(state, 'fresh_session_pending');
    state = transitionAgoraRun(state, 'resolved_to_successor');

    expect(state).toMatchObject({ phase: 'resolved_to_successor', claudeModelOverride: 'disposed' });
    expect(() => transitionAgoraRun(state, 'peer_review')).toThrow('Invalid Agora transition');
  });

  it('permits at most one contract repair per peer', () => {
    const state = createAgoraRunState({ runId: 'run-1', mode: 'planning' });
    const repaired = recordAgoraContractRepair(state, 'claude');
    expect(repaired.contractRepairs['claude']).toBe(1);
    expect(() => recordAgoraContractRepair(repaired, 'claude')).toThrow('one contract-repair');
    expect(recordAgoraContractRepair(repaired, 'grok').contractRepairs['grok']).toBe(1);
  });

  it('tracks and disposes overrides for a configurable peer roster', () => {
    let state = createAgoraRunState({
      runId: 'run-future',
      mode: 'planning',
      peerIds: ['judge', 'local'],
    });
    expect(state.contractRepairs).toEqual({ judge: 0, local: 0 });
    expect(state.temporaryOverrides).toEqual({ judge: 'active', local: 'active' });
    expect(state.claudeModelOverride).toBeUndefined();

    state = recordAgoraContractRepair(state, 'judge');
    expect(state.contractRepairs['judge']).toBe(1);
    state = transitionAgoraRun(state, 'cancelled');
    expect(state.temporaryOverrides).toEqual({ judge: 'disposed', local: 'disposed' });
  });
});

describe('synthesizeAgoraDecision', () => {
  const claims = [
    { source: 'user' as const, claim: 'The result feels structurally wrong.', evidence: ['user feedback'] },
    { source: 'claude' as const, claim: 'The acceptance boundary is incomplete.', evidence: ['task artifact'] },
  ];

  it('requires user-confirmed acceptance criteria before objective acceptance', () => {
    expect(
      synthesizeAgoraDecision({
        mode: 'acceptance',
        hostPosition: 'support',
        peerResponses: [peer('claude', 'support'), peer('grok', 'support')],
        claims,
        acceptanceCriteriaConfirmed: false,
      }),
    ).toMatchObject({ status: 'needs_acceptance_definition', confidence: 'low' });
  });

  it('requests targeted evidence when the host conflicts with both peers', () => {
    const result = synthesizeAgoraDecision({
      mode: 'planning',
      hostPosition: 'support',
      peerResponses: [peer('claude', 'oppose'), peer('grok', 'conditional')],
      claims,
      acceptanceCriteriaConfirmed: true,
    });

    expect(result).toMatchObject({ status: 'needs_evidence', confidence: 'low' });
    expect(result.disagreements).toContain('The host baseline conflicts with every usable peer position.');
    expect(result.nextEvidenceStep).toContain('targeted');
  });

  it('preserves peer disagreement instead of majority voting', () => {
    expect(
      synthesizeAgoraDecision({
        mode: 'planning',
        hostPosition: 'conditional',
        peerResponses: [peer('claude', 'support'), peer('grok', 'oppose')],
        claims,
        acceptanceCriteriaConfirmed: true,
      }),
    ).toMatchObject({ status: 'needs_evidence', confidence: 'low' });
  });

  it('returns actionable only when the evidence gates are satisfied', () => {
    expect(
      synthesizeAgoraDecision({
        mode: 'acceptance',
        hostPosition: 'support',
        peerResponses: [peer('claude', 'support'), peer('grok', 'support')],
        claims,
        acceptanceCriteriaConfirmed: true,
      }),
    ).toMatchObject({ status: 'actionable', confidence: 'high', claims });
  });
});

describe('config-driven default peer roster', () => {
  const baseArgs = {
    run_id: 'run-roster',
    mode: 'planning' as const,
    exact_question: 'Which direction is best supported?',
    desired_decision: 'Pick a direction',
    project_state: 'state',
    dissatisfaction_or_uncertainty: 'uncertain',
    user_goal: 'goal',
    packet_revision: 1,
    redaction_summary: 'none',
    recovery: false,
    necessity: {
      impact_if_wrong: 'medium' as const,
      uncertainty_or_disagreement: 'medium' as const,
      expected_information_gain: 'medium' as const,
      incremental_cost_latency: 'low' as const,
    },
  };

  it('falls back to the built-in roster when no agora config exists', () => {
    const envelope = buildAgoraExecutionEnvelope(baseArgs, undefined);
    expect(Object.keys(envelope.peerRoutes)).toEqual(['claude', 'grok']);
    expect(resolveDefaultAgoraPeerRoutes(undefined)).toEqual({
      claude: { backend: 'claude-code', modelOverride: 'Opus 4.8' },
      grok: { backend: 'kimi', modelOverride: 'kimicode-grok-4.5' },
    });
  });

  it('falls back to the built-in roster when config peers are empty', () => {
    expect(Object.keys(resolveDefaultAgoraPeerRoutes({ peers: {} }))).toEqual(['claude', 'grok']);
  });

  it('uses agora.peers from config when args omit peers', () => {
    const envelope = buildAgoraExecutionEnvelope(baseArgs, undefined, {
      peers: {
        terra: { backend: 'kimi', modelOverride: 'gpt-5.6-terra', displayName: 'p5.6-terra-max' },
      },
    });
    expect(Object.keys(envelope.peerRoutes)).toEqual(['terra']);
    expect(envelope.peerRoutes['terra']?.backend).toBe('kimi');
    expect(envelope.peerRoutes['terra']?.modelOverride).toBe('gpt-5.6-terra');
    expect(envelope.peerRoutes['terra']?.displayName).toBe('p5.6-terra-max');
  });

  it('prefers explicit args.peers over the configured roster', () => {
    const envelope = buildAgoraExecutionEnvelope(
      { ...baseArgs, peers: { solo: { backend: 'kimi', model_override: 'kimi-code/k3' } } },
      undefined,
      { peers: { terra: { backend: 'kimi', modelOverride: 'gpt-5.6-terra' } } },
    );
    expect(Object.keys(envelope.peerRoutes)).toEqual(['solo']);
    expect(envelope.peerRoutes['solo']?.modelOverride).toBe('kimi-code/k3');
  });

  it('binds the configured roster into the envelope hash', () => {
    const withTerra = hashAgoraExecutionEnvelope(buildAgoraExecutionEnvelope(baseArgs, undefined, {
      peers: { terra: { backend: 'kimi', modelOverride: 'gpt-5.6-terra' } },
    }));
    const withGrok = hashAgoraExecutionEnvelope(buildAgoraExecutionEnvelope(baseArgs, undefined, {
      peers: { grok: { backend: 'kimi', modelOverride: 'kimicode-grok-4.5' } },
    }));
    expect(withTerra).not.toBe(withGrok);
  });
});
