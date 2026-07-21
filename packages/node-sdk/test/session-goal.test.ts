import { describe, expect, it, vi } from 'vitest';

import { Session } from '#/session';
import type { SDKRpcClientBase } from '#/rpc';

function makeSession() {
  const rpc = {
    createGoal: vi.fn(async () => ({ goalId: 'g1' })),
    getGoal: vi.fn(async () => ({ goal: null })),
    pauseGoal: vi.fn(async () => ({ goalId: 'g1' })),
    resumeGoal: vi.fn(async () => ({ goalId: 'g1' })),
    cancelGoal: vi.fn(async () => ({ goalId: 'g1' })),
    getCronTasks: vi.fn(async () => ({ tasks: [] })),
    insertAgoraReview: vi.fn(async () => ({
      handle: { sessionId: 'ses_goal', runId: 'run-1', epoch: 'epoch-1', operationId: 'operation-1' },
      snapshot: { runId: 'run-1', transitionId: 't-1', phase: 'packet_confirmation', sourceSessionId: 'ses_goal' },
    })),
    getAgoraReview: vi.fn(async () => undefined),
    cancelAgoraReview: vi.fn(async () => ({ runId: 'run-1', phase: 'cancelled', cancelled: true })),
    confirmAgoraMaterialization: vi.fn(async () => ({
      runId: 'run-1',
      sourceSessionId: 'ses_goal',
      proposalRevision: 1,
      proposalHash: 'a'.repeat(64),
      confirmedBy: 'host',
    })),
    materializeAgoraReview: vi.fn(async () => ({ runId: 'run-1', success: false })),
    clearSessionHandlers: vi.fn(),
  } as unknown as SDKRpcClientBase;
  const session = new Session({ id: 'ses_goal', workDir: '/tmp/work', rpc });
  return { session, rpc };
}

describe('Session goal methods', () => {
  it('createGoal forwards the supported payload with sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.createGoal({
      objective: 'Ship feature X',
      replace: true,
    });
    expect(rpc.createGoal).toHaveBeenCalledWith({
      sessionId: 'ses_goal',
      objective: 'Ship feature X',
      replace: true,
    });
  });

  it('getGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.getGoal();
    expect(rpc.getGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('pauseGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.pauseGoal();
    expect(rpc.pauseGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('resumeGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.resumeGoal();
    expect(rpc.resumeGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('cancelGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.cancelGoal();
    expect(rpc.cancelGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('getCronTasks forwards sessionId and returns the task list', async () => {
    const { session, rpc } = makeSession();
    const result = await session.getCronTasks();
    expect(rpc.getCronTasks).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
    expect(result).toEqual({ tasks: [] });
  });

  it('forwards typed Agora lifecycle methods without arbitrary argv', async () => {
    const { session, rpc } = makeSession();
    const inserted = await session.insertAgoraReview({
      runId: 'run-1',
      transitionId: 't-1',
      title: 'Typed review',
      slug: 'typed-review',
    });
    expect(rpc.insertAgoraReview).toHaveBeenCalledWith({
      sessionId: 'ses_goal',
      runId: 'run-1',
      transitionId: 't-1',
      title: 'Typed review',
      slug: 'typed-review',
      capability: undefined,
    });
    const firstInsert = vi.mocked(rpc.insertAgoraReview).mock.calls[0]?.[0];
    expect(firstInsert).not.toHaveProperty('argv');

    const proposal = {
      revision: 1,
      disposition: { kind: 'resume' as const },
      mode: 'acceptance' as const,
      prd: '# PRD',
      design: '# Design',
      implement: 'Resume here',
      resumeAnchor: 'Resume here',
      acceptance: { state: 'confirmed' as const, criteria: ['done'] },
      validation: { state: 'confirmed' as const, commands: ['pnpm test'] },
      decisionBrief: { decision: 'Resume.', rationale: 'Evidence converged.', unresolved: [] },
      peerEvidence: [{ peer: 'claude', disposition: 'accepted' as const, summary: 'ok' }],
      runEvidence: ['durable run'],
    };
    const confirmation = await session.confirmAgoraMaterialization({
      runId: 'run-1',
      capability: inserted.handle,
      proposal,
    });
    const confirmationProof = {
      runId: confirmation.runId,
      sourceSessionId: confirmation.sourceSessionId,
      proposalRevision: confirmation.proposalRevision,
      proposalHash: confirmation.proposalHash,
    };
    await session.materializeAgoraReview({
      runId: 'run-1',
      transitionId: 't-3',
      capability: inserted.handle,
      proposal,
      confirmation: confirmationProof,
    });
    expect(rpc.materializeAgoraReview).toHaveBeenCalledWith({
      sessionId: 'ses_goal',
      runId: 'run-1',
      transitionId: 't-3',
      capability: inserted.handle,
      proposal,
      confirmation: confirmationProof,
    });

    await expect(session.insertAgoraReview({ runId: ' ', transitionId: 't' }))
      .rejects.toMatchObject({ code: 'request.invalid' });
    await expect(session.cancelAgoraReview({ runId: 'run-1', transitionId: ' ', capability: inserted.handle }))
      .rejects.toMatchObject({ code: 'request.invalid' });
    await expect(session.cancelAgoraReview({ runId: 'run-2', transitionId: 't-2', capability: inserted.handle }))
      .rejects.toMatchObject({ code: 'request.invalid' });
  });

  it('does not expose a public clearGoal or updateGoal method', () => {
    const { session } = makeSession();
    expect((session as unknown as { clearGoal?: unknown }).clearGoal).toBeUndefined();
    expect((session as unknown as { updateGoal?: unknown }).updateGoal).toBeUndefined();
  });

  it('keeps the goal metadata key reserved for lifecycle methods', async () => {
    const { session } = makeSession();

    await expect(
      session.updateMetadata({ goal: { status: 'complete' } }),
    ).rejects.toMatchObject({ code: 'goal.metadata_reserved' });
  });
});
