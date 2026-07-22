import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleAgoraCommand } from '#/tui/commands';
import { dispatchInput, type SlashCommandHost } from '#/tui/commands/dispatch';
import type { AgoraStatus } from '#/tui/types';

function makeHost(options: {
  model?: string;
  hasSession?: boolean;
  agora?: AgoraStatus | null;
  cancelError?: Error;
  insertAgoraReviewError?: Error;
  cancelAgoraReviewError?: Error;
  getAgoraReviewResult?: { runId: string; phase: string; insertedTask?: string };
  getAgoraReviewError?: Error;
} = {}) {
  const cancel = vi.fn(async () => {});
  const insertAgoraReview = options.insertAgoraReviewError === undefined
    ? vi.fn(async ({ runId }: { runId: string }) => ({
        handle: { sessionId: 'ses-1', runId, epoch: 'epoch-1', secret: 'secret-1' },
        snapshot: { runId, transitionId: 't-1', phase: 'packet_confirmation', sourceSessionId: 'ses-1', capabilityEpoch: 'epoch-1' },
      }))
    : vi.fn(async () => { throw options.insertAgoraReviewError ?? new Error('insert failed'); });
  const cancelAgoraReview = options.cancelAgoraReviewError === undefined
    ? vi.fn(async () => ({ runId: 'agora-run-1', phase: 'cancelled' as const, cancelled: true }))
    : vi.fn(async () => { throw options.cancelAgoraReviewError ?? new Error('cancel failed'); });
  const getAgoraReview = options.getAgoraReviewError === undefined
    ? vi.fn(async () => options.getAgoraReviewResult)
    : vi.fn(async () => { throw options.getAgoraReviewError ?? new Error('lookup failed'); });
  const retryAgoraHandoff = vi.fn(async () => {});
  const appState = {
    model: options.model ?? 'kimi-k2',
    workDir: '/work',
    streamingPhase: 'idle' as const,
    isCompacting: false,
    agora: options.agora ?? null,
  };
  const host = {
    state: { appState },
    harness: { getConfig: vi.fn(async () => ({})) },
    session: options.hasSession === false ? undefined : { cancel, insertAgoraReview, cancelAgoraReview, getAgoraReview },
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    sendNormalUserInput: vi.fn(),
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(appState, patch)),
    track: vi.fn(),
    retryAgoraHandoff,
  } as unknown as SlashCommandHost & {
    showError: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    sendNormalUserInput: ReturnType<typeof vi.fn>;
    setAppState: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
    retryAgoraHandoff: ReturnType<typeof vi.fn>;
    session: {
      cancel: ReturnType<typeof vi.fn>;
      insertAgoraReview: ReturnType<typeof vi.fn>;
      cancelAgoraReview: ReturnType<typeof vi.fn>;
      getAgoraReview: ReturnType<typeof vi.fn>;
    } | undefined;
  };
  return host;
}

const activeAgora: AgoraStatus = {
  runId: 'agora-run-1',
  focus: 'Rejected visual result',
  phase: 'peer_review',
  hostRoute: 'coder-ex',
  hostModel: 'GPT 5.6sol',
  originTask: '.trellis/tasks/origin',
  insertedTask: '.trellis/tasks/agora-review',
  startedAtMs: 100,
  peers: [
    { id: 'claude', name: 'Claude', backend: 'claude-code', model: 'Opus 4.8', status: 'reviewing' },
    { id: 'grok', name: 'Grok', backend: 'kimi', model: 'kimicode-grok-4.5', status: 'pending' },
  ],
};

