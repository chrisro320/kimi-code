/**
 * `subagent` domain — subagent config-section schema, env binding, and
 * timeout / model resolution.
 *
 * Owns the `[subagent]` configuration section (`timeout_ms` on disk) together
 * with the `KIMI_SUBAGENT_TIMEOUT_MS` env override (precedence: env >
 * config.toml > 2h default). The section also carries the spawn-routing
 * tables: `[subagent.routing.<profile>]` binds a profile to a fixed
 * backend/model/thinking_effort route, and `[[subagent.pools.<profile>]]`
 * declares a pool of weighted routes rotated per spawn (resolution lives in
 * `routing.ts`; both need the deep snake_case conversion in
 * `subagentFromToml`/`subagentToToml`). `fallback_chain` declares the
 * user-approved fallback routes tried, in order, when a route's circuit is
 * open (R-A2/Case 8; its entries have no snake_case keys, so the shallow
 * default conversion suffices). While
 * the env var is set, `stripEnvBoundFields` restores the env-free raw value
 * before persistence, so the override never leaks into `config.toml`. Per-run
 * timeouts resolve through `resolveSubagentTimeoutMs`, and the timeout
 * message renders with `formatSubagentTimeoutDescription`.
 *
 * The model half of the spawn binding is the secondary model (the
 * `[secondary_model]` section on disk): when its
 * experiment is enabled and the model is set, newly spawned subagents bind to
 * it by default instead of inheriting the caller's model, and the
 * `Agent`/`AgentSwarm` tools let the parent model pick per spawn via their
 * `model` parameter. When unset, spawning behavior is unchanged (subagents
 * inherit the caller's model). A recipe with patch fields binds the
 * synthesized derived entry (`SECONDARY_DERIVED_MODEL_ID`); a pointer-only
 * recipe binds the pointed entry directly. `default_effort` is passed as the
 * explicit subagent thinking; without it the subagent resolves thinking
 * naturally (global thinking config → the bound model's default effort)
 * rather than inheriting the caller's level. Both tools resolve spawn
 * bindings through `resolveSubagentBinding`, advertise the pair via
 * `buildSubagentModelDescriptions` (each line suffixed with the entry's
 * resolved capability flags, so the parent can route multimodal or
 * thinking-heavy subagent tasks instead of guessing from the model id),
 * and wrap spawn failures with
 * `wrapSubagentModelError`; while the experiment is off they also strip the
 * no-op `model` parameter from their advertised schemas via
 * `stripSubagentModelParameter`. Spawn reporting reads the display-facing
 * alias from `subagentDisplayModel`: the derived entry id means nothing to a
 * user, so it resolves back to the recipe's base alias — flag-independent on
 * purpose, since interpreting an already-persisted derived binding (resume)
 * must keep working after the experiment is switched off. Self-registered
 * at module load via `registerConfigSection`.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import type { AgentModelPreference } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  camelToSnake,
  cloneRecord,
  isPlainObject,
  setDefined,
  transformPlainObject,
} from '#/app/config/toml';
import type { IFlagService } from '#/app/flag/flag';
import {
  SECONDARY_MODEL_ENV,
  SECONDARY_MODEL_SECTION,
} from '#/app/kosongConfig/configSection';
import {
  SECONDARY_DERIVED_MODEL_ID,
  secondaryModelPatch,
} from '#/app/kosongConfig/secondaryModelOverlay';
import { type SecondaryModelConfig } from '#/app/kosongConfig/configSection';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { IModelCatalog } from '#/kosong/model/catalog';

import { SECONDARY_MODEL_FLAG_ID } from './flag';

export const SUBAGENT_SECTION = 'subagent';

export const SubagentRoutingSchema = z.object({
  /** `kimi` (or omitted) uses the in-process subagent. */
  backend: z.string().min(1).optional(),
  /** Model alias used by this subagent type. */
  model: z.string().min(1).optional(),
  /** Thinking effort for an in-process Kimi route; external backends ignore it. */
  thinkingEffort: z.string().min(1).optional(),
});

export type SubagentRouting = z.infer<typeof SubagentRoutingSchema>;

export const SubagentPoolRouteSchema = z.object({
  /** `kimi` uses the in-process subagent; anything else must exist in `subagent.backends`. */
  backend: z.string().min(1),
  /** Model alias used when this route is selected. */
  model: z.string().min(1).optional(),
  /** Thinking effort for an in-process Kimi route; external backends ignore it. */
  thinkingEffort: z.string().min(1).optional(),
  /** Max concurrently active spawns through this route. Unset means unlimited. */
  maxConcurrency: z.number().int().min(1).optional(),
  /** Relative weight for round-robin selection. Defaults to 1. */
  weight: z.number().positive().optional(),
});

