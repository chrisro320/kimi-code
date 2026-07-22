import { describe, expect, it, vi } from 'vitest';

import {
  cancelAgoraLifecycleTransition,
  confirmAgoraMaterializationProposal,
  createAgoraLifecycleCapability,
  hashAgoraMaterializationProposal,
  isAgoraLifecycleTerminal,
  materializeAgoraLifecycleTransition,
  recordAgoraLifecycleToTaskMaterialization,
  recordAgoraLifecycleTransition,
  TERMINAL_PHASES,
  toAgoraLifecycleHandle,
  verifyAgoraLifecycleHandle,
  type AgoraLifecycleAdapter,
  type AgoraLifecycleCapability,
  type AgoraMaterializationProposal,
} from '../../src/agora/lifecycle';
import { TERMINAL_PHASES as TERMINAL_PHASES_FROM_BARREL } from '../../src/agora';
import {
  InMemoryAgentRecordPersistence,
  type AgentRecord,
} from '../../src/agent/records';
import { ErrorCodes, KimiError } from '../../src/errors';
import type { Session } from '../../src/session';
import { SessionAPIImpl } from '../../src/session/rpc';
import { testAgent } from '../agent/harness/agent';

function setup(runId = 'run-1') {
  const persistence = new InMemoryAgentRecordPersistence();
  const agent = testAgent({ persistence }).agent;
  const handle = createAgoraLifecycleCapability('session-1', runId, 'epoch-1', 'secret-1');
  recordAgoraLifecycleTransition(agent.records, {
    sessionId: 'session-1',
    runId,
    transitionId: 'insert-1',
    phase: 'packet_confirmation',
    originTask: '.trellis/tasks/origin',
    insertedTask: '.trellis/tasks/review',
    capability: handle,
  });
  return { agent, persistence, handle };
}

class CrashControlledPersistence extends InMemoryAgentRecordPersistence {
  private durableLength = 0;
  private failFlushAt: number | undefined;
  private flushCount = 0;

  constructor(records: readonly AgentRecord[] = []) {
    super(records);
    this.durableLength = records.length;
  }

  failAt(flushCount: number): void {
    this.failFlushAt = flushCount;
  }

  override async flush(): Promise<void> {
    this.flushCount += 1;
    if (this.flushCount === this.failFlushAt) throw new Error('simulated crash');
    this.durableLength = this.records.length;
  }

  durableRecords(): readonly AgentRecord[] {
    return this.records.slice(0, this.durableLength);
  }
}

