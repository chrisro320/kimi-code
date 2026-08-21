/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

/**
 * `profile` domain — wire Model (`ProfileModel`) and the `config.update`
 * Op (`configUpdate`) for the agent's persistent configuration slice.
 *
 * Declares the persistent profile config — `modelAlias`, `profileName`,
 * the resolved base thinking effort, `systemPrompt`, its injected AGENTS.md
 * path provenance, the profile `disallowedTools` denylist and `subagents`
 * delegation allowlist, and the environment disclosure snapshot associated
 * with the rendered prompt — as a wire Model (initial `defaultProfileModel()`),
 * plus the single Op whose `apply` is a pure merge of an already-resolved
 * payload. `renderGeneration` advances on accepted system-prompt writes; on
 * the live path an Op's `apply` is the only place that increments it (render
 * callers omit it). The optional payload field is deprecated for new writes:
 * legacy `config.update` records and live `profile.bind` snapshot/fork
 * transfers may carry an explicit value, and `apply` then honors the recorded
 * value verbatim so a replay or resumed binding rebuilds the exact generation
 * the record was written with. Live records carry
 * `thinkingEffort` (matching the v1 wire field); legacy replay still accepts
 * `thinkingLevel`. The value is
 * resolved to a `ThinkingEffort` at the call site and carried in the
 * payload, so `apply` stays
 * pure and a resumed agent restores the persisted base value rather than
 * re-resolving against a possibly-drifted config. Runtime-only Kimi env
 * forcing is intentionally kept out of this Model so the Kimi-only value
 * cannot leak through model switches or agent forks.
 * `modelCapabilities` is intentionally NOT in the Model — it is
 * derived live at runtime so resume never pins stale capabilities. `leanMode`
 * is in the Model for the opposite reason: it is not a property of the model
 * but the session's own choice, fixed when the agent binds, so it belongs
 * with `disallowedTools` / `subagents` and must replay on resume — the path
 * where `bind()` never runs.
 * Each reducer returns the same reference when nothing changes so the
 * reference-equality gate stays quiet. The `agent.status.updated` emission is
 * NOT part of the reducer: it runs after
 * `dispatcher.dispatch` on the live path only, so replay rebuilds the state
 * silently. The agent's working directory is deliberately NOT part of the
 * binding: it is always the session's frozen cwd, read from `sessionContext`
 * at render time rather than persisted here. Legacy `profile.bind` records
 * that still carry a `cwd` field replay fine — the schema strips it.
 *
 * Also declares `ActiveToolsModel` (`readonly string[] | undefined`, initial
 * `undefined` = every tool active), the `tools.set_active_tools` whole-set
 * replace, and the v2-only `tools.reset_active_tools` transition back to the
 * unrestricted default. Both persisted transitions replay the base set. The
 * ephemeral per-tool
 * `addActiveTool` / `removeActiveTool` deltas are NOT Ops — they are
 * intentionally not persisted and are re-derived on resume.
 */
import { nothing, original } from 'immer';
import { z } from 'zod';

import type { EnvironmentDisclosureSnapshot } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { AgentEvent2 } from '#/app/event/event2';
import type { ThinkingEffort } from '#/kosong/contract/provider';
import { defineState } from '#/state/state';

import { ProfileError, ProfileErrors } from './profile';

export interface ProfileModelState {
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingLevel: string;
  readonly systemPrompt: string;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration: number;
  readonly agentsMdPaths?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly leanMode?: boolean;
}

const profileBindSchema = z.object({
  agentId: z.string(),
  modelAlias: z.string().optional(),
  profileName: z.string().optional(),
  thinkingEffort: z.custom<ThinkingEffort>(),
  systemPrompt: z.string(),
  environmentDisclosure: z.custom<EnvironmentDisclosureSnapshot>().optional(),
  renderGeneration: z.number().optional(),
  agentsMdPaths: z.array(z.string()).readonly().optional(),
  activeToolNames: z.array(z.string()).readonly().optional(),
  disallowedTools: z.array(z.string()).readonly(),
  subagents: z.array(z.string()).readonly().optional(),
  leanMode: z.boolean().optional(),
});

export class ProfileBind extends AgentEvent2<z.infer<typeof profileBindSchema>> {
  static override readonly type = 'profile.bind';
  static override readonly durable = true;
  static override readonly schema = profileBindSchema;
}
export interface ProfileBind {
  readonly agentId: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly systemPrompt: string;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
  readonly agentsMdPaths?: readonly string[];
  readonly activeToolNames?: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly subagents?: readonly string[];
  readonly leanMode?: boolean;
}

const configUpdateSchema = z.object({
  agentId: z.string(),
  modelAlias: z.string().optional(),
  profileName: z.string().optional(),
  thinkingEffort: z.custom<ThinkingEffort>().optional(),
  thinkingLevel: z.custom<ThinkingEffort>().optional(),
  systemPrompt: z.string().optional(),
  environmentDisclosure: z.custom<EnvironmentDisclosureSnapshot>().optional(),
  renderGeneration: z.number().optional(),
  agentsMdPaths: z.array(z.string()).readonly().optional(),
  disallowedTools: z.array(z.string()).readonly().optional(),
});

export type ConfigUpdatePayload = z.infer<typeof configUpdateSchema>;