export type SubagentPoolRoute = z.infer<typeof SubagentPoolRouteSchema>;

/** R-A2: one entry in the user-approved fallback chain tried, in order, when a route's circuit is open. */
export const SubagentFallbackRouteSchema = z.object({
  backend: z.string().min(1),
  model: z.string().min(1).optional(),
});

export type SubagentFallbackRoute = z.infer<typeof SubagentFallbackRouteSchema>;

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
  routing: z.record(z.string().min(1), SubagentRoutingSchema).optional(),
  /**
   * Per-profile pool of weighted routes. When a profile has a non-empty
   * pool, spawns go through a deterministic weighted round-robin over these
   * routes instead of the single `routing` entry.
   */
  pools: z.record(z.string().min(1), z.array(SubagentPoolRouteSchema).min(1)).optional(),
  /**
   * Ordered list of pre-approved fallback routes tried, in sequence, when
   * the normally-resolved route's circuit is open (R-A2/Case 8). Model
   * replacement after a non-retryable provider/model/route failure must
   * never be an autonomous choice made at request time — this is the user's
   * advance approval for exactly which routes may be substituted, and in
   * what order.
   */
  fallbackChain: z.array(SubagentFallbackRouteSchema).optional(),
  /**
   * How a workspace that cannot support worktree isolation at all (not a git
   * repository, no commit yet, non-POSIX backend) is handled when an editing
   * subagent is dispatched. `best-effort` dispatches unisolated with a warning;
   * `strict` refuses the dispatch. Isolation that should have worked and failed
   * always refuses, in both modes.
   */
  isolation: z.enum(['strict', 'best-effort']).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';

function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  // `0` is meaningful ("no timeout", v1 parity) — only reject non-integers
  // and negatives.
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export const subagentEnvBindings: EnvBindings<SubagentConfig> = envBindings(
  SubagentConfigSchema,
  {
    timeoutMs: { env: SUBAGENT_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
  },
);

export const stripSubagentEnv = stripEnvBoundFields(subagentEnvBindings);

/**
 * The default TOML transform is shallow, but `routing.<profile>` entries and
 * `pools.<profile>` array items nest snake_case keys (`thinking_effort`,
 * `max_concurrency`) one level deeper — convert those explicitly or the
 * schema would silently strip them.
 */
export const subagentFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const converted = transformPlainObject(rawSnake);
  if (isPlainObject(converted['routing'])) {
    const routing: Record<string, unknown> = {};
    for (const [profile, entry] of Object.entries(converted['routing'])) {
      routing[profile] = isPlainObject(entry) ? transformPlainObject(entry) : entry;
    }
    converted['routing'] = routing;
  }
  if (isPlainObject(converted['pools'])) {
    const pools: Record<string, unknown> = {};
    for (const [profile, entries] of Object.entries(converted['pools'])) {
      pools[profile] = Array.isArray(entries)
        ? entries.map((entry) => (isPlainObject(entry) ? transformPlainObject(entry) : entry))
        : entries;
    }
    converted['pools'] = pools;
  }
  return converted;
};

export const subagentToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const rawSub = cloneRecord(rawSnake);
  const out = cloneRecord(rawSnake);
  for (const [key, field] of Object.entries(value)) {
    if (key === 'routing' && isPlainObject(field)) {
      out['routing'] = subagentRoutingToToml(field, rawSub['routing']);
    } else if (key === 'pools' && isPlainObject(field)) {
      out['pools'] = subagentPoolsToToml(field, rawSub['pools']);
    } else {
      setDefined(out, camelToSnake(key), field);
    }
  }
  return out;
};

function subagentRoutingToToml(
  routing: Record<string, unknown>,
  rawSnake: unknown,
): Record<string, unknown> {
  const rawSub = cloneRecord(rawSnake);
  const out: Record<string, unknown> = {};
  for (const [profile, entry] of Object.entries(routing)) {
    if (!isPlainObject(entry)) {
      out[profile] = entry;
      continue;
    }
    const merged = cloneRecord(rawSub[profile]);
    for (const [key, field] of Object.entries(entry)) {
      setDefined(merged, camelToSnake(key), field);
    }
    out[profile] = merged;
  }
  return out;
}

function subagentPoolsToToml(
  pools: Record<string, unknown>,
  rawSnake: unknown,
): Record<string, unknown> {
  const rawSub = cloneRecord(rawSnake);
  const out: Record<string, unknown> = {};
  for (const [profile, entries] of Object.entries(pools)) {
    if (!Array.isArray(entries)) {
      out[profile] = entries;
      continue;
    }
    const rawEntries: unknown = rawSub[profile];
    out[profile] = entries.map((entry, index) => {
      if (!isPlainObject(entry)) return entry;
      const merged = cloneRecord(Array.isArray(rawEntries) ? rawEntries[index] : undefined);
      for (const [key, field] of Object.entries(entry)) {
        setDefined(merged, camelToSnake(key), field);
      }
      return merged;
    });
  }
  return out;
}

