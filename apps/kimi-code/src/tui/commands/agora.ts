import { randomUUID } from 'node:crypto';

import { TERMINAL_PHASES, type AgoraLifecycleCapability, type KimiConfig } from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import {
  AgoraRosterManagerComponent,
  type AgoraPeerEntry,
} from '../components/dialogs/agora-roster-manager';
import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import type { AgoraPeerStatus, AgoraStatus } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import { formatAgoraRecoveryInstructions } from '../utils/agora-recovery';
import type { SlashCommandHost } from './dispatch';

const DEFAULT_AGORA_PEERS = [
  { id: 'claude', name: 'Claude', backend: 'claude-code', model: 'Opus 4.8', status: 'pending' },
  { id: 'grok', name: 'Grok', backend: 'kimi', model: 'kimicode-grok-4.5', status: 'pending' },
] as const;

/**
 * Agora lifecycle capabilities minted by `insertAgoraReview`, kept in process
 * memory only (never persisted or broadcast) and consumed by cancellation or
 * the source-session terminal handoff transition. A capability is a bearer
 * secret bound to this process; a resumed process must recover without it.
 */
const agoraCapabilities = new Map<string, AgoraLifecycleCapability>();

export function getAgoraLifecycleCapability(runId: string): AgoraLifecycleCapability | undefined {
  return agoraCapabilities.get(runId);
}

export function releaseAgoraLifecycleCapability(runId: string): void {
  agoraCapabilities.delete(runId);
}

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

function isAgoraTerminalResolutionPending(host: SlashCommandHost): boolean {
  return (
    host.isAgoraSessionTransitionPending?.() ??
    host.state.appState.agora?.phase === 'resolution_pending'
  );
}

interface AgoraMutationContext {
  readonly sourceSession: SlashCommandHost['session'];
  readonly transitionGeneration?: number;
}

function captureAgoraMutationContext(host: SlashCommandHost): AgoraMutationContext {
  return {
    sourceSession: host.session,
    transitionGeneration: host.getSessionTransitionGeneration?.(),
  };
}

function blockAgoraMutationDuringTerminalResolution(
  host: SlashCommandHost,
  context?: AgoraMutationContext,
): boolean {
  if (isAgoraTerminalResolutionPending(host)) {
    host.showError(
      'Agora handoff terminal resolution is pending. Run /agora retry before starting or changing another Agora review.',
    );
    return true;
  }
  if (
    context !== undefined &&
    (host.session !== context.sourceSession ||
      (context.transitionGeneration !== undefined &&
        host.getSessionTransitionGeneration?.() !== context.transitionGeneration))
  ) {
    host.showError('Agora change cancelled because a handoff changed the active session.');
    return true;
  }
  return false;
}

