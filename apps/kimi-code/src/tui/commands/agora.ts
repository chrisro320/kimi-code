import { randomUUID } from 'node:crypto';

import type { AgoraLifecycleCapability } from '@moonshot-ai/kimi-code-sdk';

import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import type { AgoraStatus } from '../types';
import type { SlashCommandHost } from './dispatch';

const DEFAULT_AGORA_PEERS = [
  { id: 'claude', name: 'Claude', backend: 'claude-code', model: 'Opus 4.8', status: 'pending' },
  { id: 'grok', name: 'Grok', backend: 'kimi', model: 'kimicode-grok-4.5', status: 'pending' },
] as const;

/**
 * Agora lifecycle capabilities minted by `insertAgoraReview`, kept in process
 * memory only (never persisted or broadcast) and consumed by `/agora cancel`.
 * A capability is a bearer secret bound to this process; if the session is
 * resumed elsewhere it will not be present here and cancel degrades to a
 * local-only state clear (see the cancel branch below).
 */
const agoraCapabilities = new Map<string, AgoraLifecycleCapability>();

function invocation(runId: string): string {
  return [
    'The user explicitly invoked /agora.',
    `Use the stable Agora run id ${JSON.stringify(runId)} for the command state, Trellis inserted task, packet, Agora tool input, records, status, and handoff. Do not invent another run id.`,
    'Evaluate whether Agora is necessary using the four-signal necessity gate and the current conversation, task, and project state.',
    'If Agora is necessary, the host has already decoupled any active Trellis task and inserted the Agora review task for this run id; assemble and redact the review packet, then show the packet for explicit user confirmation before invoking the Agora tool.',
    'If Agora is unnecessary, refuse to invoke it, explain why, recommend the normal workflow instead, and run `/agora cancel` yourself so the Agora status and any inserted Trellis task clear.',
    'Keep kimi-code as the only user-facing moderator. Never replace Agora with Orca orchestration, AgentSwarm, manual panes, or ordinary subagents.',
  ].join(' ');
}

function formatStatus(agora: AgoraStatus): string {
  const peers = agora.peers.map((peer) => {
    const route = [peer.backend, peer.model].filter((part): part is string => part !== undefined).join('/');
    return `${peer.name}${route.length === 0 ? '' : `(${route})`}:${peer.status}`;
  }).join(', ');
  return [
    `Agora ${agora.phase}`,
    agora.runId === undefined ? undefined : `run=${agora.runId}`,
    agora.originTask === undefined ? undefined : `origin=${agora.originTask}`,
    agora.insertedTask === undefined ? undefined : `inserted=${agora.insertedTask}`,
    peers.length === 0 ? undefined : peers,
    agora.terminalState,
  ].filter((part): part is string => part !== undefined).join(' · ');
}

export async function handleAgoraCommand(host: SlashCommandHost, args: string): Promise<void> {
  const argument = args.trim();
  const action = argument.toLowerCase();

  if (action === 'status') {
    const agora = host.state.appState.agora;
    host.showStatus(agora === null || agora === undefined ? 'No Agora review is active.' : formatStatus(agora));
    return;
  }

  if (action === 'cancel') {
    const agora = host.state.appState.agora;
    if (agora === null || agora === undefined) {
      host.showStatus('No Agora review is active.');
      return;
    }
    if (host.session === undefined) {
      host.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    const capability = agora.runId === undefined ? undefined : agoraCapabilities.get(agora.runId);
    if (capability === undefined) {
      if (agora.runId !== undefined) {
        try {
          const durable = await host.session.getAgoraReview(agora.runId);
          if (durable !== undefined && durable.phase !== 'cancelled') {
            host.showError(
              'Agora review was not cancelled: its host capability is unavailable after resume. The durable review remains active; restart from the owning host or use an explicit recovery workflow.',
            );
            return;
          }
        } catch (error) {
          host.showError(`Agora review was not cancelled: durable state could not be verified (${error instanceof Error ? error.message : String(error)}).`);
          return;
        }
      }
      host.setAppState({ agora: null });
      host.showStatus('No durable Agora review is active; cleared stale local status.');
      return;
    }
    const cancelling: AgoraStatus = { ...agora, phase: 'cancelling', terminalState: 'cancelling' };
    host.setAppState({ agora: cancelling });
    try {
      await host.session.cancel();
      await host.session.cancelAgoraReview({
        runId: capability.runId,
        transitionId: randomUUID(),
        capability,
      });
      agoraCapabilities.delete(capability.runId);
      // The durable cancel transition emits `agora.lifecycle.updated` with a
      // terminal phase; the session event handler is the sole authority that
      // clears `AppState.agora` for a run with a real lifecycle record. Any
      // detached origin Trellis task has already been restored by the typed
      // transition itself, synchronously, before this resolves.
      host.showStatus('Agora review cancelled.');
    } catch (error) {
      host.setAppState({ agora });
      host.showError(`Failed to cancel Agora review: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  if (host.state.appState.agora !== null && host.state.appState.agora !== undefined) {
    host.showError('An Agora review is already active. Use /agora status or /agora cancel.');
    return;
  }
  if (host.state.appState.model.trim().length === 0 || host.session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  if (argument.length === 0) {
    host.showError('Usage: /agora <review focus> | /agora status | /agora cancel');
    return;
  }

  const runId = randomUUID();
  host.setAppState({
    agora: {
      runId,
      focus: argument,
      phase: 'decoupling',
      hostRoute: 'coder',
      peers: DEFAULT_AGORA_PEERS,
      startedAtMs: Date.now(),
      terminalState: 'preflight',
    },
  });

  try {
    const { handle } = await host.session.insertAgoraReview({ runId, transitionId: randomUUID() });
    agoraCapabilities.set(runId, handle);
  } catch (error) {
    host.setAppState({ agora: null });
    host.showError(`Failed to start Agora preflight: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  host.sendNormalUserInput(`${invocation(runId)}\n\nAgora focus supplied by the user:\n${argument}`);
}
