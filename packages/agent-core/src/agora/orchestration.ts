import type {
  DispatchSpawnMetadata,
  QueuedSubagentTask,
  QueuedSubagentRunResult,
  SessionSubagentHost,
} from '../session/subagent-host';
import type { AgoraPeerPacket, AgoraPeerRoutes } from './types';
import { normalizeAgoraPeerResponse, type AgoraPeerNormalization } from './response';

export const AGORA_PEER_TIMEOUT_MS = 5 * 60 * 1000;
export const AGORA_RECOVERY_MODEL_ALIAS = 'gpt5.6sol';

export interface AgoraRecoveryTask {
  readonly kind: 'recovery';
  readonly packet: AgoraPeerPacket;
}

export interface AgoraPeerTask {
  readonly peer: string;
  readonly packet: AgoraPeerPacket;
  readonly repairMissing?: readonly string[];
}

export interface AgoraPeerTaskResult {
  readonly peer: string;
  readonly result: QueuedSubagentRunResult<AgoraPeerTask>;
  readonly normalization: AgoraPeerNormalization;
  readonly initialRawResponse: string;
  readonly repairRawResponse?: string;
  readonly repairCount: 0 | 1;
}

function dispatchForPeer(
  peer: AgoraPeerTask['peer'],
  route: AgoraPeerRoutes[string],
  phase: 'initial' | 'repair',
): DispatchSpawnMetadata {
  return {
    rationale: 'Agora independent peer review with a frozen, byte-equivalent packet.',
    reviewReason: 'Agora cross-agent verification requires an independent, read-only peer review.',
    readOnly: true,
    discardChanges: true,
    workCard: {
      id: `agora-peer-${peer}-${phase}`,
      title: `Agora ${peer} peer review`,
      goal: 'Review the frozen Agora packet independently and return structured evidence, risks, and dissent.',
      acceptance: 'Return a contract-shaped peer review without editing files or taking side effects.',
      forbiddenScope: ['**/*'],
      routeOverride: {
        backend: route.backend,
        model: route.modelOverride,
      },
    },
  };
}

/**
 * Build one independent queued task per configured peer. It deliberately does
 * not execute them, so packet confirmation and route preflight remain explicit.
 */
export function buildAgoraPeerTasks(
  packet: AgoraPeerPacket,
  routes: AgoraPeerRoutes = packet.peerRoutes,
  parentToolCallId = `agora-${packet.runId}`,
): readonly QueuedSubagentTask<AgoraPeerTask>[] {
  const peers = Object.keys(routes);
  if (peers.length === 0) throw new Error('Agora requires at least one configured peer.');
  return peers.map((peer, index) => ({
    kind: 'spawn' as const,
    data: { peer, packet },
    profileName: routes[peer]!.profileName ?? 'agora-peer',
    parentToolCallId,
    prompt: renderPeerPrompt(peer, packet),
    description: `Agora ${routes[peer]!.displayName ?? peer} peer review`,
    swarmIndex: index + 1,
    swarmItem: peer,
    runInBackground: false,
    timeout: AGORA_PEER_TIMEOUT_MS,
    dispatch: dispatchForPeer(peer, routes[peer]!, 'initial'),
    enforceDispatch: true,
  }));
}

export function buildAgoraRecoveryTask(
  packet: AgoraPeerPacket,
  parentToolCallId = `agora-${packet.runId}`,
): QueuedSubagentTask<AgoraRecoveryTask> {
  if (packet.hostRoute !== 'coder-ex' || packet.routeUpgrade !== 'coder_to_coder-ex') {
    throw new Error('Agora recovery task requires the coder-ex route upgrade.');
  }
  return {
    kind: 'spawn',
    data: { kind: 'recovery', packet },
    profileName: 'coder-ex',
    modelAlias: AGORA_RECOVERY_MODEL_ALIAS,
    parentToolCallId,
    prompt: [
      'Analyze the rejected deliverable and produce an evidence-backed recovery diagnosis only.',
      'Do not modify files or execute consequential commands; any isolated delta will be discarded.',
      `Prior result/diff: ${packet.priorCoderResultOrDiff ?? ''}`,
      `Quality deficiencies: ${packet.qualityDeficiencies.join('; ')}`,
      `Failed or missing validation: ${packet.failedOrMissingValidation.join('; ')}`,
      `User dissatisfaction: ${packet.dissatisfactionOrUncertainty}`,
    ].join('\n'),
    description: 'Agora coder-ex recovery diagnosis',
    runInBackground: false,
    timeout: AGORA_PEER_TIMEOUT_MS,
    dispatch: {
      rationale: 'Agora recovery upgrades the host-side coder route to high-assurance coder-ex.',
      qualityDeficiencies: packet.qualityDeficiencies,
      readOnly: true,
      discardChanges: true,
      internalOnly: true,
      allowedTools: ['Read', 'Grep', 'Glob', 'ReadMediaFile'],
      scope: ['**/*'],
      workCard: {
        id: `agora-recovery-${packet.runId}`,
        title: 'Agora recovery diagnosis',
        goal: 'Independently diagnose the rejected result before peer synthesis.',
        acceptance: 'Return evidence-backed deficiencies and validation gaps without modifying the host workspace.',
      },
    },
    enforceDispatch: true,
  };
}

