import type { AgoraPhase, AgoraRunState } from './types';

const TRANSITIONS: Readonly<Record<AgoraPhase, readonly AgoraPhase[]>> = {
  decoupling: ['packet_confirmation', 'cancelled'],
  packet_confirmation: ['peer_review', 'cancelled'],
  peer_review: ['synthesis', 'cancelled'],
  synthesis: ['trellis_convergence', 'unresolved', 'cancelled'],
  trellis_convergence: ['task_materialization', 'unresolved', 'cancelled'],
  task_materialization: [
    'materialization_executing',
    'resolved_to_origin',
    'resolved_to_successor',
    'unresolved',
    'cancelled',
  ],
  materialization_executing: ['fresh_session_pending', 'unresolved', 'cancelled'],
  fresh_session_pending: ['resolved_to_origin', 'resolved_to_successor', 'unresolved'],
  resolved_to_origin: [],
  resolved_to_successor: [],
  cancelled: [],
  unresolved: ['trellis_convergence', 'cancelled'],
};

export function createAgoraRunState(input: {
  readonly runId: string;
  readonly mode: AgoraRunState['mode'];
  readonly peerIds?: readonly string[];
  readonly forcedByUser?: boolean;
}): AgoraRunState {
  const peerIds = input.peerIds ?? ['claude', 'grok'];
  return {
    runId: input.runId,
    mode: input.mode,
    phase: 'decoupling',
    forcedByUser: input.forcedByUser === true,
    contractRepairs: Object.fromEntries(peerIds.map((peerId) => [peerId, 0])),
    temporaryOverrides: Object.fromEntries(peerIds.map((peerId) => [peerId, 'active'])),
    claudeModelOverride: peerIds.includes('claude') ? 'active' : undefined,
  };
}

export function transitionAgoraRun(state: AgoraRunState, next: AgoraPhase): AgoraRunState {
  if (!TRANSITIONS[state.phase]!.includes(next)) {
    throw new Error(`Invalid Agora transition from "${state.phase}" to "${next}".`);
  }
  const terminal = next === 'resolved_to_origin' || next === 'resolved_to_successor' || next === 'cancelled';
  return {
    ...state,
    phase: next,
    temporaryOverrides: terminal
      ? Object.fromEntries(Object.keys(state.temporaryOverrides).map((peerId) => [peerId, 'disposed']))
      : state.temporaryOverrides,
    claudeModelOverride: terminal ? 'disposed' : state.claudeModelOverride,
  };
}

export function recordAgoraContractRepair(
  state: AgoraRunState,
  peer: string,
): AgoraRunState {
  if ((state.contractRepairs[peer] ?? 0) >= 1) {
    throw new Error(`Agora peer "${peer}" already used its one contract-repair request.`);
  }
  return {
    ...state,
    contractRepairs: { ...state.contractRepairs, [peer]: (state.contractRepairs[peer] ?? 0) + 1 },
  };
}
