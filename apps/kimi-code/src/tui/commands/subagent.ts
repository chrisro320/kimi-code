import type { KimiConfig, ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import {
  CoderPoolManagerComponent,
  type CoderPoolRoute,
} from '../components/dialogs/coder-pool-manager';
import { NumericInputDialogComponent } from '../components/dialogs/numeric-input-dialog';
import { ModelSelectorComponent, type ModelSelection } from '../components/dialogs/model-selector';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const DEFAULT_PROFILES = ['coder', 'coder-ex', 'debugger', 'explore', 'frontend-artist', 'reviewer'] as const;
const INTERNAL_BACKEND = 'kimi';
const MANAGE_POOL = 'manage-pool';

type RouteChoice =
  | { readonly kind: 'model'; readonly alias: string }
  | { readonly kind: 'backend'; readonly name: string };

type ProfileName = string;
type InternalCoderPoolRoute = CoderPoolRoute & { readonly thinkingEffort?: ThinkingEffort };

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
  const options: ChoiceOption[] = profile === 'coder'
    ? [
        {
          value: MANAGE_POOL,
          label: 'Manage coder pool',
          description: `${String(config.subagent?.pools?.['coder']?.length ?? 0)} configured route(s)`,
        },
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
      ]
    : [
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
        if (profile === 'coder' && value === MANAGE_POOL) {
          showCoderPoolManager(host, config);
          return;
        }
        const choice = parseRouteChoice(value);
        if (choice.kind === 'model') {
          showInternalRouteModelPicker(host, config, profile, choice.alias);
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

function showInternalRouteModelPicker(
  host: SlashCommandHost,
  config: KimiConfig,
  profile: ProfileName,
  selectedAlias: string,
): void {
  const current = config.subagent?.routing?.[profile];
  const currentIsInternal = current?.backend === undefined || current.backend === INTERNAL_BACKEND;
  const currentValue = currentIsInternal ? current?.model ?? selectedAlias : selectedAlias;
  const currentThinkingEffort = currentIsInternal ? current?.thinkingEffort ?? 'off' : 'off';
  host.mountEditorReplacement(
    new ModelSelectorComponent({
      models: config.models ?? {},
      currentValue,
      selectedValue: selectedAlias,
      currentThinkingEffort,
      searchable: true,
      onSelect: (selection) => {
        host.restoreEditor();
        void saveRoute(host, config, profile, internalRoute(selection));
      },
      onCancel: () => host.restoreEditor(),
    }),
  );
}

function internalRoute(selection: ModelSelection): {
  readonly backend: string;
  readonly model: string;
  readonly thinkingEffort: ThinkingEffort;
} {
  return {
    backend: INTERNAL_BACKEND,
    model: selection.alias,
    thinkingEffort: selection.thinking,
  };
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

function showCoderPoolManager(host: SlashCommandHost, config: KimiConfig): void {
  const routes = (config.subagent?.pools?.['coder'] ?? []) as readonly CoderPoolRoute[];
  host.mountEditorReplacement(
    new CoderPoolManagerComponent({
      routes,
      onAdd: () => showPoolRoutePicker(host, config),
      onEdit: (index) => showPoolMemberActions(host, config, index),
      onRemove: (index) => void removePoolRoute(host, config, index),
      onClose: () => host.restoreEditor(),
    }),
  );
}

function showPoolRoutePicker(host: SlashCommandHost, config: KimiConfig): void {
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
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Add coder pool route',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options,
      onSelect: (value) => {
        host.restoreEditor();
        const choice = parseRouteChoice(value);
        if (choice.kind === 'model') {
          showInternalPoolModelPicker(host, config, choice.alias);
          return;
        }
        const backend = config.subagent?.backends?.[choice.name];
        if (backend === undefined) {
          host.showError(`Subagent backend "${choice.name}" is no longer configured.`);
          return;
        }
        if ((backend.args ?? []).some((arg) => arg.includes('{model}'))) {
          showPoolExternalModelPicker(host, config, choice.name);
        } else {
          showPoolRouteSettings(host, config, { backend: choice.name });
        }
      },
      onCancel: () => host.restoreEditor(),
    }),
  );
}

function showInternalPoolModelPicker(
  host: SlashCommandHost,
  config: KimiConfig,
  selectedAlias: string,
  route?: InternalCoderPoolRoute,
  replaceIndex?: number,
): void {
  const currentValue = route?.model ?? selectedAlias;
  host.mountEditorReplacement(
    new ModelSelectorComponent({
      models: config.models ?? {},
      currentValue,
      selectedValue: selectedAlias,
      currentThinkingEffort: route?.thinkingEffort ?? 'off',
      searchable: true,
      onSelect: (selection) => {
        host.restoreEditor();
        showPoolRouteSettings(host, config, {
          ...route,
          ...internalRoute(selection),
        }, replaceIndex);
      },
      onCancel: () => host.restoreEditor(),
    }),
  );
}

function showPoolExternalModelPicker(host: SlashCommandHost, config: KimiConfig, backendName: string): void {
  const aliases = Object.keys(config.models ?? {}).toSorted();
  if (aliases.length === 0) {
    host.showError(`Backend "${backendName}" requires {model}, but no model aliases are configured.`);
    return;
  }
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Select model for coder CLI: ${backendName}`,
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options: aliases.map((alias) => ({
        value: alias,
        label: alias,
        description: config.models?.[alias]?.displayName,
      })),
      onSelect: (model) => {
        host.restoreEditor();
        showPoolRouteSettings(host, config, { backend: backendName, model });
      },
      onCancel: () => host.restoreEditor(),
    }),
  );
}

function showPoolRouteSettings(
  host: SlashCommandHost,
  config: KimiConfig,
  route: CoderPoolRoute,
  replaceIndex?: number,
): void {
  showPoolNumericSetting(host, config, route, 'weight', route.weight ?? 1, false, replaceIndex);
}

function showPoolNumericSetting(
  host: SlashCommandHost,
  config: KimiConfig,
  route: CoderPoolRoute,
  field: 'weight' | 'maxConcurrency',
  value: number,
  integer: boolean,
  replaceIndex?: number,
): void {
  const nextField = field === 'weight' ? 'maxConcurrency' : undefined;
  host.mountEditorReplacement(
    new NumericInputDialogComponent({
      title: `Coder pool ${field === 'weight' ? 'weight' : 'max concurrency'}`,
      description: field === 'weight' ? 'Higher weight receives more dispatches.' : 'Maximum simultaneous workers for this route.',
      initialValue: value,
      integer,
      onDone: (result) => {
        if (result.kind === 'cancel') {
          host.restoreEditor();
          return;
        }
        host.restoreEditor();
        const updated = field === 'weight' ? { ...route, weight: result.value } : { ...route, maxConcurrency: result.value };
        if (nextField === undefined) {
          const routes = [...(config.subagent?.pools?.['coder'] ?? [])];
          if (replaceIndex === undefined) routes.push(updated);
          else routes[replaceIndex] = updated;
          void savePoolRoutes(host, config, routes);
        } else {
          showPoolNumericSetting(host, config, updated, nextField, updated.maxConcurrency ?? 1, true, replaceIndex);
        }
      },
    }),
  );
}

function showPoolMemberActions(host: SlashCommandHost, config: KimiConfig, index: number): void {
  const route = (config.subagent?.pools?.['coder'] ?? [])[index] as InternalCoderPoolRoute | undefined;
  if (route === undefined) return;
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Manage coder route: ${route.backend}${route.model === undefined ? '' : `/${route.model}`}`,
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options: [
        { value: 'edit', label: 'Edit route, weight, and concurrency' },
        { value: 'remove', label: 'Remove route', tone: 'danger' },
      ],
      onSelect: (action) => {
        host.restoreEditor();
        if (action === 'edit') {
          if (route.backend === INTERNAL_BACKEND) {
            showInternalPoolModelPicker(host, config, route.model ?? '', route, index);
          } else {
            showPoolNumericSetting(host, config, route, 'weight', route.weight ?? 1, false, index);
          }
        } else {
          void removePoolRoute(host, config, index);
        }
      },
      onCancel: () => host.restoreEditor(),
    }),
  );
}