export async function handleAgoraCommand(host: SlashCommandHost, args: string): Promise<void> {
  const argument = args.trim();
  const action = argument.toLowerCase();

  if (action === 'status') {
    const agora = host.state.appState.agora;
    host.showStatus(
      agora === null || agora === undefined
        ? isAgoraTerminalResolutionPending(host)
          ? 'Agora handoff terminal resolution is pending. Run /agora retry.'
          : 'No Agora review is active.'
        : formatStatus(agora),
    );
    return;
  }

  if (action === 'retry') {
    await host.retryAgoraHandoff();
    return;
  }
  if (blockAgoraMutationDuringTerminalResolution(host)) return;

  if (action === 'cancel') {
    const agora = host.state.appState.agora;
    if (agora === null || agora === undefined) {
      host.showStatus('No Agora review is active.');
      return;
    }
    if (agora.phase === 'resolution_pending') {
      host.showError('Agora handoff terminal resolution is pending. Run /agora retry to retry the durable flush.');
      return;
    }
    if (host.session === undefined) {
      host.setAppState({ agora: null });
      host.showError(`Cannot cancel Agora review: session unavailable; the durable review was not cancelled.${formatAgoraRecoveryInstructions(agora)}`);
      return;
    }
    const capability = agora.runId === undefined ? undefined : getAgoraLifecycleCapability(agora.runId);
    if (capability === undefined) {
      if (agora.runId !== undefined) {
        try {
          const durable = await host.session.getAgoraReview(agora.runId);
          if (durable !== undefined) {
            host.setAppState({ agora: null });
            if (TERMINAL_PHASES.has(durable.phase)) {
              host.showStatus(`Durable Agora review is already terminal (${durable.phase}); cleared stale local status.`);
              return;
            }
            host.showError(`Cleared local Agora status; this process cannot cancel the durable review because host capability is unavailable. The durable review was not cancelled.${formatAgoraRecoveryInstructions(durable)}`);
            return;
          }
        } catch (error) {
          host.setAppState({ agora: null });
          host.showError(`Cleared local Agora status; durable state verification failed (${error instanceof Error ? error.message : String(error)}); the durable review was not cancelled.${formatAgoraRecoveryInstructions(agora)}`);
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
      releaseAgoraLifecycleCapability(capability.runId);
      // The durable cancel transition emits `agora.lifecycle.updated` with a
      // terminal phase; the session event handler is the sole authority that
      // clears `AppState.agora` for a run with a real lifecycle record. Any
      // detached origin Trellis task has already been restored by the typed
      // transition itself, synchronously, before this resolves.
      host.showStatus('Agora review cancelled.');
    } catch (error) {
      // The bearer gate or lifecycle transition failed. The durable record may
      // still be active, but the in-memory preflight must never stay stuck —
      // clear it so the UI recovers, and tell the user what may still need an
      // out-of-band cleanup.
      host.setAppState({ agora: null });
      host.showError(`Agora review could not be cancelled cleanly (cleared local status): ${error instanceof Error ? error.message : String(error)}.${formatAgoraRecoveryInstructions(agora)}`);
    }
    return;
  }

  if (action === 'roster') {
    void handleAgoraRoster(host);
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
    host.showError('Usage: /agora <review focus> | /agora status | /agora retry | /agora cancel | /agora roster');
    return;
  }

  // Preflight display mirrors the effective default roster: config.toml
  // `agora.peers` when configured, the built-in pair otherwise. The real
  // dispatch roster is resolved by the Agora tool itself at call time.
  const preflightConfig = await host.harness.getConfig({}).catch(() => undefined);
  const runId = randomUUID();
  host.setAppState({
    agora: {
      runId,
      focus: argument,
      phase: 'decoupling',
      hostRoute: 'coder',
      peers: preflightPeers(preflightConfig),
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

function preflightPeers(config: KimiConfig | undefined): readonly AgoraPeerStatus[] {
  const configured = config?.agora?.peers ?? {};
  const ids = Object.keys(configured);
  if (ids.length === 0) return DEFAULT_AGORA_PEERS;
  return ids.map((id) => ({
    id,
    name: configured[id]?.displayName ?? id,
    backend: configured[id]?.backend,
    model: configured[id]?.modelOverride,
    status: 'pending',
  }));
}

// ---------------------------------------------------------------------------
// /agora roster — manage the config.toml `agora.peers` default peer roster
// ---------------------------------------------------------------------------

function effectiveRoster(config: KimiConfig): { readonly peers: readonly AgoraPeerEntry[]; readonly configured: boolean } {
  const configured = config.agora?.peers ?? {};
  const ids = Object.keys(configured);
  if (ids.length > 0) {
    return {
      configured: true,
      peers: ids.map((id) => ({
        id,
        backend: configured[id]?.backend ?? 'kimi',
        model: configured[id]?.modelOverride,
        displayName: configured[id]?.displayName,
      })),
    };
  }
  return {
    configured: false,
    peers: DEFAULT_AGORA_PEERS.map((peer) => ({
      id: peer.id,
      backend: peer.backend,
      model: peer.model,
      displayName: peer.name,
    })),
  };
}

async function handleAgoraRoster(host: SlashCommandHost): Promise<void> {
  if (blockAgoraMutationDuringTerminalResolution(host)) return;
  const context = captureAgoraMutationContext(host);
  let config: KimiConfig;
  try {
    config = await host.harness.getConfig({ reload: true });
  } catch (error) {
    host.showError(`Failed to load Agora roster: ${formatErrorMessage(error)}`);
    return;
  }
  if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
  showRosterManager(host, config, context);
}

function showRosterManager(
  host: SlashCommandHost,
  config: KimiConfig,
  context: AgoraMutationContext,
): void {
  const roster = effectiveRoster(config);
  host.mountEditorReplacement(
    new AgoraRosterManagerComponent({
      peers: roster.peers,
      configured: roster.configured,
      onAdd: () => {
        if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
        showRosterRoutePicker(host, config, context);
      },
      onEdit: (index) => {
        if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
        host.restoreEditor();
        if (!roster.configured) {
          host.showError('Built-in fallback peer; add your own peer to configure the roster.');
          return;
        }
        const peer = roster.peers[index];
        if (peer !== undefined) showRosterMemberActions(host, config, peer.id, context);
      },
      onRemove: (index) => {
        if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
        const peer = roster.peers[index];
        if (roster.configured && peer !== undefined) {
          void removeRosterPeer(host, peer.id, context);
        }
      },
      onClose: () => host.restoreEditor(),
    }),
  );
}

function showRosterRoutePicker(
  host: SlashCommandHost,
  config: KimiConfig,
  context: AgoraMutationContext,
  replacePeerId?: string,
): void {
  const options: ChoiceOption[] = [
    ...Object.keys(config.models ?? {}).toSorted().map((alias) => ({
      value: `model:${alias}`,
      label: `Model: ${alias}`,
      description: config.models?.[alias]?.displayName ?? 'Run on the internal Kimi subagent runtime',
    })),
    ...Object.entries(config.subagent?.backends ?? {}).toSorted(([a], [b]) => a.localeCompare(b)).map(([name, backend]) => ({
      value: `backend:${name}`,
      label: `CLI: ${name}`,
      description: `${backend.command} ${backend.args?.join(' ') ?? ''}`.trim(),
      tone: 'danger' as const,
      descriptionTone: 'warning' as const,
    })),
  ];
  if (options.length === 0) {
    host.showError('No configured models or subagent backends are available.');
    return;
  }
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Add Agora peer',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      notice: options.some((option) => option.tone === 'danger')
        ? 'External CLI backends run outside Kimi Code. Verify permissions and workspace trust before enabling one.'
        : undefined,
      noticeTone: 'warning',
      options,
      onSelect: (value) => {
        if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
        host.restoreEditor();
        const choice = parseRosterChoice(value);
        if (choice.kind === 'model') {
          void saveRosterPeer(
            host,
            {
              id: choice.alias,
              backend: 'kimi',
              modelOverride: choice.alias,
              displayName: config.models?.[choice.alias]?.displayName,
            },
            context,
            replacePeerId,
          );
          return;
        }
        const backend = config.subagent?.backends?.[choice.name];
        if (backend === undefined) {
          host.showError(`Subagent backend "${choice.name}" is no longer configured.`);
          return;
        }
        if ((backend.args ?? []).some((arg) => arg.includes('{model}'))) {
          showRosterExternalModelPicker(host, config, choice.name, context, replacePeerId);
        } else {
          void saveRosterPeer(host, { id: choice.name, backend: choice.name }, context, replacePeerId);
        }
      },
      onCancel: () => host.restoreEditor(),
    }),
  );
}

function showRosterExternalModelPicker(
  host: SlashCommandHost,
  config: KimiConfig,
  backendName: string,
  context: AgoraMutationContext,
  replacePeerId?: string,
): void {
  const aliases = Object.keys(config.models ?? {}).toSorted();
  if (aliases.length === 0) {
    host.showError(`Backend "${backendName}" requires {model}, but no model aliases are configured.`);
    return;
  }
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Select model for peer CLI: ${backendName}`,
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options: aliases.map((alias) => ({
        value: alias,
        label: alias,
        description: config.models?.[alias]?.displayName,
      })),
      onSelect: (model) => {
        if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
        host.restoreEditor();
        void saveRosterPeer(
          host,
          { id: model, backend: backendName, modelOverride: model },
          context,
          replacePeerId,
        );
      },
      onCancel: () => host.restoreEditor(),
    }),
  );
}

function showRosterMemberActions(
  host: SlashCommandHost,
  config: KimiConfig,
  peerId: string,
  context: AgoraMutationContext,
): void {
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Manage Agora peer: ${peerId}`,
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options: [
        { value: 'replace', label: 'Replace with another model or CLI' },
        { value: 'remove', label: 'Remove peer', tone: 'danger' },
      ],
      onSelect: (action) => {
        if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
        host.restoreEditor();
        if (action === 'replace') {
          void replaceRosterPeer(host, config, peerId, context);
        } else {
          void removeRosterPeer(host, peerId, context);
        }
      },
      onCancel: () => host.restoreEditor(),
    }),
  );
}