export class ConfigUpdate extends AgentEvent2<ConfigUpdatePayload> {
  static override readonly type = 'config.update';
  static override readonly durable = true;
  static override readonly schema = configUpdateSchema;
}
export interface ConfigUpdate {
  readonly agentId: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingEffort?: ThinkingEffort;
  readonly thinkingLevel?: ThinkingEffort;
  readonly systemPrompt?: string;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
  readonly agentsMdPaths?: readonly string[];
  readonly disallowedTools?: readonly string[];
}

const toolsSetActiveToolsSchema = z.object({
  agentId: z.string(),
  names: z.array(z.string()).readonly(),
});

export class ToolsSetActiveTools extends AgentEvent2<z.infer<typeof toolsSetActiveToolsSchema>> {
  static override readonly type = 'tools.set_active_tools';
  static override readonly durable = true;
  static override readonly schema = toolsSetActiveToolsSchema;
}
export interface ToolsSetActiveTools {
  readonly agentId: string;
  readonly names: readonly string[];
}

const toolsResetActiveToolsSchema = z.object({ agentId: z.string() });

export class ToolsResetActiveTools extends AgentEvent2<
  z.infer<typeof toolsResetActiveToolsSchema>
> {
  static override readonly type = 'tools.reset_active_tools';
  static override readonly durable = true;
  static override readonly schema = toolsResetActiveToolsSchema;
}
export interface ToolsResetActiveTools {
  readonly agentId: string;
}

export interface WarningIssuedPayload {
  readonly agentId: string;
  readonly message: string;
  readonly code?: string;
}

export class WarningIssued extends AgentEvent2<WarningIssuedPayload> {
  static override readonly type = 'warning';
  static override readonly observable = true;
}
export interface WarningIssued extends WarningIssuedPayload {}

export const profileKey = defineState(
  'profile',
  (): ProfileModelState => ({
    thinkingLevel: 'off',
    systemPrompt: '',
    renderGeneration: 0,
  }),
).replayable({ schema: z.custom<ProfileModelState>() })
  .on(ProfileBind, (s, e) => ({
    modelAlias: e.modelAlias ?? s.modelAlias,
    profileName: e.profileName ?? s.profileName,
    thinkingLevel: e.thinkingEffort,
    systemPrompt: e.systemPrompt,
    environmentDisclosure: e.environmentDisclosure,
    renderGeneration: e.renderGeneration ?? s.renderGeneration + 1,
    agentsMdPaths: e.agentsMdPaths ?? s.agentsMdPaths,
    disallowedTools: e.disallowedTools,
    subagents: e.subagents,
    leanMode: e.leanMode ?? s.leanMode,
  }))
  .on(ConfigUpdate, (s, e) => {
    if (e.modelAlias !== undefined && e.modelAlias !== s.modelAlias) {
      s.modelAlias = e.modelAlias;
    }
    if (e.profileName !== undefined && e.profileName !== s.profileName) {
      s.profileName = e.profileName;
    }
    const thinkingLevel = configUpdateThinkingLevel(e);
    if (thinkingLevel !== undefined && thinkingLevel !== s.thinkingLevel) {
      s.thinkingLevel = thinkingLevel;
    }
    if (
      e.systemPrompt !== undefined &&
      (e.systemPrompt !== s.systemPrompt ||
        e.environmentDisclosure !== undefined ||
        e.renderGeneration !== undefined)
    ) {
      s.systemPrompt = e.systemPrompt;
      s.environmentDisclosure = e.environmentDisclosure;
      s.renderGeneration = e.renderGeneration ?? s.renderGeneration + 1;
    }
    if (e.agentsMdPaths !== undefined && !stringArrayEqual(e.agentsMdPaths, s.agentsMdPaths)) {
      s.agentsMdPaths = e.agentsMdPaths as string[];
    }
    if (
      e.disallowedTools !== undefined &&
      !stringArrayEqual(e.disallowedTools, s.disallowedTools)
    ) {
      s.disallowedTools = e.disallowedTools as string[];
    }
  });

function stringArrayEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function configUpdateThinkingLevel(e: ConfigUpdatePayload): ThinkingEffort | undefined {
  if (e.thinkingEffort !== undefined && e.thinkingLevel !== undefined) {
    if (e.thinkingEffort !== e.thinkingLevel) {
      throw new ProfileError(
        ProfileErrors.codes.THINKING_ALIAS_CONFLICT,
        `config.update has conflicting thinkingEffort (${e.thinkingEffort}) and legacy thinkingLevel (${e.thinkingLevel})`,
        {
          type: 'config.update',
          thinkingEffort: e.thinkingEffort,
          thinkingLevel: e.thinkingLevel,
        },
      );
    }
    return e.thinkingEffort;
  }
  if (e.thinkingEffort !== undefined) return e.thinkingEffort;
  return e.thinkingLevel;
}

export type ActiveToolsState = readonly string[] | undefined;

export const profileActiveToolsKey = defineState(
  'profile.activeTools',
  (): ActiveToolsState => undefined,
).replayable({ schema: z.custom<ActiveToolsState>() })
  .on(ToolsSetActiveTools, (s, e) => {
    if (s !== undefined && e.names === original(s)) return;
    return e.names;
  })
  .on(ToolsResetActiveTools, (s) => {
    if (s === undefined) return;
    return nothing as unknown as ActiveToolsState;
  })
  .on(ProfileBind, (s, e) =>
    e.activeToolNames === undefined && s !== undefined
      ? (nothing as unknown as ActiveToolsState)
      : e.activeToolNames,
  );