export async function runAgoraPeerReview(
  host: Pick<SessionSubagentHost, 'runQueued'>,
  packet: AgoraPeerPacket,
  routes: AgoraPeerRoutes = packet.peerRoutes,
  parentToolCallId = `agora-${packet.runId}`,
  signal?: AbortSignal,
): Promise<readonly AgoraPeerTaskResult[]> {
  const tasks = buildAgoraPeerTasks(packet, routes, parentToolCallId).map((task) => ({ ...task, signal }));
  const results = await host.runQueued(tasks);
  const initial = results.map((result) => {
    const raw = result.status === 'completed' ? result.result ?? '' : '';
    return {
      peer: result.task.data.peer,
      result,
      raw,
      normalization:
        result.status === 'completed'
          ? normalizeAgoraPeerResponse(result.task.data.peer, raw)
          : { status: 'unavailable' as const, rawResponse: raw, reason: result.error ?? result.status },
    };
  });
  const repairCandidates = initial.filter(
    (entry): entry is typeof entry & { normalization: Extract<AgoraPeerNormalization, { status: 'repair_required' }> } =>
      entry.normalization.status === 'repair_required',
  );
  const repairTasks = repairCandidates.map((entry, index): QueuedSubagentTask<AgoraPeerTask> => {
    const route = routes[entry.peer]!;
    return {
      kind: 'spawn',
      data: { peer: entry.peer, packet, repairMissing: entry.normalization.missing },
      profileName: route.profileName ?? 'agora-peer',
      parentToolCallId,
      prompt: renderRepairPrompt(entry.peer, packet, entry.normalization.missing, entry.raw),
      description: `Agora ${route.displayName ?? entry.peer} contract repair`,
      swarmIndex: index + 1,
      swarmItem: entry.peer,
      runInBackground: false,
      timeout: AGORA_PEER_TIMEOUT_MS,
      signal,
      dispatch: dispatchForPeer(entry.peer, route, 'repair'),
      enforceDispatch: true,
    };
  });
  const repaired = repairTasks.length === 0 ? [] : await host.runQueued(repairTasks);
  const repairsByPeer = new Map(repaired.map((result) => [result.task.data.peer, result]));

  return initial.map((entry): AgoraPeerTaskResult => {
    if (entry.normalization.status !== 'repair_required') {
      return {
        peer: entry.peer,
        result: entry.result,
        normalization: entry.normalization,
        initialRawResponse: entry.raw,
        repairCount: 0,
      };
    }
    const repair = repairsByPeer.get(entry.peer);
    const repairRaw = repair?.status === 'completed' ? repair.result ?? '' : '';
    const repairedNormalization = repair?.status === 'completed'
      ? normalizeAgoraPeerResponse(entry.peer, repairRaw)
      : { status: 'unavailable' as const, rawResponse: repairRaw, reason: repair?.error ?? repair?.status ?? 'repair missing' };
    return {
      peer: entry.peer,
      result: repair ?? entry.result,
      normalization: repairedNormalization.status === 'repair_required'
        ? { status: 'unavailable', rawResponse: repairRaw, reason: 'peer response remained malformed after one contract repair' }
        : repairedNormalization,
      initialRawResponse: entry.raw,
      repairRawResponse: repairRaw,
      repairCount: 1,
    };
  });
}

function renderPeerPrompt(peer: AgoraPeerTask['peer'], packet: AgoraPeerPacket): string {
  return [
    'You are an Agora independent peer. This is read-only analysis: do not edit files, run consequential commands, or contact external systems.',
    `Peer identity: ${peer}. Do not assume or reveal another peer response.`,
    'The following packet is frozen and byte-equivalent for every configured peer:',
    JSON.stringify(packet),
    'Return structured review: position, answer, evidence, assumptions, risks, confidence, and dissent. Mark inaccessible facts as unknown.',
  ].join('\n');
}

function renderRepairPrompt(
  peer: string,
  packet: AgoraPeerPacket,
  missing: readonly string[],
  malformedResponse: string,
): string {
  return [
    'This is the one allowed private Agora contract-repair request.',
    `Peer identity: ${peer}.`,
    `Your first response was missing or invalid only in these fields: ${missing.join(', ')}.`,
    'The original frozen packet follows:',
    JSON.stringify(packet),
    '--- BEGIN MALFORMED RESPONSE ---',
    malformedResponse,
    '--- END MALFORMED RESPONSE ---',
    'Return the complete structured review again: position, answer, evidence, assumptions, risks, confidence, and dissent.',
    'Repair only the contract shape. Do not add evidence or claims unsupported by your original review; mark unsupported facts unknown.',
    'Do not infer another peer or host position; none is included in this repair request.',
  ].join('\n');
}