async function saveRosterPeer(
  host: SlashCommandHost,
  peer: { readonly id: string; readonly backend: string; readonly modelOverride?: string; readonly displayName?: string },
  context: AgoraMutationContext,
  replacePeerId?: string,
): Promise<void> {
  if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
  try {
    // Add the new peer BEFORE removing the replaced one: cancelling the
    // picker mid-flow must never leave the roster without the old peer, and
    // a failed save keeps the old peer intact.
    await host.harness.setConfig({
      agora: {
        peers: {
          [peer.id]: {
            backend: peer.backend,
            modelOverride: peer.modelOverride,
            displayName: peer.displayName,
          },
        },
      },
    });
    if (replacePeerId !== undefined && replacePeerId !== peer.id) {
      await host.harness.removeAgoraPeer(replacePeerId);
    }
    if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
    const session = host.session;
    if (session !== undefined) {
      await session.reloadSession();
      if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
      await host.reloadCurrentSessionView(session, 'Agora roster saved and applied.');
      if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
    }
    const refreshed = await host.harness.getConfig({ reload: true });
    if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
    host.refreshSlashCommandAutocomplete();
    host.showStatus(`Agora peer "${peer.id}" saved to config.toml.`, 'success');
    showRosterManager(host, refreshed, context);
  } catch (error) {
    host.showError(`Failed to save Agora peer: ${formatErrorMessage(error)}`);
  }
}