function createSession(agent: ReturnType<typeof testAgent>['agent'], trusted: AgoraLifecycleAdapter): Session {
  return {
    options: { id: 'session-1' },
    metadata: { createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
    agoraLifecycleAdapter: trusted,
    ensureAgentResumed: vi.fn(async () => agent),
    rpc: { emitEvent: vi.fn(async () => undefined) },
  } as unknown as Session;
}

function proposal(revision = 1): AgoraMaterializationProposal {
  return {
    revision,
    disposition: {
      kind: 'successor',
      relation: 'corrects',
      title: 'Correct typed lifecycle',
      slug: 'correct-typed-lifecycle',
    },
    mode: 'acceptance',
    prd: '# PRD\nConfirmed requirements.\n',
    design: '# Design\nTyped trust boundary.\n',
    implement: '# Implement\nResume at validation.\n',
    resumeAnchor: 'Resume at validation.',
    curatedContext: { implement: '{"path":"implement.md"}\n', check: '{"path":"check.md"}\n' },
    acceptance: { state: 'confirmed', criteria: ['Typed materialization succeeds.'] },
    validation: { state: 'confirmed', commands: ['pnpm test'] },
    decisionBrief: { decision: 'Materialize successor.', rationale: 'Typed evidence converged.', unresolved: [] },
    peerEvidence: [{ peer: 'claude', disposition: 'accepted', summary: 'Contract verified.' }],
    runEvidence: ['Durable peer record contains raw and normalized evidence.'],
  };
}

function logConvergedRun(agent: ReturnType<typeof testAgent>['agent'], runId = 'run-1', packetRevision = 1) {
  agent.records.logRecord({
    type: 'agora.run',
    runId,
    phase: 'trellis_convergence',
    packetRevision,
    packet: { userGoal: runId },
    necessity: {
      outcome: 'allowed_on_request',
      signals: {
        impactIfWrong: 'medium',
        uncertaintyOrDisagreement: 'medium',
        expectedInformationGain: 'medium',
        incrementalCostLatency: 'medium',
      },
      explanation: 'test',
      normalWorkflowRecommendation: 'test',
      forcedByUser: false,
    },
    routes: { claude: { backend: 'claude-code', modelOverride: 'Opus 4.8' } },
    peers: [{
      peer: 'claude',
      backend: 'claude-code',
      status: 'completed',
      initialRawResponse: 'raw evidence',
      normalizedResponse: { position: 'support' },
      repairCount: 0,
    }],
    temporaryOverrides: { claude: 'disposed' },
    hostRoute: 'coder',
    routeUpgrade: 'none',
    terminalState: 'converged',
  });
}

function advanceToMaterializable(
  agent: ReturnType<typeof testAgent>['agent'],
  handle: ReturnType<typeof createAgoraLifecycleCapability>,
) {
  logConvergedRun(agent, handle.runId);
  recordAgoraLifecycleToTaskMaterialization(agent.records, handle);
  return handle;
}

function adapter(): AgoraLifecycleAdapter & {
  insert: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  materialize: ReturnType<typeof vi.fn>;
} {
  return {
    insert: vi.fn(async () => ({ success: true, insertedTask: '.trellis/tasks/review' })),
    cancel: vi.fn(async () => ({ success: true, terminalState: 'cancelled' })),
    materialize: vi.fn(async (input) => ({
      success: true,
      handoff: {
        runId: input.runId,
        sourceSessionId: input.sourceSessionId,
        targetTask: input.provenance.targetTask ?? '.trellis/tasks/successor',
        handoffPath: `${input.provenance.targetTask ?? '.trellis/tasks/successor'}/agora-handoff.json`,
        phase: 'fresh_session_pending' as const,
        digest: 'a'.repeat(64),
      },
    })),
  };
}

describe('Agora typed lifecycle capabilities', () => {
  it('exports the shared terminal phase set from lifecycle and the agora barrel', () => {
    expect([...TERMINAL_PHASES].toSorted()).toEqual([
      'cancelled',
      'resolved_to_origin',
      'resolved_to_successor',
    ]);
    expect(TERMINAL_PHASES_FROM_BARREL).toBe(TERMINAL_PHASES);
    for (const phase of TERMINAL_PHASES) {
      expect(isAgoraLifecycleTerminal(phase)).toBe(true);
    }
    expect(isAgoraLifecycleTerminal('peer_review')).toBe(false);
  });

  it('rejects handles across sessions, runs, replays, and old epochs', async () => {
    const { agent, persistence, handle } = setup();
    expect(() => verifyAgoraLifecycleHandle(agent.records, { ...handle, sessionId: 'session-2' })).toThrow('different session');
    expect(() => verifyAgoraLifecycleHandle(agent.records, { ...handle, runId: 'run-2' })).toThrow('no durable lifecycle');

    await agent.records.flush();
    const replayed = testAgent({ persistence: new InMemoryAgentRecordPersistence(persistence.records) }).agent;
    await replayed.records.replay();
    expect(() => verifyAgoraLifecycleHandle(replayed.records, handle)).not.toThrow();

    recordAgoraLifecycleTransition(replayed.records, {
      sessionId: 'session-1',
      runId: 'run-1',
      transitionId: 'peer-1',
      phase: 'peer_review',
      originTask: '.trellis/tasks/origin',
      insertedTask: '.trellis/tasks/review',
      capability: createAgoraLifecycleCapability('session-1', 'run-1', 'epoch-2', 'secret-2'),
    });
    expect(() => verifyAgoraLifecycleHandle(replayed.records, handle)).toThrow('epoch is stale');
  });

  it('cancels once using a fixed typed adapter operation', async () => {
    const { agent, handle } = setup();
    const trusted = adapter();
    await expect(cancelAgoraLifecycleTransition(agent.records, trusted, handle, 'cancel-1')).resolves.toMatchObject({
      phase: 'cancelled',
      cancelled: true,
    });
    expect(trusted.cancel).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'cancel',
      runId: 'run-1',
      reconcile: true,
    }));
    expect(trusted.cancel.mock.calls[0]?.[0]).not.toHaveProperty('argv');
    await expect(cancelAgoraLifecycleTransition(agent.records, trusted, handle, 'cancel-1')).resolves.toMatchObject({ phase: 'cancelled' });
    expect(trusted.cancel).toHaveBeenCalledTimes(1);
  });

  it('binds canonical proposal hash and revision to durable confirmation and provenance', async () => {
    const { agent, handle } = setup();
    advanceToMaterializable(agent, handle);
    const typedProposal = proposal();
    const confirmation = confirmAgoraMaterializationProposal(agent.records, handle, typedProposal, 'user');
    expect(confirmation).toMatchObject({
      runId: 'run-1',
      sourceSessionId: 'session-1',
      proposalRevision: 1,
      proposalHash: hashAgoraMaterializationProposal(typedProposal),
      confirmedBy: 'user',
    });

    const trusted = adapter();
    await expect(materializeAgoraLifecycleTransition(
      agent.records,
      trusted,
      handle,
      'materialize-1',
      ['session-0', 'session-1'],
      typedProposal,
      confirmation,
    )).resolves.toMatchObject({ success: true });
    expect(trusted.materialize).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      transitionId: 'materialize-1',
      sourceSessionId: 'session-1',
      sourceSessionLineage: ['session-0', 'session-1'],
      proposal: typedProposal,
      proposalHash: confirmation.proposalHash,
      run: expect.objectContaining({ runId: 'run-1', packetRevision: 1 }),
      provenance: {
        runPacketRevision: 1,
        originTask: '.trellis/tasks/origin',
        insertedTask: '.trellis/tasks/review',
        targetTask: undefined,
      },
    }));
    expect(trusted.materialize.mock.calls[0]?.[0]).not.toHaveProperty('argv');
  });

  it.each([
    ['stale hash', (confirmation: ReturnType<typeof confirmAgoraMaterializationProposal>) => ({ ...confirmation, proposalHash: '0'.repeat(64) })],
    ['stale revision', (confirmation: ReturnType<typeof confirmAgoraMaterializationProposal>) => ({ ...confirmation, proposalRevision: 2 })],
    ['cross-session', (confirmation: ReturnType<typeof confirmAgoraMaterializationProposal>) => ({ ...confirmation, sourceSessionId: 'session-2' })],
    ['cross-run', (confirmation: ReturnType<typeof confirmAgoraMaterializationProposal>) => ({ ...confirmation, runId: 'run-2' })],
  ])('rejects %s confirmation before adapter execution', async (_name, mutate) => {
    const { agent, handle } = setup();
    advanceToMaterializable(agent, handle);
    const typedProposal = proposal();
    const confirmation = confirmAgoraMaterializationProposal(agent.records, handle, typedProposal, 'host');
    const trusted = adapter();
    await expect(materializeAgoraLifecycleTransition(
      agent.records,
      trusted,
      handle,
      'materialize-1',
      ['session-1'],
      typedProposal,
      mutate(confirmation),
    )).resolves.toMatchObject({ success: false });
    expect(trusted.materialize).not.toHaveBeenCalled();
  });

  it('rejects proposal replay and stale lifecycle/run epochs', async () => {
    const { agent, handle } = setup();
    advanceToMaterializable(agent, handle);
    const typedProposal = proposal();
    const confirmation = confirmAgoraMaterializationProposal(agent.records, handle, typedProposal, 'user');
    const trusted = adapter();

    await materializeAgoraLifecycleTransition(
      agent.records,
      trusted,
      handle,
      'materialize-1',
      ['session-1'],
      typedProposal,
      confirmation,
    );
    await expect(materializeAgoraLifecycleTransition(
      agent.records,
      trusted,
      handle,
      'materialize-2',
      ['session-1'],
      typedProposal,
      confirmation,
    )).resolves.toMatchObject({ success: false, error: expect.stringContaining('different transition') });

    const { agent: changedRun, handle: changedHandle } = setup();
    logConvergedRun(changedRun, 'run-1', 1);
    recordAgoraLifecycleToTaskMaterialization(changedRun.records, changedHandle);
    const changedConfirmation = confirmAgoraMaterializationProposal(changedRun.records, changedHandle, typedProposal, 'user');
    logConvergedRun(changedRun, 'run-1', 2);
    await expect(materializeAgoraLifecycleTransition(
      changedRun.records,
      adapter(),
      changedHandle,
      'materialize-1',
      ['session-1'],
      typedProposal,
      changedConfirmation,
    )).resolves.toMatchObject({ success: false, error: expect.stringContaining('stale') });
  });

  it.each(['resolved_to_origin', 'resolved_to_successor', 'cancelled'] as const)(
    'rejects materialization from terminal phase %s', (phase) => {
      const { agent } = setup();
      logConvergedRun(agent);
      const handle = createAgoraLifecycleCapability('session-1', 'run-1', 'epoch-terminal', 'secret-terminal');
      recordAgoraLifecycleTransition(agent.records, {
        sessionId: 'session-1',
        runId: 'run-1',
        transitionId: `terminal-${phase}`,
        phase,
        originTask: '.trellis/tasks/origin',
        insertedTask: '.trellis/tasks/review',
        capability: handle,
      });
      expect(() => confirmAgoraMaterializationProposal(agent.records, handle, proposal(), 'user'))
        .toThrow('not in a materializable phase');
    },
  );

  it('rejects forged slug and incomplete durable peer evidence', () => {
    const { agent, handle } = setup();
    advanceToMaterializable(agent, handle);
    expect(() => confirmAgoraMaterializationProposal(agent.records, handle, {
      ...proposal(),
      disposition: { kind: 'successor', relation: 'corrects', title: 'Safe title', slug: '../forged' },
    }, 'user')).toThrow('canonical lowercase slug');

    const { agent: incomplete, handle: incompleteHandle } = setup();
    logConvergedRun(incomplete);
    incomplete.records.logRecord({
      ...incomplete.records.latestAgoraRun('run-1')!,
      type: 'agora.run',
      peers: [],
    });
    expect(() => confirmAgoraMaterializationProposal(incomplete.records, incompleteHandle, proposal(), 'user'))
      .toThrow('terminal peer evidence');
  });

  it('reconciles failed flush only with original host-minted capability', async () => {
    class FailOncePersistence extends InMemoryAgentRecordPersistence {
      private fail = true;
      override async flush(): Promise<void> {
        if (this.fail) {
          this.fail = false;
          throw new Error('disk unavailable');
        }
      }
    }

    const persistence = new FailOncePersistence();
    const agent = testAgent({ persistence }).agent;
    const trusted = adapter();
    const emitEvent = vi.fn(async () => undefined);
    const session = {
      options: { id: 'session-1' },
      agoraLifecycleAdapter: trusted,
      ensureAgentResumed: vi.fn(async () => agent),
      rpc: { emitEvent },
    } as unknown as Session;
    const api = new SessionAPIImpl(session);
    let retryHandle: AgoraLifecycleCapability | undefined;
    try {
      await api.insertAgoraReview({ runId: 'run-1', transitionId: 'insert-1', title: 'Review' });
      throw new Error('expected failed flush');
    } catch (error) {
      expect(error).toBeInstanceOf(KimiError);
      expect((error as KimiError).code).toBe(ErrorCodes.RECORDS_WRITE_FAILED);
      retryHandle = (error as KimiError).details?.['retryHandle'] as AgoraLifecycleCapability;
      expect(retryHandle).not.toHaveProperty('secret');
      expect(JSON.stringify((error as KimiError).details)).not.toContain('secret');
    }
    expect(trusted.insert).toHaveBeenCalledTimes(1);
    expect(trusted.insert.mock.calls[0]?.[0]).toMatchObject({
      operation: 'insert',
      insert: { title: 'Review', slug: undefined },
    });
    expect(trusted.insert.mock.calls[0]?.[0]).not.toHaveProperty('argv');

    await expect(api.insertAgoraReview({
      runId: 'run-1',
      transitionId: 'insert-1',
      title: 'Review',
      capability: retryHandle!,
    })).resolves.toMatchObject({ handle: retryHandle });
    expect(trusted.insert).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith(expect.not.objectContaining({
      capability: expect.anything(),
      capabilityHash: expect.anything(),
      capabilityEpoch: expect.anything(),
    }));
  });

  it('runs the public RPC flow through durable convergence without exposing bearer material', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const agent = testAgent({ persistence }).agent;
    const trusted = adapter();
    const api = new SessionAPIImpl(createSession(agent, trusted));
    const inserted = await api.insertAgoraReview({
      runId: 'run-rpc',
      transitionId: 'insert-rpc',
      title: 'Review',
    });
    expect(inserted.handle).not.toHaveProperty('secret');
    expect(JSON.stringify(inserted)).not.toContain('secret');

    logConvergedRun(agent, 'run-rpc');
    const typedProposal = proposal();
    const confirmation = await api.confirmAgoraMaterialization({
      runId: 'run-rpc',
      capability: inserted.handle,
      proposal: typedProposal,
    });
    expect(confirmation.confirmedBy).toBe('host');
    expect(agent.records.latestAgoraLifecycle('run-rpc')?.phase).toBe('task_materialization');

    const result = await api.materializeAgoraReview({
      runId: 'run-rpc',
      transitionId: 'materialize-rpc',
      capability: inserted.handle,
      proposal: typedProposal,
      confirmation: {
        runId: confirmation.runId,
        sourceSessionId: confirmation.sourceSessionId,
        proposalRevision: confirmation.proposalRevision,
        proposalHash: confirmation.proposalHash,
      },
    });
    expect(result).toMatchObject({
      success: true,
      handoff: {
        targetTask: '.trellis/tasks/successor',
        digest: 'a'.repeat(64),
      },
    });
    expect(agent.records.latestAgoraLifecycle('run-rpc')).toMatchObject({
      phase: 'fresh_session_pending',
      materializationTransitionId: 'materialize-rpc',
      materializationHandoffPath: '.trellis/tasks/successor/agora-handoff.json',
      materializationDigest: 'a'.repeat(64),
    });
    expect(agent.records.latestAgoraMaterializationConfirmation('run-rpc')).toMatchObject({
      state: 'consumed',
      consumedBy: 'materialize-rpc',
      confirmedBy: 'host',
    });
  });

  it('does not invoke the adapter when executing reservation fails to flush', async () => {
    const persistence = new CrashControlledPersistence();
    const agent = testAgent({ persistence }).agent;
    const handle = createAgoraLifecycleCapability('session-1', 'run-crash-before', 'epoch-1', 'secret-1');
    recordAgoraLifecycleTransition(agent.records, {
      sessionId: 'session-1', runId: 'run-crash-before', transitionId: 'insert-1', phase: 'packet_confirmation',
      insertedTask: '.trellis/tasks/review', capability: handle,
    });
    logConvergedRun(agent, 'run-crash-before');
    recordAgoraLifecycleToTaskMaterialization(agent.records, handle);
    const typedProposal = proposal();
    const confirmation = confirmAgoraMaterializationProposal(agent.records, handle, typedProposal, 'host');
    await agent.records.flush();
    persistence.failAt(2);
    const trusted = adapter();

    await expect(materializeAgoraLifecycleTransition(
      agent.records, trusted, handle, 'materialize-1', ['session-1'], typedProposal, confirmation,
    )).rejects.toThrow('simulated crash');
    expect(trusted.materialize).not.toHaveBeenCalled();
    const resumed = testAgent({ persistence: new InMemoryAgentRecordPersistence(persistence.durableRecords()) }).agent;
    await resumed.records.replay();
    expect(resumed.records.latestAgoraLifecycle('run-crash-before')?.phase).toBe('task_materialization');
    await expect(materializeAgoraLifecycleTransition(
      resumed.records, trusted, handle, 'materialize-1', ['session-1'], typedProposal, confirmation,
    )).resolves.toMatchObject({ success: true });
    expect(trusted.materialize).toHaveBeenCalledTimes(1);
  });

  it('flushes pending applied records on same-process retry without rerunning the adapter', async () => {
    const { agent, handle } = setup('run-crash-after-adapter');
    advanceToMaterializable(agent, handle);
    const typedProposal = proposal();
    const confirmation = confirmAgoraMaterializationProposal(agent.records, handle, typedProposal, 'host');
    const trusted = adapter();
    const flush = vi.spyOn(agent.records, 'flush')
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('simulated applied flush crash'));

    await expect(materializeAgoraLifecycleTransition(
      agent.records, trusted, handle, 'materialize-1', ['session-1'], typedProposal, confirmation,
    )).rejects.toThrow('simulated applied flush crash');
    expect(agent.records.history('agora.lifecycle').find((record) =>
      record.phase === 'materialization_executing' && record.materializationTransitionId === 'materialize-1')).toBeDefined();
    expect(trusted.materialize).toHaveBeenCalledTimes(1);

    flush.mockResolvedValue(undefined);
    await expect(materializeAgoraLifecycleTransition(
      agent.records, trusted, handle, 'materialize-1', ['session-1'], typedProposal, confirmation,
    )).resolves.toMatchObject({ success: true });
    expect(trusted.materialize).toHaveBeenCalledTimes(1);
    expect(agent.records.latestAgoraLifecycle('run-crash-after-adapter')?.materializationTransitionId).toBe('materialize-1');
  });

  it('reconciles durable executing state with the original transition after resume', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const agent = testAgent({ persistence }).agent;
    const handle = createAgoraLifecycleCapability('session-1', 'run-resume', 'epoch-1', 'secret-1');
    recordAgoraLifecycleTransition(agent.records, {
      sessionId: 'session-1', runId: 'run-resume', transitionId: 'insert-1', phase: 'packet_confirmation',
      insertedTask: '.trellis/tasks/review', capability: handle,
    });
    advanceToMaterializable(agent, handle);
    const typedProposal = proposal();
    const confirmation = confirmAgoraMaterializationProposal(agent.records, handle, typedProposal, 'host');
    recordAgoraLifecycleTransition(agent.records, {
      sessionId: 'session-1', runId: 'run-resume', transitionId: 'executing-materialize-1',
      phase: 'materialization_executing', insertedTask: '.trellis/tasks/review', capability: handle,
      materializationTransitionId: 'materialize-1',
    });
    await agent.records.flush();

    const resumed = testAgent({ persistence: new InMemoryAgentRecordPersistence(persistence.records) }).agent;
    await resumed.records.replay();
    const trusted = adapter();
    await expect(materializeAgoraLifecycleTransition(
      resumed.records, trusted, handle, 'materialize-1', ['session-1'], typedProposal, confirmation,
    )).resolves.toMatchObject({ success: true });
    expect(trusted.materialize).toHaveBeenCalledWith(expect.objectContaining({
      transitionId: 'materialize-1',
      lifecycle: expect.objectContaining({ phase: 'materialization_executing' }),
    }));
    await expect(materializeAgoraLifecycleTransition(
      resumed.records, trusted, handle, 'materialize-2', ['session-1'], typedProposal, confirmation,
    )).resolves.toMatchObject({ success: false, error: expect.stringContaining('different transition') });
  });

  it('stores only capabilityHash and strips digest/epoch from public snapshots', async () => {
    const { agent, handle } = setup();
    const record = agent.records.latestAgoraLifecycle('run-1');
    expect(JSON.stringify(record)).not.toContain('secret-1');
    expect(record?.capabilityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(record ?? {})).not.toContain('capabilityTokenHash');

    const session = {
      options: { id: 'session-1' },
      ensureAgentResumed: vi.fn(async () => agent),
    } as unknown as Session;
    const snapshot = await new SessionAPIImpl(session).getAgoraReview({ runId: handle.runId });
    expect(snapshot).not.toHaveProperty('capabilityHash');
    expect(snapshot).not.toHaveProperty('capabilityEpoch');
  });

  it('keeps the bearer across SessionAPIImpl instances that share a vault (reload survival)', async () => {
    // A session reload builds a fresh SessionAPIImpl; if the bearer vault were
    // per-instance the cancel after reload could no longer resolve the secret
    // and `/agora cancel` would fail with "not available in this trusted host".
    // Sharing the vault at core scope keeps the cancel working.
    const persistence = new InMemoryAgentRecordPersistence();
    const agent = testAgent({ persistence }).agent;
    const trusted = adapter();
    const session = createSession(agent, trusted);
    const sharedVault = new Map<string, ReturnType<typeof createAgoraLifecycleCapability>>();

    const beforeReload = new SessionAPIImpl(session, sharedVault);
    const inserted = await beforeReload.insertAgoraReview({
      runId: 'run-reload',
      transitionId: 'insert-reload',
    });

    const afterReload = new SessionAPIImpl(session, sharedVault);
    await expect(afterReload.cancelAgoraReview({
      runId: 'run-reload',
      transitionId: 'cancel-reload',
      capability: inserted.handle,
    })).resolves.toMatchObject({ phase: 'cancelled', cancelled: true });
    expect(trusted.cancel).toHaveBeenCalledTimes(1);
  });

  it('cannot cancel from an unrelated vault once the bearer is gone (control)', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const agent = testAgent({ persistence }).agent;
    const trusted = adapter();
    const session = createSession(agent, trusted);

    const inserted = await new SessionAPIImpl(session, new Map<string, ReturnType<typeof createAgoraLifecycleCapability>>())
      .insertAgoraReview({ runId: 'run-lost', transitionId: 'insert-lost' });

    const stranger = new SessionAPIImpl(session, new Map<string, ReturnType<typeof createAgoraLifecycleCapability>>());
    await expect(stranger.cancelAgoraReview({
      runId: 'run-lost',
      transitionId: 'cancel-lost',
      capability: inserted.handle,
    })).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    expect(trusted.cancel).not.toHaveBeenCalled();
  });

  it('retries cancel flush with the same handle without re-invoking the adapter', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const agent = testAgent({ persistence }).agent;
    const trusted = adapter();
    const session = createSession(agent, trusted);
    const vault = new Map<string, ReturnType<typeof createAgoraLifecycleCapability>>();
    const api = new SessionAPIImpl(session, vault);

    const inserted = await api.insertAgoraReview({
      runId: 'run-cancel-flush',
      transitionId: 'insert-cancel-flush',
    });
    expect(vault.size).toBe(1);

    const flush = vi.spyOn(agent.records, 'flush')
      .mockRejectedValueOnce(new Error('cancel flush unavailable'));
    await expect(api.cancelAgoraReview({
      runId: 'run-cancel-flush',
      transitionId: 'cancel-1',
      capability: inserted.handle,
    })).rejects.toThrow('cancel flush unavailable');
    expect(trusted.cancel).toHaveBeenCalledTimes(1);
    expect(vault.size).toBe(1);
    expect(agent.records.latestAgoraLifecycle('run-cancel-flush')?.phase).toBe('cancelled');

    flush.mockResolvedValue(undefined);
    await expect(api.cancelAgoraReview({
      runId: 'run-cancel-flush',
      transitionId: 'cancel-1',
      capability: inserted.handle,
    })).resolves.toMatchObject({ phase: 'cancelled', cancelled: true });
    expect(trusted.cancel).toHaveBeenCalledTimes(1);
    expect(vault.size).toBe(0);

    await expect(api.cancelAgoraReview({
      runId: 'run-cancel-flush',
      transitionId: 'cancel-1',
      capability: inserted.handle,
    })).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
  });

  it('drops vault entry on explicit insert failure but retains it when only flush fails', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const agent = testAgent({ persistence }).agent;
    const trusted = adapter();
    const session = createSession(agent, trusted);
    const vault = new Map<string, ReturnType<typeof createAgoraLifecycleCapability>>();
    const api = new SessionAPIImpl(session, vault);

    trusted.insert.mockResolvedValueOnce({ success: false, error: 'trellis refused insert' });
    await expect(api.insertAgoraReview({
      runId: 'run-insert-fail',
      transitionId: 'insert-fail',
      title: 'Review',
    })).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    expect(vault.size).toBe(0);
    expect(agent.records.latestAgoraLifecycle('run-insert-fail')).toBeUndefined();

    trusted.insert.mockResolvedValueOnce({ success: true, insertedTask: '.trellis/tasks/review' });
    const flush = vi.spyOn(agent.records, 'flush')
      .mockRejectedValueOnce(new Error('insert flush unavailable'));
    let retryHandle: AgoraLifecycleCapability | undefined;
    try {
      await api.insertAgoraReview({
        runId: 'run-insert-retain',
        transitionId: 'insert-retain',
        title: 'Review',
      });
      throw new Error('expected failed flush');
    } catch (error) {
      expect(error).toBeInstanceOf(KimiError);
      expect((error as KimiError).code).toBe(ErrorCodes.RECORDS_WRITE_FAILED);
      retryHandle = (error as KimiError).details?.['retryHandle'] as AgoraLifecycleCapability;
    }
    expect(vault.size).toBe(1);
    expect(trusted.insert).toHaveBeenCalledTimes(2);

    flush.mockResolvedValue(undefined);
    await expect(api.insertAgoraReview({
      runId: 'run-insert-retain',
      transitionId: 'insert-retain',
      title: 'Review',
      capability: retryHandle!,
    })).resolves.toMatchObject({ handle: retryHandle });
    expect(trusted.insert).toHaveBeenCalledTimes(2);
    expect(vault.size).toBe(1);
  });

  it('does not return a successful handoff resolution before the terminal event is accepted', async () => {
    const agent = testAgent({ persistence: new InMemoryAgentRecordPersistence() }).agent;
    const trusted = adapter();
    let acceptTerminalEvent!: () => void;
    let eventPublished!: () => void;
    const terminalEventAccepted = new Promise<void>((resolve) => {
      acceptTerminalEvent = resolve;
    });
    const terminalEventPublished = new Promise<void>((resolve) => {
      eventPublished = resolve;
    });
    const session = createSession(agent, trusted);
    session.rpc.emitEvent = vi.fn(() => {
      eventPublished();
      return terminalEventAccepted;
    });
    const vault = new Map<string, ReturnType<typeof createAgoraLifecycleCapability>>();
    const api = new SessionAPIImpl(session, vault);
    const capability = createAgoraLifecycleCapability('session-1', 'run-event-order', 'epoch-event-order', 'secret-event-order');
    const handoff = {
      runId: 'run-event-order',
      sourceSessionId: 'session-1',
      targetTask: '.trellis/tasks/successor',
      handoffPath: '.trellis/tasks/successor/agora-handoff.json',
      phase: 'fresh_session_pending' as const,
      digest: 'c'.repeat(64),
    };
    recordAgoraLifecycleTransition(agent.records, {
      sessionId: 'session-1',
      runId: 'run-event-order',
      transitionId: 'materialize-event-order',
      phase: 'fresh_session_pending',
      insertedTask: '.trellis/tasks/review',
      targetTask: handoff.targetTask,
      terminalState: 'materialized',
      capability,
      materializationTransitionId: 'materialize-event-order',
      materializationHandoffPath: handoff.handoffPath,
      materializationDigest: handoff.digest,
    });
    vault.set(capability.operationId, capability);

    let resolved = false;
    let resolutionError: unknown;
    let resolutionSettled!: () => void;
    const resolutionSettledPromise = new Promise<void>((resolve) => {
      resolutionSettled = resolve;
    });
    const resolution = api.resolveAgoraHandoff({
      runId: 'run-event-order',
      transitionId: 'resolve-event-order',
      capability: toAgoraLifecycleHandle(capability),
      handoff,
      resolution: 'resolved_to_successor',
    }).then(
      () => {
        resolved = true;
        resolutionSettled();
      },
      (error: unknown) => {
        resolutionError = error;
        resolutionSettled();
      },
    );

    const first = await Promise.race([
      terminalEventPublished.then(() => 'event' as const),
      resolutionSettledPromise.then(() => 'resolution' as const),
    ]);
    expect(first).toBe('event');
    expect(resolutionError).toBeUndefined();
    expect(session.rpc.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agora.lifecycle.updated',
      runId: 'run-event-order',
      phase: 'resolved_to_successor',
    }));
    expect(resolved).toBe(false);

    acceptTerminalEvent();
    await resolution;
    expect(resolved).toBe(true);
    expect(vault.size).toBe(0);
  });

  it('retains the handoff capability when terminal event delivery rejects, then releases it after retry', async () => {
    const agent = testAgent({ persistence: new InMemoryAgentRecordPersistence() }).agent;
    const trusted = adapter();
    const session = createSession(agent, trusted);
    const emitEvent = vi.fn()
      .mockRejectedValueOnce(new Error('terminal event transport unavailable'))
      .mockResolvedValueOnce(undefined);
    session.rpc.emitEvent = emitEvent;
    const vault = new Map<string, ReturnType<typeof createAgoraLifecycleCapability>>();
    const api = new SessionAPIImpl(session, vault);
    const capability = createAgoraLifecycleCapability('session-1', 'run-event-retry', 'epoch-event-retry', 'secret-event-retry');
    const handle = toAgoraLifecycleHandle(capability);
    const handoff = {
      runId: 'run-event-retry',
      sourceSessionId: 'session-1',
      targetTask: '.trellis/tasks/successor',
      handoffPath: '.trellis/tasks/successor/agora-handoff.json',
      phase: 'fresh_session_pending' as const,
      digest: 'd'.repeat(64),
    };
    recordAgoraLifecycleTransition(agent.records, {
      sessionId: 'session-1',
      runId: 'run-event-retry',
      transitionId: 'materialize-event-retry',
      phase: 'fresh_session_pending',
      insertedTask: '.trellis/tasks/review',
      targetTask: handoff.targetTask,
      terminalState: 'materialized',
      capability,
      materializationTransitionId: 'materialize-event-retry',
      materializationHandoffPath: handoff.handoffPath,
      materializationDigest: handoff.digest,
    });
    vault.set(capability.operationId, capability);

    const payload = {
      runId: 'run-event-retry',
      transitionId: 'resolve-event-retry',
      capability: handle,
      handoff,
      resolution: 'resolved_to_successor' as const,
    };
    await expect(api.resolveAgoraHandoff(payload)).rejects.toThrow('terminal event transport unavailable');
    expect(agent.records.latestAgoraLifecycle('run-event-retry')).toMatchObject({
      transitionId: 'resolve-event-retry',
      phase: 'resolved_to_successor',
    });
    expect(vault.get(capability.operationId)).toBe(capability);

    let retryResolved = false;
    await api.resolveAgoraHandoff(payload).then(() => {
      retryResolved = true;
    });
    expect(emitEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'agora.lifecycle.updated',
      runId: 'run-event-retry',
      phase: 'resolved_to_successor',
    }));
    expect(emitEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'agora.lifecycle.updated',
      runId: 'run-event-retry',
      phase: 'resolved_to_successor',
    }));
    expect(retryResolved).toBe(true);
    expect(vault.has(capability.operationId)).toBe(false);
  });

  it('retains vault through fresh-session pending and releases only after final terminal flush', async () => {
    const typedProposal = proposal();

    // Unsuccessful materialize keeps the bearer for reconciliation.
    {
      const agent = testAgent({ persistence: new InMemoryAgentRecordPersistence() }).agent;
      const trusted = adapter();
      const vault = new Map<string, ReturnType<typeof createAgoraLifecycleCapability>>();
      const api = new SessionAPIImpl(createSession(agent, trusted), vault);
      const inserted = await api.insertAgoraReview({
        runId: 'run-materialize-fail',
        transitionId: 'insert-materialize-fail',
      });
      logConvergedRun(agent, 'run-materialize-fail');
      const confirmation = await api.confirmAgoraMaterialization({
        runId: 'run-materialize-fail',
        capability: inserted.handle,
        proposal: typedProposal,
      });
      trusted.materialize.mockResolvedValueOnce({
        success: false,
        error: 'materialize refused',
        mutationCommitted: false,
      });
      await expect(api.materializeAgoraReview({
        runId: 'run-materialize-fail',
        transitionId: 'materialize-fail',
        capability: inserted.handle,
        proposal: typedProposal,
        confirmation: {
          runId: confirmation.runId,
          sourceSessionId: confirmation.sourceSessionId,
          proposalRevision: confirmation.proposalRevision,
          proposalHash: confirmation.proposalHash,
        },
      })).resolves.toMatchObject({ success: false });
      expect(vault.size).toBe(1);
    }

    // A pending handoff is non-terminal: it retains the bearer until the
    // target bind resolves a provenanced terminal transition.
    {
      const agent = testAgent({ persistence: new InMemoryAgentRecordPersistence() }).agent;
      const trusted = adapter();
      const vault = new Map<string, ReturnType<typeof createAgoraLifecycleCapability>>();
      const api = new SessionAPIImpl(createSession(agent, trusted), vault);
      const inserted = await api.insertAgoraReview({
        runId: 'run-materialize-ok',
        transitionId: 'insert-materialize-ok',
      });
      logConvergedRun(agent, 'run-materialize-ok');
      const confirmation = await api.confirmAgoraMaterialization({
        runId: 'run-materialize-ok',
        capability: inserted.handle,
        proposal: typedProposal,
      });

      await expect(api.resolveAgoraHandoff({
        runId: 'run-materialize-ok',
        transitionId: 'resolve-before-pending',
        capability: inserted.handle,
        handoff: {
          runId: 'run-materialize-ok',
          sourceSessionId: 'session-1',
          targetTask: '.trellis/tasks/successor',
          handoffPath: '.trellis/tasks/successor/agora-handoff.json',
          phase: 'fresh_session_pending',
          digest: 'b'.repeat(64),
        },
        resolution: 'resolved_to_successor',
      })).rejects.toThrow('not awaiting fresh-session handoff resolution');

      const materialized = await api.materializeAgoraReview({
        runId: 'run-materialize-ok',
        transitionId: 'materialize-ok-final',
        capability: inserted.handle,
        proposal: typedProposal,
        confirmation: {
          runId: confirmation.runId,
          sourceSessionId: confirmation.sourceSessionId,
          proposalRevision: confirmation.proposalRevision,
          proposalHash: confirmation.proposalHash,
        },
      });
      if (!materialized.success || materialized.handoff === undefined) {
        throw new Error('Expected a pending handoff from successful materialization.');
      }
      expect(vault.size).toBe(1);
      expect(agent.records.latestAgoraLifecycle('run-materialize-ok')).toMatchObject({
        phase: 'fresh_session_pending',
        materializationTransitionId: 'materialize-ok-final',
      });
      expect(trusted.materialize).toHaveBeenCalledTimes(1);

      await expect(api.resolveAgoraHandoff({
        runId: 'run-materialize-ok',
        transitionId: 'resolve-ok',
        capability: inserted.handle,
        handoff: { ...materialized.handoff, digest: 'b'.repeat(64) },
        resolution: 'resolved_to_successor',
      })).rejects.toThrow('handoff provenance does not match');
      expect(vault.size).toBe(1);

      await expect(api.resolveAgoraHandoff({
        runId: 'run-materialize-ok',
        transitionId: 'resolve-ok',
        capability: inserted.handle,
        handoff: materialized.handoff,
        resolution: 'resolved_to_successor',
      })).resolves.toMatchObject({
        phase: 'resolved_to_successor',
        terminalState: 'materialized',
      });
      expect(agent.records.latestAgoraLifecycle('run-materialize-ok')).toMatchObject({
        phase: 'resolved_to_successor',
        terminalState: 'materialized',
      });
      expect(vault.size).toBe(0);
    }

    // A terminal record may already be appended when its final durable flush
    // fails. Its same transition retries without rematerializing, then releases.
    {
      const agent = testAgent({ persistence: new InMemoryAgentRecordPersistence() }).agent;
      const trusted = adapter();
      const vault = new Map<string, ReturnType<typeof createAgoraLifecycleCapability>>();
      const api = new SessionAPIImpl(createSession(agent, trusted), vault);
      const inserted = await api.insertAgoraReview({
        runId: 'run-terminal-flush',
        transitionId: 'insert-terminal-flush',
      });
      logConvergedRun(agent, 'run-terminal-flush');
      const confirmation = await api.confirmAgoraMaterialization({
        runId: 'run-terminal-flush',
        capability: inserted.handle,
        proposal: typedProposal,
      });
      const materialized = await api.materializeAgoraReview({
        runId: 'run-terminal-flush',
        transitionId: 'materialize-terminal-flush',
        capability: inserted.handle,
        proposal: typedProposal,
        confirmation: {
          runId: confirmation.runId,
          sourceSessionId: confirmation.sourceSessionId,
          proposalRevision: confirmation.proposalRevision,
          proposalHash: confirmation.proposalHash,
        },
      });
      if (!materialized.success || materialized.handoff === undefined) {
        throw new Error('Expected a pending handoff from successful materialization.');
      }

      const flush = vi.spyOn(agent.records, 'flush')
        .mockRejectedValueOnce(new Error('final terminal flush unavailable'));
      await expect(api.resolveAgoraHandoff({
        runId: 'run-terminal-flush',
        transitionId: 'resolve-terminal-flush',
        capability: inserted.handle,
        handoff: materialized.handoff,
        resolution: 'resolved_to_successor',
      })).rejects.toThrow('final terminal flush unavailable');
      expect(agent.records.latestAgoraLifecycle('run-terminal-flush')?.phase).toBe('resolved_to_successor');
      expect(vault.size).toBe(1);
      expect(trusted.materialize).toHaveBeenCalledTimes(1);

      flush.mockResolvedValue(undefined);
      await expect(api.resolveAgoraHandoff({
        runId: 'run-terminal-flush',
        transitionId: 'resolve-terminal-flush',
        capability: inserted.handle,
        handoff: materialized.handoff,
        resolution: 'resolved_to_successor',
      })).resolves.toMatchObject({ phase: 'resolved_to_successor' });
      expect(vault.size).toBe(0);
      expect(trusted.materialize).toHaveBeenCalledTimes(1);
    }

    // Successful adapter + applied records, but the materialization wrapper
    // flush fails. Retrying only re-flushes pending records; final resolution
    // remains the sole release point.
    {
      const agent = testAgent({ persistence: new InMemoryAgentRecordPersistence() }).agent;
      const trusted = adapter();
      const vault = new Map<string, ReturnType<typeof createAgoraLifecycleCapability>>();
      const api = new SessionAPIImpl(createSession(agent, trusted), vault);
      const inserted = await api.insertAgoraReview({
        runId: 'run-materialize-flush',
        transitionId: 'insert-materialize-flush',
      });
      logConvergedRun(agent, 'run-materialize-flush');
      const confirmation = await api.confirmAgoraMaterialization({
        runId: 'run-materialize-flush',
        capability: inserted.handle,
        proposal: typedProposal,
      });

      let flushCount = 0;
      const flush = vi.spyOn(agent.records, 'flush').mockImplementation(async () => {
        flushCount += 1;
        // Executing reservation + applied records flush inside lifecycle, then wrapper flush.
        if (flushCount >= 3) throw new Error('final materialize flush unavailable');
      });

      await expect(api.materializeAgoraReview({
        runId: 'run-materialize-flush',
        transitionId: 'materialize-flush',
        capability: inserted.handle,
        proposal: typedProposal,
        confirmation: {
          runId: confirmation.runId,
          sourceSessionId: confirmation.sourceSessionId,
          proposalRevision: confirmation.proposalRevision,
          proposalHash: confirmation.proposalHash,
        },
      })).rejects.toThrow('final materialize flush unavailable');
      expect(vault.size).toBe(1);
      expect(trusted.materialize).toHaveBeenCalledTimes(1);

      flush.mockResolvedValue(undefined);
      const materialized = await api.materializeAgoraReview({
        runId: 'run-materialize-flush',
        transitionId: 'materialize-flush',
        capability: inserted.handle,
        proposal: typedProposal,
        confirmation: {
          runId: confirmation.runId,
          sourceSessionId: confirmation.sourceSessionId,
          proposalRevision: confirmation.proposalRevision,
          proposalHash: confirmation.proposalHash,
        },
      });
      if (!materialized.success || materialized.handoff === undefined) {
        throw new Error('Expected a pending handoff from materialization retry.');
      }
      expect(vault.size).toBe(1);
      expect(trusted.materialize).toHaveBeenCalledTimes(1);

      await api.resolveAgoraHandoff({
        runId: 'run-materialize-flush',
        transitionId: 'resolve-materialize-flush',
        capability: inserted.handle,
        handoff: materialized.handoff,
        resolution: 'resolved_to_successor',
      });
      expect(vault.size).toBe(0);
    }
  });
});
