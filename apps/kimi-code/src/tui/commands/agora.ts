import { randomUUID } from 'node:crypto';

import type { AgoraLifecycleCapability, KimiConfig } from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import {
  AgoraRosterManagerComponent,
  type AgoraPeerEntry,
} from '../components/dialogs/agora-roster-manager';
import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import type { AgoraPeerStatus, AgoraStatus } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
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
    host.showError('Usage: /agora <review focus> | /agora status | /agora cancel | /agora roster');
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
  let config: KimiConfig;
  try {
    config = await host.harness.getConfig({ reload: true });
  } catch (error) {
    host.showError(`Failed to load Agora roster: ${formatErrorMessage(error)}`);
    return;
  }
  showRosterManager(host, config);
}

function showRosterManager(host: SlashCommandHost, config: KimiConfig): void {
  const roster = effectiveRoster(config);
  host.mountEditorReplacement(
    new AgoraRosterManagerComponent({
      peers: roster.peers,
      configured: roster.configured,
      onAdd: () => showRosterRoutePicker(host, config),
      onEdit: (index) => {
        host.restoreEditor();
        if (!roster.configured) {
          host.showError('Built-in fallback peer; add your own peer to configure the roster.');
          return;
        }
        const peer = roster.peers[index];
        if (peer !== undefined) showRosterMemberActions(host, config, peer.id);
      },
      onRemove: (index) => {
        const peer = roster.peers[index];
        if (roster.configured && peer !== undefined) void removeRosterPeer(host, peer.id);
      },
      onClose: () => host.restoreEditor(),
    }),
  );
}

function showRosterRoutePicker(host: SlashCommandHost, config: KimiConfig): void {
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
        host.restoreEditor();
        const choice = parseRosterChoice(value);
        if (choice.kind === 'model') {
          void saveRosterPeer(host, {
            id: choice.alias,
            backend: 'kimi',
            modelOverride: choice.alias,
            displayName: config.models?.[choice.alias]?.displayName,
          });
          return;
        }
        const backend = config.subagent?.backends?.[choice.name];
        if (backend === undefined) {
          host.showError(`Subagent backend "${choice.name}" is no longer configured.`);
          return;
        }
        if ((backend.args ?? []).some((arg) => arg.includes('{model}'))) {
          showRosterExternalModelPicker(host, config, choice.name);
        } else {
          void saveRosterPeer(host, { id: choice.name, backend: choice.name });
        }
      },
      onCancel: () => host.restoreEditor(),
    }),
  );
}

function showRosterExternalModelPicker(host: SlashCommandHost, config: KimiConfig, backendName: string): void {
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
        host.restoreEditor();
        void saveRosterPeer(host, { id: model, backend: backendName, modelOverride: model });
      },
      onCancel: () => host.restoreEditor(),
    }),
  );
}

function showRosterMemberActions(host: SlashCommandHost, config: KimiConfig, peerId: string): void {
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Manage Agora peer: ${peerId}`,
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options: [
        { value: 'replace', label: 'Replace with another model or CLI' },
        { value: 'remove', label: 'Remove peer', tone: 'danger' },
      ],
      onSelect: (action) => {
        host.restoreEditor();
        if (action === 'replace') {
          void replaceRosterPeer(host, config, peerId);
        } else {
          void removeRosterPeer(host, peerId);
        }
      },
      onCancel: () => host.restoreEditor(),
    }),
  );
}

async function saveRosterPeer(
  host: SlashCommandHost,
  peer: { readonly id: string; readonly backend: string; readonly modelOverride?: string; readonly displayName?: string },
): Promise<void> {
  try {
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
    const session = host.session;
    if (session !== undefined) {
      await session.reloadSession();
      await host.reloadCurrentSessionView(session, 'Agora roster saved and applied.');
    }
    const refreshed = await host.harness.getConfig({ reload: true });
    host.refreshSlashCommandAutocomplete();
    host.showStatus(`Agora peer "${peer.id}" saved to config.toml.`, 'success');
    showRosterManager(host, refreshed);
  } catch (error) {
    host.showError(`Failed to save Agora peer: ${formatErrorMessage(error)}`);
  }
}

async function replaceRosterPeer(host: SlashCommandHost, _config: KimiConfig, peerId: string): Promise<void> {
  try {
    const refreshed = await host.harness.removeAgoraPeer(peerId);
    showRosterRoutePicker(host, refreshed);
  } catch (error) {
    host.showError(`Failed to remove peer "${peerId}": ${formatErrorMessage(error)}`);
  }
}

async function removeRosterPeer(host: SlashCommandHost, peerId: string): Promise<void> {
  try {
    await host.harness.removeAgoraPeer(peerId);
    const session = host.session;
    if (session !== undefined) {
      await session.reloadSession();
      await host.reloadCurrentSessionView(session, 'Agora roster saved and applied.');
    }
    const refreshed = await host.harness.getConfig({ reload: true });
    host.refreshSlashCommandAutocomplete();
    host.showStatus(`Agora peer "${peerId}" removed.`, 'success');
    showRosterManager(host, refreshed);
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