async function removePoolRoute(host: SlashCommandHost, config: KimiConfig, index: number): Promise<void> {
  const routes = [...(config.subagent?.pools?.['coder'] ?? [])];
  if (routes.length <= 1) {
    host.showError('Cannot remove the final coder pool route. Add another route first.');
    return;
  }
  routes.splice(index, 1);
  await savePoolRoutes(host, config, routes);
}

async function savePoolRoutes(host: SlashCommandHost, _config: KimiConfig, routes: readonly CoderPoolRoute[]): Promise<void> {
  const seen = new Set<string>();
  for (const route of routes) {
    const key = `${route.backend}\u0000${route.model ?? ''}`;
    if (seen.has(key)) {
      host.showError(`Coder pool already contains route ${route.backend}${route.model === undefined ? '' : `/${route.model}`}.`);
      return;
    }
    seen.add(key);
  }
  try {
    await host.harness.setConfig({ subagent: { pools: { coder: [...routes] } } });
    const session = host.session;
    if (session !== undefined) {
      await session.reloadSession();
      await host.reloadCurrentSessionView(session, 'Coder pool saved and applied.');
    }
    const refreshed = await host.harness.getConfig({ reload: true });
    host.setAppState({ availableModels: refreshed.models ?? {}, availableProviders: refreshed.providers ?? {} });
    host.refreshSlashCommandAutocomplete();
    host.showStatus('Coder pool saved to config.toml.', 'success');
  } catch (error) {
    host.showError(`Failed to save coder pool: ${formatErrorMessage(error)}`);
  }
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
  route: { readonly backend: string; readonly model?: string; readonly thinkingEffort?: ThinkingEffort },
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