async function replaceRosterPeer(
  host: SlashCommandHost,
  config: KimiConfig,
  peerId: string,
  context: AgoraMutationContext,
): Promise<void> {
  if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
  // Pick the replacement first; the old peer is only removed once the new
  // one has been saved (see saveRosterPeer), so Esc cancels cleanly.
  showRosterRoutePicker(host, config, context, peerId);
}

async function removeRosterPeer(
  host: SlashCommandHost,
  peerId: string,
  context: AgoraMutationContext,
): Promise<void> {
  if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
  try {
    await host.harness.removeAgoraPeer(peerId);
    if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
    const session = host.session;
    if (session !== undefined) {
      await session.reloadSession();
      if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
      await host.reloadCurrentSessionView(session, 'Agora roster saved and applied.');
      if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
    }
    const refreshed = await host.harness.getConfig({ reload: true });
    if (blockAgoraMutationDuringTerminalResolution(host, context)) return;
    host.refreshSlashCommandAutocomplete();
    host.showStatus(`Agora peer "${peerId}" removed.`, 'success');
    showRosterManager(host, refreshed, context);
  } catch (error) {
    host.showError(`Failed to remove Agora peer: ${formatErrorMessage(error)}`);
  }
}

function parseRosterChoice(value: string): { kind: 'model'; alias: string } | { kind: 'backend'; name: string } {
  const separator = value.indexOf(':');
  if (separator <= 0) return { kind: 'model', alias: value };
  const kind = value.slice(0, separator);
  const name = value.slice(separator + 1);
  return kind === 'backend'
    ? { kind: 'backend', name }
    : { kind: 'model', alias: name };
}