registerConfigSection(SUBAGENT_SECTION, SubagentConfigSchema, {
  defaultValue: { timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS },
  fromToml: subagentFromToml,
  toToml: subagentToToml,
  env: subagentEnvBindings,
  stripEnv: stripSubagentEnv,
});

export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
  );
}

export type SubagentIsolationMode = 'strict' | 'best-effort';

export function resolveSubagentIsolationMode(config: IConfigService): SubagentIsolationMode {
  return config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.isolation ?? 'best-effort';
}

export type SubagentModelChoice = AgentModelPreference;

export function resolveSecondaryModel(
  config: IConfigService,
  flags: IFlagService,
): SecondaryModelConfig | undefined {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return undefined;
  return config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
}

export function resolveSubagentBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: SubagentModelChoice,
): { model: string; thinking?: string; displayModel: string } {
  const secondary = resolveSecondaryModel(config, flags);
  if (requested !== 'primary' && secondary?.model !== undefined) {
    const model =
      secondaryModelPatch(secondary) === undefined ? secondary.model : SECONDARY_DERIVED_MODEL_ID;
    return {
      model,
      thinking: secondary.defaultEffort,
      displayModel: subagentDisplayModel(config, model),
    };
  }
  return {
    model: own.modelAlias,
    thinking: own.thinkingLevel,
    displayModel: subagentDisplayModel(config, own.modelAlias),
  };
}

export function subagentDisplayModel(
  config: IConfigService,
  boundAlias: string,
): string {
  if (boundAlias !== SECONDARY_DERIVED_MODEL_ID) return boundAlias;
  return (
    config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION)?.model ?? boundAlias
  );
}

export function buildSubagentModelDescriptions(
  config: IConfigService,
  flags: IFlagService,
  callerModelAlias: string | undefined,
  modelCatalog: IModelCatalog,
): string | undefined {
  const secondary = resolveSecondaryModel(config, flags);
  const secondaryModel = secondary?.model;
  if (secondaryModel === undefined || callerModelAlias === undefined) return undefined;
  const boundSecondary =
    secondaryModelPatch(secondary) === undefined ? secondaryModel : SECONDARY_DERIVED_MODEL_ID;
  return [
    'Available models (pass via model):',
    `- secondary: ${secondaryModel} (default) — the configured secondary model; prefer it for routine subagent tasks${capabilitiesSuffix(resolvedCapabilities(modelCatalog, boundSecondary))}`,
    `- primary: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks${capabilitiesSuffix(resolvedCapabilities(modelCatalog, callerModelAlias))}`,
  ].join('\n');
}

const ADVERTISED_CAPABILITY_FLAGS = [
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const satisfies readonly (keyof ModelCapability)[];

function capabilitiesSuffix(capability: ModelCapability | undefined): string {
  if (capability === undefined) return '';
  const names = ADVERTISED_CAPABILITY_FLAGS.filter((flag) => capability[flag] === true);
  return `; capabilities: ${names.length === 0 ? 'none' : names.join(', ')}`;
}

function resolvedCapabilities(
  modelCatalog: IModelCatalog,
  model: string,
): ModelCapability | undefined {
  try {
    return modelCatalog.get(model).capabilities;
  } catch {
    return undefined;
  }
}

export function stripSubagentModelParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (!isPlainObject(properties) || !('model' in properties)) return parameters;
  const nextProperties = { ...properties };
  delete nextProperties['model'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const required = parameters['required'];
  if (Array.isArray(required) && required.includes('model')) {
    next['required'] = required.filter((entry) => entry !== 'model');
  }
  return next;
}

export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string | undefined,
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (!isError2(error) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  if (error.details?.['model'] !== boundModel) return error;
  const displayModel =
    boundModel === SECONDARY_DERIVED_MODEL_ID
      ? `the derived entry "${SECONDARY_DERIVED_MODEL_ID}"`
      : `"${boundModel}"`;
  return new Error2(
    error.code,
    `${error.message} (secondary model ${displayModel} comes from [secondary_model].model / ${SECONDARY_MODEL_ENV} — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details: {
        ...error.details,
        secondaryModel: boundModel,
        secondaryModelConfig: {
          section: 'secondaryModel.model',
          environment: SECONDARY_MODEL_ENV,
        },
      },
    },
  );
}

export function formatSubagentTimeoutDescription(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) {
    const h = ms / (60 * 60 * 1000);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  if (ms % (60 * 1000) === 0) {
    const m = ms / (60 * 1000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (ms % 1000 === 0) {
    const s = ms / 1000;
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}
