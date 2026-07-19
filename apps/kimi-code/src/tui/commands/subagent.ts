import type { KimiConfig } from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const DEFAULT_PROFILES = ['coder', 'coder-ex', 'debugger', 'explore', 'frontend-artist', 'reviewer'] as const;
const INTERNAL_BACKEND = 'kimi';

type RouteChoice =
  | { readonly kind: 'model'; readonly alias: string }
  | { readonly kind: 'backend'; readonly name: string };

type ProfileName = string;

export async function handleSubagentCommand(host: SlashCommandHost, args: string): Promise<void> {
  const requestedProfile = args.trim();
  if (requestedProfile.includes(' ')) {
    host.showError('Usage: /subagent [coder|coder-ex|debugger|explore|frontend-artist|reviewer]');
    return;
  }

  let config: KimiConfig;
  try {
    config = await host.harness.getConfig({ reload: true });
  } catch (error) {
    host.showError(`Failed to load subagent configuration: ${formatErrorMessage(error)}`);
    return;
  }

  const profiles = availableProfiles(config);
  if (requestedProfile.length > 0 && !profiles.includes(requestedProfile)) {
    host.showError(`Unknown subagent profile "${requestedProfile}".`);
    return;
  }

  if (requestedProfile.length > 0) {
    showRoutePicker(host, config, requestedProfile);
    return;
  }

  showProfilePicker(host, config, profiles);
}

function availableProfiles(config: KimiConfig): ProfileName[] {
  const configured = Object.keys(config.subagent?.routing ?? {});
  return [...new Set([...DEFAULT_PROFILES, ...configured])];
}

function showProfilePicker(
  host: SlashCommandHost,
  config: KimiConfig,
  profiles: readonly ProfileName[],
): void {
  const options: ChoiceOption[] = profiles.map((profile) => ({
    value: profile,
    label: profile,
    description: profileDescription(config, profile),
  }));

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Select subagent type',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options,
      onSelect: (profile) => {
        host.restoreEditor();
        showRoutePicker(host, config, profile);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function profileDescription(config: KimiConfig, profile: ProfileName): string {
  const route = config.subagent?.routing?.[profile];
  if (route === undefined) return 'Uses the default internal subagent route';
  const target = route.backend === undefined || route.backend === INTERNAL_BACKEND
    ? `model ${route.model ?? '(parent model)'}`
    : `external backend ${route.backend}`;
  return `Current: ${target}`;
}

function showRoutePicker(host: SlashCommandHost, config: KimiConfig, profile: ProfileName): void {
  const current = config.subagent?.routing?.[profile];
  const options: ChoiceOption[] = [
    ...Object.keys(config.models ?? {}).toSorted().map((alias) => ({
      value: `model:${alias}`,
      label: `Model: ${alias}`,
      description: config.models?.[alias]?.displayName ?? 'Use Kimi Code internal subagent runtime',
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

  const currentValue = current === undefined || current.backend === undefined || current.backend === INTERNAL_BACKEND
    ? current?.model === undefined ? undefined : `model:${current.model}`
    : `backend:${current.backend}`;

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Configure subagent: ${profile}`,
      hint: '↑↓ navigate · Enter select · Esc cancel',
      notice: options.some((option) => option.tone === 'danger')
        ? 'External CLI backends run outside Kimi Code. Verify permissions and workspace trust before enabling one.'
        : undefined,
      noticeTone: 'warning',
      options,
      currentValue,
      onSelect: (value) => {
        host.restoreEditor();
        const choice = parseRouteChoice(value);
        if (choice.kind === 'model') {
          void saveRoute(host, config, profile, { backend: INTERNAL_BACKEND, model: choice.alias });
          return;
        }
        const backend = config.subagent?.backends?.[choice.name];
        if (backend === undefined) {
          host.showError(`Subagent backend "${choice.name}" is no longer configured.`);
          return;
        }
        if ((backend.args ?? []).some((arg) => arg.includes('{model}'))) {
          showExternalModelPicker(host, config, profile, choice.name);
          return;
        }
        void saveRoute(host, config, profile, { backend: choice.name });
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function showExternalModelPicker(
  host: SlashCommandHost,
  config: KimiConfig,
  profile: ProfileName,
  backendName: string,
): void {
  const aliases = Object.keys(config.models ?? {}).toSorted();
  if (aliases.length === 0) {
    host.showError(`Backend "${backendName}" requires {model}, but no model aliases are configured.`);
    return;
  }
  const currentModel = config.subagent?.routing?.[profile]?.model;
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Select model for CLI: ${backendName}`,
      hint: '↑↓ navigate · Enter select · Esc cancel',
      notice: 'The selected alias is passed to the external CLI through its configured {model} argument.',
      options: aliases.map((alias) => ({
        value: alias,
        label: alias,
        description: config.models?.[alias]?.displayName,
      })),
      currentValue: currentModel,
      onSelect: (model) => {
        host.restoreEditor();
        void saveRoute(host, config, profile, { backend: backendName, model });
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function parseRouteChoice(value: string): RouteChoice {
  const separator = value.indexOf(':');
  if (separator <= 0) return { kind: 'model', alias: value };
  const kind = value.slice(0, separator);
  const name = value.slice(separator + 1);
  return kind === 'backend'
    ? { kind: 'backend', name }
    : { kind: 'model', alias: name };
}

async function saveRoute(
  host: SlashCommandHost,
  _config: KimiConfig,
  profile: ProfileName,
  route: { readonly backend: string; readonly model?: string },
): Promise<void> {
  try {
    await host.harness.setConfig({
      subagent: {
        routing: {
          [profile]: route,
        },
      },
    });

    const session = host.session;
    if (session !== undefined) {
      await session.reloadSession();
      await host.reloadCurrentSessionView(session, `Subagent route for ${profile} saved and applied.`);
    }

    const refreshed = await host.harness.getConfig({ reload: true });
    host.setAppState({
      availableModels: refreshed.models ?? {},
      availableProviders: refreshed.providers ?? {},
    });
    host.refreshSlashCommandAutocomplete();
    host.showStatus(`Subagent route for ${profile} saved to config.toml.`, 'success');
  } catch (error) {
    host.showError(`Failed to save subagent route: ${formatErrorMessage(error)}`);
  }
}