describe('handleAgoraCommand', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts one stable Agora preflight, inserts the Trellis task, and shows orange state before tool dispatch', async () => {
    const host = makeHost();

    await handleAgoraCommand(host, 'review the rejected visual result');

    expect(host.setAppState).toHaveBeenCalledWith({
      agora: expect.objectContaining({
        runId: expect.any(String),
        focus: 'review the rejected visual result',
        phase: 'decoupling',
        terminalState: 'preflight',
        peers: [
          expect.objectContaining({ id: 'claude', backend: 'claude-code', model: 'Opus 4.8' }),
          expect.objectContaining({ id: 'grok', backend: 'kimi', model: 'kimicode-grok-4.5' }),
        ],
      }),
    });
    const state = host.setAppState.mock.calls[0]?.[0] as { agora: AgoraStatus };
    const runId = state.agora.runId!;

    expect(host.session?.insertAgoraReview).toHaveBeenCalledWith({
      runId,
      transitionId: expect.any(String),
    });

    const prompt = host.sendNormalUserInput.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('four-signal necessity gate');
    expect(prompt).toContain('explicit user confirmation before invoking the Agora tool');
    expect(prompt).toContain(`Use the stable Agora run id "${runId}"`);
    expect(prompt).not.toContain('Bash');
    expect(prompt).not.toContain('python3 .trellis/scripts/task.py agora-insert');
    expect(prompt).toContain('Never replace Agora with Orca orchestration');
  });

  it('clears Agora state and reports an error when the typed insert fails', async () => {
    const host = makeHost({ insertAgoraReviewError: new Error('adapter refused') });

    await handleAgoraCommand(host, 'review the rejected visual result');

    expect(host.setAppState).toHaveBeenLastCalledWith({ agora: null });
    expect(host.showError).toHaveBeenCalledWith('Failed to start Agora preflight: adapter refused');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('shows detailed status without starting another run', async () => {
    const host = makeHost({ agora: activeAgora });

    await handleAgoraCommand(host, 'status');

    expect(host.showStatus).toHaveBeenCalledWith(expect.stringMatching(
      /run=agora-run-1.*origin=.*Claude\(claude-code\/Opus 4\.8\):reviewing.*Grok\(kimi\/kimicode-grok-4\.5\):pending/,
    ));
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('dispatches a pending terminal resolution retry without sending model input', async () => {
    const host = makeHost({
      agora: { ...activeAgora, phase: 'resolution_pending', terminalState: 'terminal_flush_pending' },
    });

    await handleAgoraCommand(host, 'retry');

    expect(host.retryAgoraHandoff).toHaveBeenCalledOnce();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('blocks cancellation while terminal resolution retry is pending', async () => {
    const pendingAgora: AgoraStatus = {
      ...activeAgora,
      phase: 'resolution_pending',
      terminalState: 'terminal_flush_pending',
    };
    const host = makeHost({ agora: pendingAgora });

    await handleAgoraCommand(host, 'cancel');

    expect(host.session?.cancel).not.toHaveBeenCalled();
    expect(host.session?.cancelAgoraReview).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.state.appState.agora).toBe(pendingAgora);
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('/agora retry'));
  });

  it('cancels a run with a live capability through the typed session call', async () => {
    const host = makeHost();
    await handleAgoraCommand(host, 'review the rejected visual result');
    const state = host.setAppState.mock.calls[0]?.[0] as { agora: AgoraStatus };
    const runId = state.agora.runId!;

    await handleAgoraCommand(host, 'cancel');

    expect(host.session?.cancel).toHaveBeenCalledOnce();
    expect(host.session?.cancelAgoraReview).toHaveBeenCalledWith({
      runId,
      transitionId: expect.any(String),
      capability: expect.objectContaining({ runId }),
    });
    expect(host.sendNormalUserInput).not.toHaveBeenCalledWith(expect.stringContaining('Bash'));
    expect(host.showStatus).toHaveBeenLastCalledWith('Agora review cancelled.');
  });

  it('clears local state and gives Trellis recovery after resume when capability is unavailable', async () => {
    const host = makeHost({
      agora: activeAgora,
      getAgoraReviewResult: {
        runId: activeAgora.runId!,
        phase: 'peer_review',
        insertedTask: activeAgora.insertedTask,
      },
    });

    await handleAgoraCommand(host, 'cancel');

    expect(host.session?.getAgoraReview).toHaveBeenCalledWith(activeAgora.runId);
    expect(host.session?.cancel).not.toHaveBeenCalled();
    expect(host.session?.cancelAgoraReview).not.toHaveBeenCalled();
    expect(host.setAppState).toHaveBeenLastCalledWith({ agora: null });
    const error = host.showError.mock.calls[0]?.[0] as string;
    expect(error).toContain('host capability is unavailable');
    expect(error).toContain('durable review was not cancelled');
    expect(error).toContain(`Known run id ${activeAgora.runId}`);
    expect(error).toContain(`Known inserted task ${activeAgora.insertedTask}`);
    expect(error).toContain(`python3 ./.trellis/scripts/task.py agora-cancel '${activeAgora.insertedTask}'`);
  });

  it('uses authoritative durable task provenance and shell-quotes it for recovery', async () => {
    const staleTask = '.trellis/tasks/stale-local-review';
    const durableTask = ".trellis/tasks/review's";
    const host = makeHost({
      agora: { ...activeAgora, insertedTask: staleTask },
      getAgoraReviewResult: {
        runId: activeAgora.runId!,
        phase: 'peer_review',
        insertedTask: durableTask,
      },
    });

    await handleAgoraCommand(host, 'cancel');

    const error = host.showError.mock.calls[0]?.[0] as string;
    expect(error).toContain(`Known inserted task ${durableTask}`);
    expect(error).toContain("python3 ./.trellis/scripts/task.py agora-cancel '.trellis/tasks/review'\\''s'");
    expect(error).not.toContain(staleTask);
  });

  it('clears local state when the session is unavailable without claiming a durable cancel', async () => {
    const host = makeHost({ agora: activeAgora, hasSession: false });

    await handleAgoraCommand(host, 'cancel');

    expect(host.setAppState).toHaveBeenLastCalledWith({ agora: null });
    const error = host.showError.mock.calls[0]?.[0] as string;
    expect(error).toContain('session unavailable');
    expect(error).toContain('durable review was not cancelled');
    expect(error).toContain(`python3 ./.trellis/scripts/task.py agora-cancel '${activeAgora.insertedTask}'`);
  });

  it.each(['cancelled', 'resolved_to_origin', 'resolved_to_successor'] as const)(
    'clears only stale local state when durable review is already terminal (%s)',
    async (phase) => {
      const host = makeHost({
        agora: activeAgora,
        getAgoraReviewResult: { runId: activeAgora.runId!, phase },
      });

      await handleAgoraCommand(host, 'cancel');

      expect(host.setAppState).toHaveBeenLastCalledWith({ agora: null });
      expect(host.showStatus).toHaveBeenLastCalledWith(
        `Durable Agora review is already terminal (${phase}); cleared stale local status.`,
      );
      expect(host.showError).not.toHaveBeenCalled();
    },
  );

  it('clears local state and preserves recovery details when durable lookup fails', async () => {
    const host = makeHost({ agora: activeAgora, getAgoraReviewError: new Error('lookup denied') });

    await handleAgoraCommand(host, 'cancel');

    expect(host.setAppState).toHaveBeenLastCalledWith({ agora: null });
    const error = host.showError.mock.calls[0]?.[0] as string;
    expect(error).toContain('durable state verification failed (lookup denied)');
    expect(error).toContain('durable review was not cancelled');
    expect(error).toContain(`Known run id ${activeAgora.runId}`);
    expect(error).toContain(`python3 ./.trellis/scripts/task.py agora-cancel '${activeAgora.insertedTask}'`);
  });

  it('clears only stale local state when durable lookup proves no review exists', async () => {
    const host = makeHost({ agora: activeAgora });

    await handleAgoraCommand(host, 'cancel');

    expect(host.session?.getAgoraReview).toHaveBeenCalledWith(activeAgora.runId);
    expect(host.session?.cancel).not.toHaveBeenCalled();
    expect(host.session?.cancelAgoraReview).not.toHaveBeenCalled();
    expect(host.setAppState).toHaveBeenLastCalledWith({ agora: null });
    expect(host.showStatus).toHaveBeenLastCalledWith('No durable Agora review is active; cleared stale local status.');
  });

  it('clears local state on typed cancel failure', async () => {
    const host = makeHost({ cancelAgoraReviewError: new Error('cancel rejected') });
    await handleAgoraCommand(host, 'review the rejected visual result');

    await handleAgoraCommand(host, 'cancel');

    expect(host.setAppState).toHaveBeenLastCalledWith({ agora: null });
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining(
      'Agora review could not be cancelled cleanly (cleared local status): cancel rejected',
    ));
  });

  it('rejects duplicate runs, empty focus, or missing model/session', async () => {
    const active = makeHost({ agora: activeAgora });
    await handleAgoraCommand(active, 'another review');
    expect(active.showError).toHaveBeenCalledWith('An Agora review is already active. Use /agora status or /agora cancel.');

    const empty = makeHost();
    await handleAgoraCommand(empty, '');
    expect(empty.showError).toHaveBeenCalledWith('Usage: /agora <review focus> | /agora status | /agora retry | /agora cancel | /agora roster');

    const noModel = makeHost({ model: '' });
    await handleAgoraCommand(noModel, 'review');
    expect(noModel.showError).toHaveBeenCalledOnce();

    const noSession = makeHost({ hasSession: false });
    await handleAgoraCommand(noSession, 'review');
    expect(noSession.showError).toHaveBeenCalledOnce();
  });

  it('dispatches /agora through the built-in command registry', async () => {
    const host = makeHost();

    dispatchInput(host, '/agora inspect the current task');
    await vi.waitFor(() => expect(host.sendNormalUserInput).toHaveBeenCalledOnce());

    expect(host.track).toHaveBeenCalledWith('input_command', { command: 'agora' });
    expect(host.sendNormalUserInput.mock.calls[0]?.[0]).toContain('inspect the current task');
  });
});
