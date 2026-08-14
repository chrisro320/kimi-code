/**
 * `subagent` domain — subagent config-section schemas, env binding, and
 * timeout / model resolution.
 *
 * Owns the `[subagent]` and `[secondary_model]` on-disk sections:
 *
 * - `[subagent]` — `timeout_ms`, together with the `KIMI_SUBAGENT_TIMEOUT_MS`
 *   env override (precedence: env > config.toml > 2h default). While the env
 *   var is set, `stripEnvBoundFields` restores the env-free raw value before
 *   persistence, so the override never leaks into `config.toml`. Per-run
 *   timeouts resolve through `resolveSubagentTimeoutMs`, and the timeout
 *   message renders with `formatSubagentTimeoutDescription`. The section also
 *   carries the spawn-routing tables: `[subagent.routing.<profile>]` binds a
 *   profile to a fixed backend/model/thinking_effort route, and
 *   `[[subagent.pools.<profile>]]` declares a pool of weighted routes rotated
 *   per spawn (resolution lives in `routing.ts`; both need the deep
 *   snake_case conversion in `subagentFromToml`/`subagentToToml`).
 *   `fallback_chain` declares the user-approved fallback routes tried, in
 *   order, when a route's circuit is open (R-A2/Case 8; its entries have no
 *   snake_case keys, so the shallow default conversion suffices).
 *
 * - `[secondary_model]` — the subagent model pool: `default_model` names the
 *   fallback model and the `[secondary_model.models]` table maps alias →
 *   description. A `default_model` without a `[secondary_model.models]` table
 *   stands on its own as an implicit single-entry pool (empty description) —
 *   the minimal "secondary model" configuration. As a compatibility fallback
 *   for the v1 engine's recipe, a lone legacy `model` key (likewise without a
 *   pool table) forms the same implicit single-entry pool, ranked below
 *   `default_model`; the recipe's patch fields (`default_effort`, ...) have
 *   no pool counterpart and are ignored by pool resolution — but the schema
 *   still declares them so validation never strips them and config
 *   reads/writes round-trip losslessly for the v1 engine, and `model` never
 *   substitutes for
 *   the pool table's required `default_model`. `force = true` instead
 *   removes the choice entirely: every spawn binds the resolved default
 *   (`default_model` ?? `model`), the tools hide the `model` parameter
 *   exactly like the no-pool case, and combining
 *   it with a `[secondary_model.models]` table is rejected — the table's only
 *   purpose is offering the main agent a choice.
 *
 * When a pool is configured (and not forced), newly spawned subagents
 * bind to the pool's default model unless the parent model picks a pool alias
 * — or `primary` (`PRIMARY_SUBAGENT_MODEL_CHOICE`), the always-available
 * symbolic choice binding the caller's own model and thinking level — per
 * spawn via the `Agent` / `AgentSwarm` tool `model` parameter. Pool bindings
 * carry no explicit thinking level, so the subagent resolves thinking
 * naturally (global thinking config → the bound model's default effort)
 * rather than inheriting the caller's level. Without a pool, spawning
 * behavior is unchanged (subagents inherit the caller's model) and the tools
 * strip the no-op `model` parameter from their advertised schemas via
 * `stripSubagentModelParameter`, so the concept never enters the prompt and a
 * stray `model` argument is rejected instead of silently inheriting; the
 * strip returns a shallow copy and never mutates the input, so callers can
 * keep both schema variants as shared constants. `force = true` shares this
 * hidden-parameter surface (see `exposesSubagentModelChoice`) while binding
 * every spawn to the resolved default in `resolveSubagentBinding`. The whole
 * pool is gated behind the `secondary-model` experimental flag (`flag.ts`):
 * while the experiment is off the section is inert — the tools strip the
 * `model` parameter, spawns bind the caller's model, and validation is
 * skipped.
 *
 * Spawn bindings resolve through `resolveSubagentBinding`: a forced
 * configuration short-circuits to the resolved default before anything else, and
 * any explicit request — `primary` included — throws (defensive; the tools
 * strip the parameter); `primary`
 * short-circuits to the caller's own model+thinking; with no pool a stray
 * non-`primary` request throws (defensive — the tools strip the parameter);
 * with a pool the request must be a pool alias, an omitted request falls back
 * to `default_model`, and anything else throws `CONFIG_INVALID` listing the
 * available choices so the parent model can retry. The tools advertise the
 * pool via `buildSubagentModelDescriptions`: the default model leads with a
 * `[default]` marker, the remaining aliases follow in config order, and the
 * caller's own alias is listed like any other pool entry (marked
 * `[main model]`) — pool alias bindings carry no thinking, so the trailing
 * `primary` line stays distinct from it: it binds the caller's model WITH the
 * caller's current thinking level, and names the alias in parentheses when
 * the caller is in the pool. An empty-string description renders a bare
 * `- alias` line. Spawn failures are wrapped by `wrapSubagentModelError`:
 * when the bound model is not the caller's own and the catalog failed on
 * exactly that alias, the parent model gets guidance toward
 * `[secondary_model.models]` instead of a bare resolution error.
 * Cross-field validation is NOT part of the schema — it is enforced as
 * `Error2(CONFIG_INVALID)` by `assertValidSubagentModelConfig` (run before
 * session materialization by the session lifecycle, with the Session-scope
 * validation service in `subagentModelsValidationService.ts` as backstop),
 * which checks the `force` rules (a default — `default_model` or the legacy
 * `model` fallback — required, a
 * `[secondary_model.models]` table rejected) and delegates the pool checks to
 * `assertValidSubagentModelPool`: the default must be present and name a
 * pool key, every pool key must resolve through the model catalog, and the
 * reserved `primary` alias is rejected outright — as a pool key it would be
 * unreachable (explicit requests short-circuit to the caller's model) and
 * would render a self-contradictory description. `resolveSubagentBinding`
 * repeats the reserved-key and force-rule checks so a pool broken by a
 * runtime config edit fails loudly at spawn instead of binding the wrong
 * model; any other malformation the startup checks missed surfaces as the
 * spawn-time errors above. Writes that rewrite the `[models]` table
 * (provider removal/replace at the edge, background catalog refreshes)
 * fold the pool through `cascadeSubagentModelPool` into the same atomic
 * write — renamed aliases are repointed, dropped aliases filtered, and the
 * whole section cleared when its effective default dangles (an emptied pool
 * table folds into the implicit single-entry form — a default naming no
 * pool key would fail validation) — so the startup
 * validation never meets a pool orphaned by a write it did not see.
 * Self-registered at module load via `registerConfigSection`.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import {
  camelToSnake,
  cloneRecord,
  isPlainObject,
  setDefined,
  transformPlainObject,
} from '#/app/config/toml';
import type { IFlagService } from '#/app/flag/flag';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { IModelCatalog } from '#/kosong/model/catalog';

import { SECONDARY_MODEL_FLAG_ID } from './flag';

export const SUBAGENT_SECTION = 'subagent';
export const SECONDARY_MODEL_SECTION = 'secondaryModel';

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

export const SecondaryModelConfigSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  models: z.record(z.string(), z.string()).optional(),
  force: z.boolean().optional(),
  model: z.string().min(1).optional(),
  maxContextSize: z.number().int().min(1).optional(),
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  offEffort: z.string().optional(),
});

export type SecondaryModelConfig = z.infer<typeof SecondaryModelConfigSchema>;

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

registerConfigSection(SECONDARY_MODEL_SECTION, SecondaryModelConfigSchema);

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

export const PRIMARY_SUBAGENT_MODEL_CHOICE = 'primary';

export interface SubagentModelPool {
  readonly defaultModel?: string;
  readonly models: Record<string, string>;
}

export function resolveSubagentModelPool(config: IConfigService): SubagentModelPool | undefined {
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  if (section?.models !== undefined) {
    return { defaultModel: section.defaultModel, models: section.models };
  }
  if (section?.defaultModel !== undefined) {
    return { defaultModel: section.defaultModel, models: { [section.defaultModel]: '' } };
  }
  if (section?.model !== undefined) {
    return { defaultModel: section.model, models: { [section.model]: '' } };
  }
  return undefined;
}

export const SECONDARY_MODEL_FORCE_REQUIRES_DEFAULT_MESSAGE =
  '[secondary_model].default_model is required when [secondary_model].force is set';

export const SECONDARY_MODEL_FORCE_EXCLUDES_MODELS_MESSAGE =
  '[secondary_model].force cannot be combined with [secondary_model.models]: the pool table only exists to offer the main agent a choice, and force removes that choice';

export function isSubagentModelForced(config: IConfigService): boolean {
  return config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION)?.force === true;
}

export function exposesSubagentModelChoice(config: IConfigService, flags: IFlagService): boolean {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return false;
  if (isSubagentModelForced(config)) return false;
  return resolveSubagentModelPool(config) !== undefined;
}

export const SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE =
  '[secondary_model].default_model is required when [secondary_model.models] is configured';

export const SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE = `[secondary_model.models] key "${PRIMARY_SUBAGENT_MODEL_CHOICE}" is reserved: it always binds the caller's own model. Rename the pool entry.`;

export function assertValidSubagentModelPool(
  pool: SubagentModelPool,
  modelCatalog: IModelCatalog,
): void {
  if (Object.hasOwn(pool.models, PRIMARY_SUBAGENT_MODEL_CHOICE)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE, {
      details: {
        section: SECONDARY_MODEL_SECTION,
        field: 'models',
        model: PRIMARY_SUBAGENT_MODEL_CHOICE,
      },
    });
  }
  const aliases = Object.keys(pool.models);
  if (pool.defaultModel === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE, {
      details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
    });
  }
  if (!Object.hasOwn(pool.models, pool.defaultModel)) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `[secondary_model].default_model "${pool.defaultModel}" is not a [secondary_model.models] key. Available models: ${aliases.join(', ')}.`,
      { details: { model: pool.defaultModel, availableModels: aliases } },
    );
  }
  for (const alias of aliases) {
    try {
      modelCatalog.get(alias);
    } catch (error) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `[secondary_model.models] entry "${alias}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, details: { model: alias } },
      );
    }
  }
}

export function assertValidSubagentModelConfig(
  config: IConfigService,
  flags: IFlagService,
  modelCatalog: IModelCatalog,
): void {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return;
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  if (section?.force === true) {
    if (section.models !== undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_EXCLUDES_MODELS_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'force' },
      });
    }
    if (section.defaultModel === undefined && section.model === undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_REQUIRES_DEFAULT_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
      });
    }
  }
  const pool = resolveSubagentModelPool(config);
  if (pool !== undefined) assertValidSubagentModelPool(pool, modelCatalog);
}

export function cascadeSubagentModelPool(
  section: SecondaryModelConfig | undefined,
  survivingModels: Record<string, unknown>,
  renamedAliases: ReadonlyMap<string, string> = new Map(),
): SecondaryModelConfig | null | undefined {
  if (section === undefined) return undefined;
  const remap = (alias: string): string => renamedAliases.get(alias) ?? alias;
  const nextDefault = section.defaultModel === undefined ? undefined : remap(section.defaultModel);
  const nextLegacyDefault = section.model === undefined ? undefined : remap(section.model);
  const effectiveDefault = nextDefault ?? nextLegacyDefault;
  if (effectiveDefault !== undefined && !(effectiveDefault in survivingModels)) return null;

  let changed = nextDefault !== section.defaultModel || nextLegacyDefault !== section.model;
  let nextPool: Record<string, string> | undefined;
  if (section.models !== undefined) {
    nextPool = {};
    for (const [alias, description] of Object.entries(section.models)) {
      const key = remap(alias);
      if (!(key in survivingModels)) {
        changed = true;
        continue;
      }
      if (key !== alias) changed = true;
      nextPool[key] = description;
    }
    if (Object.keys(nextPool).length === 0) {
      nextPool = undefined;
      changed = true;
    }
  }
  if (!changed) return undefined;
  return { ...section, defaultModel: nextDefault, model: nextLegacyDefault, models: nextPool };
}

export function resolveSubagentBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: string,
): { model: string; thinking?: string } {
  const enabled = flags.enabled(SECONDARY_MODEL_FLAG_ID);
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  if (enabled && section?.force === true) {
    if (section.models !== undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_EXCLUDES_MODELS_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'force' },
      });
    }
    const forcedModel = section.defaultModel ?? section.model;
    if (forcedModel === undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_REQUIRES_DEFAULT_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
      });
    }
    if (requested !== undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Invalid model "${requested}": [secondary_model].force is set, so every subagent binds "${forcedModel}" (omit the model parameter).`,
        { details: { model: requested } },
      );
    }
    return { model: forcedModel };
  }
  if (requested === PRIMARY_SUBAGENT_MODEL_CHOICE) {
    return { model: own.modelAlias, thinking: own.thinkingLevel };
  }
  const pool = enabled ? resolveSubagentModelPool(config) : undefined;
  if (pool === undefined) {
    if (requested !== undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Invalid model "${requested}": no [secondary_model.models] pool is configured, so subagents inherit the caller's model (pass "primary" or omit the model parameter).`,
        { details: { model: requested } },
      );
    }
    return { model: own.modelAlias, thinking: own.thinkingLevel };
  }
  if (Object.hasOwn(pool.models, PRIMARY_SUBAGENT_MODEL_CHOICE)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE, {
      details: {
        section: SECONDARY_MODEL_SECTION,
        field: 'models',
        model: PRIMARY_SUBAGENT_MODEL_CHOICE,
      },
    });
  }
  const choice = requested ?? pool.defaultModel;
  if (choice === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE, {
      details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
    });
  }
  if (!Object.hasOwn(pool.models, choice)) {
    const available = [...Object.keys(pool.models), PRIMARY_SUBAGENT_MODEL_CHOICE];
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid model "${choice}". Available models: ${available.join(', ')}.`,
      { details: { model: choice, availableModels: available } },
    );
  }
  return { model: choice };
}

export function buildSubagentModelDescriptions(
  config: IConfigService,
  flags: IFlagService,
  callerModelAlias: string | undefined,
): string | undefined {
  if (!exposesSubagentModelChoice(config, flags)) return undefined;
  const pool = resolveSubagentModelPool(config)!;
  const lines = ['Available models (pass via model):'];
  const defaultModel = pool.defaultModel;
  const markersFor = (alias: string): string => {
    const markers: string[] = [];
    if (alias === defaultModel) markers.push('[default]');
    if (alias === callerModelAlias) markers.push('[main model]');
    return markers.length === 0 ? '' : ` ${markers.join(' ')}`;
  };
  if (defaultModel !== undefined && Object.hasOwn(pool.models, defaultModel)) {
    lines.push(
      formatPoolLine(`${defaultModel}${markersFor(defaultModel)}`, pool.models[defaultModel]!),
    );
  }
  for (const [alias, description] of Object.entries(pool.models)) {
    if (alias === defaultModel) continue;
    lines.push(formatPoolLine(`${alias}${markersFor(alias)}`, description));
  }
  const callerInPool =
    callerModelAlias !== undefined && Object.hasOwn(pool.models, callerModelAlias);
  lines.push(
    `- ${PRIMARY_SUBAGENT_MODEL_CHOICE}${callerInPool ? ` (${callerModelAlias})` : ''}: the main model you are running on, bound with your current thinking level; use it for hard, quality-sensitive subagent tasks`,
  );
  return lines.join('\n');
}

function formatPoolLine(label: string, description: string): string {
  return description === '' ? `- ${label}` : `- ${label}: ${description}`;
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
  return new Error2(
    error.code,
    `${error.message} (subagent model "${boundModel}" comes from [secondary_model.models] — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details: {
        ...error.details,
        subagentModel: boundModel,
        subagentModelConfig: {
          section: 'secondary_model.models',
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
