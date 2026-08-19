/**
 * `tools` domain — `SubagentTool` implementation (the `Agent` tool).
 *
 * The LLM-facing wrapper over the `subagent` domain: translates the tool args
 * into a Profile + Model binding, creates (or resumes) an agent through
 * `IAgentLifecycleService`, drives one turn via `ISessionSubagentService.run`,
 * and mirrors the run onto the calling agent's record stream
 * (`mirrorAgentRun`). The tool also owns the JSON schema + description,
 * approval rule, background-task registration (so the LLM can see the run
 * under TaskList/TaskOutput/TaskStop when `run_in_background=true` or after
 * detach), and terminal text formatting.
 *
 * Spawn bindings use the explicit tool `model` choice first, before
 * `resolveSubagentBinding` falls back to the configured
 * `[secondary_model.models]` pool default or the caller's model; with
 * `[secondary_model].force` set the `model` parameter is not advertised and
 * every spawn binds `default_model`. The pool is gated behind the
 * `secondary-model` experiment (via `IFlagService`): while it is off the
 * `model` parameter is stripped and every spawn inherits the caller's
 * model. Configured profile routing (`[subagent.routing.<profile>]` or a
 * `[[subagent.pools.<profile>]]` route pool, resolved via
 * `ISessionSubagentRoutingService`) wins over all of these; a pool slot is
 * released once the run settles. The selected alias is
 * resolved through the model catalog before lifecycle allocation. A resumed
 * agent keeps the model recorded in its own wire journal — with per-subagent
 * models there is no "child follows the parent's current model" invariant to
 * enforce.
 *
 * Registered via the module-level `registerAgentToolService(ISubagentTool,
 * SubagentTool)` at the bottom of this file — the same "import = register"
 * pattern used by every agent tool. The per-profile tool listings in the
 * description read the full `AgentToolContribution` collection — static
 * registrations and feature-contributed tools alike — not the runtime
 * registry, which only holds tools the caller's own Profile activated,
 * plus any dynamically registered tools. The description's catalog profile list is
 * snapshotted once the session catalog has loaded and frozen for the agent's
 * lifetime: plugin install / enable / disable / remove re-contributes
 * profiles mid-session, and a live read would rewrite the tools payload of
 * every later request — breaking the provider's prompt cache for a change a
 * live agent must not see (new profiles take effect on `/new` or `/reload`).
 * Bound at Agent scope.
 */
import { type CollectionView } from '#/_base/di/collection';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import {
  isAbortError,
  isUserCancellation,
  userCancellationReason,
} from '#/_base/utils/abort';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import type { TokenUsage } from '#/kosong/contract/usage';
import {
  IAgentTaskService,
  type RegisterAgentTaskOptions,
} from '#/agent/task/task';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  isToolActive as evaluateToolActive,
  resolveActiveToolNames,
} from '#/agent/toolPolicy/evaluate';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import {
  AgentToolContribution,
  registerAgentToolService,
} from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService, type ToolReference } from '#/agent/toolRegistry/toolRegistry';
import { type AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import {
  subagentAllowlistFor,
  subagentTypeNotAllowedMessage,
} from '#/app/agentProfileCatalog/profile-shared';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { isSubagentMeta, subagentLabels, subagentParentAgentId } from '#/session/agentLifecycle/subagentMetadata';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { Runtime } from '#/runtime/runtime';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionSubagentService, type AgentRunHandle } from '#/session/subagent/subagent';
import { ISessionSubagentRoutingService } from '#/session/subagent/routingService';
import { circuitOpeningErrorCode, subagentRouteIdentity } from '#/session/subagent/circuit';
import { ISessionSubagentCircuitService } from '#/session/subagent/circuitService';
import {
  buildSubagentModelDescriptions,
  exposesSubagentModelChoice,
  formatSubagentTimeoutDescription,
  resolveSubagentBinding,
  resolveSubagentIsolationMode,
  resolveSubagentTimeoutMs,
  stripSubagentModelParameter,
  wrapSubagentModelError,
} from '#/session/subagent/configSection';
import { SECONDARY_MODEL_FLAG_ID, SUBAGENT_WORKTREE_ISOLATION_FLAG_ID } from '#/session/subagent/flag';
import { isEditingCapableCatalogProfile } from '#/agent/dispatch/profile';
import { resolveEditingDispatchScope } from '#/agent/dispatch/scope';
import { IGitService } from '#/app/git/git';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import {
  acquireSubagentWorktree,
  discardSpawnWorktree,
  isSubagentWorktreeUnsupported,
  type SubagentWorktreeFinishResult,
  type SubagentWorktreeHandle,
  type SubagentWorktreeServices,
} from '#/session/subagent/worktree';
import {
  BACKGROUND_AGENT_UNAVAILABLE,
  DEFAULT_PROFILE_NAME,
  ISubagentTool,
  RESUME_WITH_TYPE_UNAVAILABLE,
  RESUMED_LABEL,
  SUBAGENT_STOPPED_MESSAGE,
  SubagentToolInputSchema,
  USER_INTERRUPTED_SUBAGENT_MESSAGE,
  type SubagentToolInput,
} from './agent';
import { SubagentTask, type SubagentCompletion, type SubagentHandle } from './subagent-task';

import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md?raw';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md?raw';
import AGENT_DESCRIPTION_BASE from './agent.md?raw';

const SUBAGENT_TOOL_PARAMETERS = toInputJsonSchema(SubagentToolInputSchema);
const SUBAGENT_TOOL_PARAMETERS_NO_MODEL = stripSubagentModelParameter(SUBAGENT_TOOL_PARAMETERS);

export class SubagentTool implements ISubagentTool {
  declare readonly _serviceBrand: undefined;
  readonly name: string = 'Agent';

  get parameters(): Record<string, unknown> {
    return exposesSubagentModelChoice(this.config, this.flags)
      ? SUBAGENT_TOOL_PARAMETERS
      : SUBAGENT_TOOL_PARAMETERS_NO_MODEL;
  }

  private readonly callerAgentId: string;
  private readonly canRunInBackground: () => boolean;
  private catalogReady = false;
  private frozenCatalogProfiles: readonly AgentProfile[] | undefined;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @ILogService private readonly log: ILogService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ISessionSubagentRoutingService
    private readonly subagentRouting: ISessionSubagentRoutingService,
    @ISessionSubagentCircuitService
    private readonly subagentCircuit: ISessionSubagentCircuitService,
    @IGitService private readonly git: IGitService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostProcessService private readonly proc: IHostProcessService,
    @AgentToolContribution private readonly contributions: CollectionView<AgentToolContribution>,
  ) {
    this.callerAgentId = scopeContext.agentId;
    this.canRunInBackground = () =>
      this.toolPolicy.isToolActive('TaskList') &&
      this.toolPolicy.isToolActive('TaskOutput') &&
      this.toolPolicy.isToolActive('TaskStop');
    void this.catalog.ready.then(() => {
      this.catalogReady = true;
    });
  }

  get description(): string {
    const backgroundDescription = this.canRunInBackground()
      ? AGENT_BACKGROUND_DESCRIPTION
      : AGENT_BACKGROUND_DISABLED_DESCRIPTION;
    let description = `${AGENT_DESCRIPTION_BASE}\n\n${backgroundDescription}`;
    const allowlist = subagentAllowlistFor(this.catalog, this.profile.data());
    const catalogProfiles = this.catalogProfiles();
    const profiles =
      allowlist === undefined
        ? catalogProfiles
        : catalogProfiles.filter((profile) => allowlist.includes(profile.name));
    const typeLines = buildProfileDescriptions(
      profiles,
      this.knownToolReferences(),
      (profile, name, source) =>
        this.toolPolicy.isToolActiveForProfile(profile, name, source),
    );
    if (typeLines) {
      description += `\n\nAvailable agent types (pass via subagent_type):\n${typeLines}`;
    }
    const modelLines = buildSubagentModelDescriptions(
      this.config,
      this.flags,
      this.profile.data().modelAlias,
    );
    if (modelLines !== undefined) {
      description += `\n\n${modelLines}`;
    }
    return description;
  }

  private catalogProfiles(): readonly AgentProfile[] {
    if (this.frozenCatalogProfiles !== undefined) return this.frozenCatalogProfiles;
    const profiles = this.catalog.list();
    if (this.catalogReady) this.frozenCatalogProfiles = profiles;
    return profiles;
  }

  private knownToolReferences(): ToolReference[] {
    const refs = new Map<string, ToolReference>();
    for (const contribution of this.contributions.items) {
      refs.set(contribution.options.name, {
        name: contribution.options.name,
        source: contribution.options.source ?? 'builtin',
      });
    }
    for (const ref of this.toolRegistry.listReferences()) {
      if (!refs.has(ref.name)) refs.set(ref.name, ref);
    }
    return [...refs.values()];
  }

  async resolveExecution(args: SubagentToolInput): Promise<ToolExecution> {
    const requestedProfileName = args.subagent_type?.length ? args.subagent_type : undefined;
    const resumeAgentId = args.resume?.trim();

    if (
      resumeAgentId !== undefined &&
      resumeAgentId.length > 0 &&
      requestedProfileName !== undefined
    ) {
      return { output: RESUME_WITH_TYPE_UNAVAILABLE, isError: true };
    }

    const profileNameForDisplay =
      resumeAgentId !== undefined && resumeAgentId.length > 0
        ? this.resumeProfileName(resumeAgentId) ?? RESUMED_LABEL
        : requestedProfileName ?? DEFAULT_PROFILE_NAME;
    const prefix = args.run_in_background === true ? 'Launching background' : 'Launching';
    return {
      description: `${prefix} ${profileNameForDisplay} agent: ${args.description}`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'agent_call',
        agent_name: profileNameForDisplay,
        prompt: args.prompt,
        background: args.run_in_background,
      },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, profileNameForDisplay),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private resumeProfileName(agentId: string): string | undefined {
    const target = this.lifecycle.get(agentId);
    if (target === undefined) return undefined;
    return target.accessor.get(IAgentProfileService).data().profileName;
  }

  private async launch(
    args: SubagentToolInput,
    toolCallId: string,
    controller: AbortController,
    runtime: Runtime,
  ): Promise<SubagentHandle> {
    const requester = this.lifecycle.get(this.callerAgentId);
    if (requester === undefined) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_FOUND,
        `Caller agent "${this.callerAgentId}" does not exist`,
        { details: { agentId: this.callerAgentId } },
      );
    }

    const resumeAgentId = args.resume?.trim();
    const isResume = resumeAgentId !== undefined && resumeAgentId.length > 0;

    let agentId: string;
    let profileName: string;
    let displayModel: string | undefined;
    let promptText = args.prompt;
    let releasePoolSlot: (() => void) | undefined;
    let worktree: SubagentWorktreeHandle | undefined;
    // R-A2 (Case 8): records a non-retryable provider/model/route failure
    // against the resolved route's circuit (no-op for resume spawns and
    // unrouted bindings — only routed fresh spawns carry a circuit key).
    let recordCircuitFailure: (error: unknown) => void = () => {};
    if (isResume) {
      const target = this.lifecycle.get(resumeAgentId);
      if (target === undefined) {
        throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent instance "${resumeAgentId}" does not exist`, {
          details: { agentId: resumeAgentId },
        });
      }
      await this.ensureOwnedIdleSubagent(resumeAgentId, target);
      agentId = target.id;
      const resumed = target.accessor.get(IAgentProfileService).data();
      profileName = resumed.profileName ?? RESUMED_LABEL;
      displayModel = resumed.modelAlias;
    } else {
      const requestedProfileName = args.subagent_type?.length
        ? args.subagent_type
        : DEFAULT_PROFILE_NAME;
      await this.catalog.ready;
      const own = this.profile.data();
      const allowlist = subagentAllowlistFor(this.catalog, own);
      if (allowlist !== undefined && !allowlist.includes(requestedProfileName)) {
        throw new Error2(
          ErrorCodes.AGENT_TYPE_NOT_ALLOWED,
          subagentTypeNotAllowedMessage(requestedProfileName, allowlist),
          { details: { profileName: requestedProfileName, allowlist } },
        );
      }
      const profile = this.catalog.get(requestedProfileName);
      if (profile === undefined) {
        throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${requestedProfileName}"`, {
          details: { profileName: requestedProfileName },
        });
      }
      if (own.modelAlias === undefined) {
        throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Caller agent has no model bound', {
          details: { agentId: this.callerAgentId },
        });
      }
      // Profile routing (pool first, then the static routing entry) overrides
      // the secondary-model binding **per field** — design D-B5R-5: the binding
      // is always resolved first (secondary model / modelChoice / profile
      // preference stay in play), the route only overrides fields it sets.
      // The pool slot is released when the run settles (attached to
      // `completion` below) or immediately when the spawn fails before that.
      const spawnRoute = await this.subagentRouting.resolveSpawnRoute(
        requestedProfileName,
        controller.signal,
      );
      releasePoolSlot = spawnRoute?.releasePoolSlot;
      // A non-retryable provider/model/route failure opens the circuit for
      // the resolved route, so the next spawn through this key skips straight
      // to the user-approved fallback chain. Transient failures (rate limit,
      // connection) and user cancellations never record — see
      // circuitOpeningErrorCode.
      recordCircuitFailure = (error: unknown): void => {
        if (spawnRoute === undefined) return;
        const code = circuitOpeningErrorCode(error);
        if (code !== undefined) {
          this.subagentCircuit.openCircuit(
            spawnRoute.circuitKey,
            subagentRouteIdentity(spawnRoute.route),
            code,
          );
        }
      };
      try {
        const binding = resolveSubagentBinding(
          this.config,
          this.flags,
          { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
          args.model,
        );
        const final =
          spawnRoute === undefined
            ? binding
            : {
                model: spawnRoute.route.modelAlias ?? binding.model,
                thinking: spawnRoute.route.thinkingEffort ?? binding.thinking,
              };
        const editingScope = resolveEditingDispatchScope(
          isEditingCapableCatalogProfile(profile),
          args.dispatch?.scope,
        );
        if (!editingScope.ok) {
          throw new Error(`Dispatch rejected (${editingScope.error}-scope): ${editingScope.message}`);
        }
        let created: IAgentScopeHandle;
        try {
          this.modelCatalog.get(final.model);
          if (
            this.flags.enabled(SUBAGENT_WORKTREE_ISOLATION_FLAG_ID) &&
            isEditingCapableCatalogProfile(profile)
          ) {
            worktree = (await this.acquireIsolatedWorktree(editingScope.value, profile.name)) ?? undefined;
          }
          created = await this.lifecycle.create({
            binding: {
              profile: profile.name,
              model: final.model,
              thinking: final.thinking,
            },
            labels: subagentLabels(this.callerAgentId),
            workspaceCwd: worktree?.cwd,
            runtimeId: runtime.identity.runtimeId,
          });
        } catch (error) {
          throw wrapSubagentModelError(error, final.model, own.modelAlias);
        }
        created.accessor.get(IAgentPermissionModeService).setMode(this.permissionMode.mode);
        created.accessor
          .get(IAgentUserToolService)
          .inheritUserTools(requester.accessor.get(IAgentUserToolService));
        agentId = created.id;
        profileName = profile.name;
        // `final.model`, not `binding.model`: a [subagent.routing.<profile>]
        // route overrides the binding, and the label has to name the model the
        // subagent actually runs on.
        displayModel = final.model;
        promptText = await applyProfilePromptPrefix(profile, args.prompt, {
          cwd: this.workspace.workDir,
          process: runtime.process!,
          log: this.log,
        });
      } catch (error) {
        await discardSpawnWorktree(worktree);
        worktree = undefined;
        recordCircuitFailure(error);
        releasePoolSlot?.();
        releasePoolSlot = undefined;
        throw error;
      }
    }

    const runInBackground = args.run_in_background === true;
    emitAgentRunSpawned(requester, agentId, {
      profileName,
      parentToolCallId: toolCallId,
      description: args.description,
      runInBackground,
      model: displayModel,
    });

    let run: AgentRunHandle;
    try {
      run = await this.subagents.run(
        agentId,
        { kind: 'prompt', prompt: promptText },
        { signal: controller.signal },
      );
    } catch (error) {
      await discardSpawnWorktree(worktree);
      worktree = undefined;
      recordCircuitFailure(error);
      releasePoolSlot?.();
      releasePoolSlot = undefined;
      throw error;
    }
    const mirrored = mirrorAgentRun(requester, run, {
      profileName,
      prompt: promptText,
      signal: controller.signal,
      cancel: (reason) => {
        controller.abort(reason);
      },
    });
    const completion = mirrored.then(
      async (r) => {
        if (worktree === undefined) return { result: r.summary, usage: r.usage };
        const finishResult = await worktree.finish({ kind: 'success' });
        return this.completeWithWorktree(r, finishResult);
      },
      async (error: unknown) => {
        if (worktree !== undefined) {
          await worktree
            .finish({ kind: 'incomplete', reason: errorMessage(error) })
            .catch(() => {});
        }
        recordCircuitFailure(error);
        throw error;
      },
    );
    // Read once: both return paths report it, and the pooled path releases its
    // slot on settle, by which point the agent scope may already be gone.
    const thinkingEffort = this.lifecycle
      .get(agentId)
      ?.accessor.get(IAgentProfileService)
      .getEffectiveThinkingLevel();
    if (releasePoolSlot === undefined) {
      return { agentId, profileName, model: displayModel, thinkingEffort, completion };
    }
    const release = releasePoolSlot;
    return {
      agentId,
      profileName,
      parentToolCallId: toolCallId,
      model: displayModel,
      thinkingEffort,
      completion: completion.then(
        (settled) => {
          release();
          return settled;
        },
        (error: unknown) => {
          release();
          throw error;
        },
      ),
    };
  }

  private async acquireIsolatedWorktree(
    scope: readonly string[],
    profileName: string,
  ): Promise<SubagentWorktreeHandle | null> {
    const services: SubagentWorktreeServices = {
      git: this.git,
      fs: this.fs,
      proc: this.proc,
      log: this.log,
    };
    const acquisition = await acquireSubagentWorktree(services, this.workspace.workDir, {
      scope,
    });
    if (isSubagentWorktreeUnsupported(acquisition)) {
      if (resolveSubagentIsolationMode(this.config) === 'strict') {
        throw new Error(
          `Editing subagent isolation is unavailable here: ${acquisition.unsupported}. Dispatch was refused.`,
        );
      }
      this.log.warn('subagent worktree: dispatching without isolation', {
        cwd: this.workspace.workDir,
        profile: profileName,
        reason: acquisition.unsupported,
      });
      return null;
    }
    if (acquisition === null) {
      throw new Error('Editing subagent isolation could not be created; dispatch was refused.');
    }
    return acquisition;
  }

  private completeWithWorktree(
    r: { readonly summary: string; readonly usage?: TokenUsage },
    finishResult: SubagentWorktreeFinishResult,
  ): SubagentCompletion {
    if (finishResult.applied) return { result: r.summary, usage: r.usage };
    if (finishResult.reason === 'scope-expansion-required' && finishResult.candidate !== undefined) {
      return {
        result: r.summary,
        usage: r.usage,
        editingCandidate: {
          draft: finishResult.candidate,
          acknowledgePersisted: finishResult.acknowledgePersisted,
        },
      };
    }
    const recovery =
      finishResult.recoveryPath === undefined
        ? ''
        : ` Recovery data preserved at ${finishResult.recoveryPath}.`;
    throw new Error(
      `Editing subagent changes were not applied: ${finishResult.reason ?? 'unknown reason'}${recovery}`,
    );
  }

  private async ensureOwnedIdleSubagent(
    agentId: string,
    target: IAgentScopeHandle,
  ): Promise<void> {    const meta = (await this.sessionMetadata.read()).agents?.[agentId];
    if (!isSubagentMeta(meta)) {
      throw new Error2(ErrorCodes.AGENT_NOT_A_SUBAGENT, `Agent instance "${agentId}" is not a subagent`, {
        details: { agentId },
      });
    }
    if (subagentParentAgentId(meta) !== this.callerAgentId) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_OWNED,
        `Agent instance "${agentId}" does not belong to this parent agent`,
        { details: { agentId, callerAgentId: this.callerAgentId } },
      );
    }
    if (target.accessor.get(IAgentLoopService).status().state === 'running') {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_RUNNING,
        `Agent instance "${agentId}" is already running and cannot run concurrently`,
        { details: { agentId } },
      );
    }
  }

  private async execution(
    args: SubagentToolInput,
    { toolCallId, signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      signal.throwIfAborted();
      const runInBackground = args.run_in_background === true;
      const requestedProfileName = args.subagent_type?.length ? args.subagent_type : undefined;
      const resumeAgentId = args.resume?.trim();
      const isResume = resumeAgentId !== undefined && resumeAgentId.length > 0;

      if (isResume && requestedProfileName !== undefined) {
        return { output: RESUME_WITH_TYPE_UNAVAILABLE, isError: true };
      }

      const allowBackground = this.canRunInBackground();
      if (runInBackground && !allowBackground) {
        return { output: BACKGROUND_AGENT_UNAVAILABLE, isError: true };
      }
      const timeoutMs = resolveSubagentTimeoutMs(this.config);
      const runtimeLease = this.runtime.acquire(['process']);

      const controller = new AbortController();
      const abortBeforeRegister = (): void => {
        controller.abort(signal.reason);
      };
      if (!runInBackground) {
        signal.addEventListener('abort', abortBeforeRegister, { once: true });
      }

      let handle: SubagentHandle;
      try {
        handle = await this.launch(args, toolCallId, controller, runtimeLease.runtime);
      } catch (error) {
        signal.removeEventListener('abort', abortBeforeRegister);
        this.log.warn('subagent launch failed', {
          toolCallId,
          runInBackground,
          operation: isResume ? 'resume' : 'spawn',
          subagentType: requestedProfileName ?? DEFAULT_PROFILE_NAME,
          resumeAgentId: isResume ? resumeAgentId : undefined,
          error,
        });
        throw error;
      } finally {
        runtimeLease.dispose();
      }

      let taskId: string;
      try {
        const registerOptions: RegisterAgentTaskOptions = {
          detached: runInBackground,
          timeoutMs,
          signal: runInBackground ? undefined : signal,
        };
        taskId = this.tasks.registerTask(
          new SubagentTask(handle, args.description, controller),
          registerOptions,
        );
        signal.removeEventListener('abort', abortBeforeRegister);
      } catch (error) {
        controller.abort();
        void handle.completion.catch(() => {});
        signal.removeEventListener('abort', abortBeforeRegister);
        this.log?.warn('background agent task registration failed', {
          toolCallId,
          agentId: handle.agentId,
          subagentType: handle.profileName,
          error,
        });
        const message = error instanceof Error ? error.message : String(error);
        return {
          output:
            isError2(error) && error.code === ErrorCodes.TASK_LIMIT_EXCEEDED
              ? 'Too many background tasks are already running.'
              : message,
          isError: true,
        };
      }

      if (runInBackground) {
        return {
          output: formatBackgroundAgentResult(taskId, handle, args.description, allowBackground),
        };
      }

      const release = await this.tasks.waitForForegroundRelease(taskId);
      if (release === 'detached') {
        return {
          output: formatBackgroundAgentResult(taskId, handle, args.description, allowBackground),
        };
      }
      return await this.formatForegroundResult(taskId, handle, timeoutMs);
    } catch (error) {
      return { output: `subagent error: ${launchErrorMessage(error, signal)}`, isError: true };
    }
  }

  private async formatForegroundResult(
    taskId: string,
    handle: SubagentHandle,
    timeoutMs: number,
  ): Promise<ExecutableToolResult> {
    const info = this.tasks.getTask(taskId);
    if (info?.status === 'completed') {
      return {
        output: formatForegroundAgentSuccess(handle, await this.tasks.readOutput(taskId)),
      };
    }
    if (info?.status === 'input_required' && info.kind === 'agent' && info.candidate !== undefined) {
      return {
        output: formatForegroundInputRequired(taskId, handle, info.candidate),
        isError: false,
      };
    }
    if (info?.status === 'expansion_denied') {
      return {
        output: formatForegroundAgentFailure(
          handle,
          'The scope expansion was denied; the subagent work candidate was discarded. Re-dispatch with an explicitly wider dispatch.scope if the change is still wanted.',
          false,
        ),
        isError: true,
      };
    }
    const timedOut = info?.status === 'timed_out';
    const message = timedOut
      ? `Agent timed out after ${formatSubagentTimeoutDescription(timeoutMs)}.`
      : formatSubagentStoppedMessage(info?.stopReason);
    return {
      output: formatForegroundAgentFailure(handle, message, timedOut),
      isError: true,
    };
  }
}

function formatForegroundInputRequired(
  taskId: string,
  handle: SubagentHandle,
  candidate: { readonly hash: string; readonly requestedScope: readonly string[]; readonly paths: readonly string[] },
): string {
  return [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'status: input_required',
    `task_id: ${taskId}`,
    `candidate_hash: ${candidate.hash}`,
    `requested_scope: ${JSON.stringify(candidate.requestedScope)}`,
    '',
    'The subagent finished but touched paths outside its declared scope:',
    ...candidate.paths.map((path) => `- ${path}`),
    '',
    'Its work is preserved as a durable candidate and has NOT been applied.',
    `Inspect it with TaskOutput(task_id="${taskId}"), then either apply it with TaskOutput(task_id="${taskId}", action="approve_scope_expansion", candidate_hash="${candidate.hash}", requested_scope=${JSON.stringify(candidate.requestedScope)}) or discard it with action="deny_scope_expansion".`,
  ].join('\n');
}

registerAgentToolService(ISubagentTool, SubagentTool, {
  name: 'Agent',
  domain: 'subagent',
  requiredRuntimeCapabilities: ['process'],
});

function buildProfileDescriptions(
  profiles: readonly AgentProfile[],
  tools: readonly ToolReference[],
  isToolActive: (
    profile: { readonly tools?: readonly string[]; readonly disallowedTools?: readonly string[] },
    name: string,
    source: ToolReference['source'],
  ) => boolean,
): string {
  return profiles
    .map((profile) => {
      const details = [profile.description, profile.whenToUse].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const header = details.length === 0 ? `- ${profile.name}` : `- ${profile.name}: ${details.join(' ')}`;
      const activeTools = resolveActiveToolNames(profile);
      const externallyRestricted = tools.some(
        (tool) =>
          evaluateToolActive(profile, tool.name, tool.source) &&
          !isToolActive(profile, tool.name, tool.source),
      );
      if (externallyRestricted) {
        const effectiveTools = tools
          .filter((tool) => isToolActive(profile, tool.name, tool.source))
          .map((tool) => tool.name);
        if (effectiveTools.length === 0) {
          return `${header}\n  Tools: none`;
        }
        return `${header}\n  Tools: ${effectiveTools.join(', ')}`;
      }
      if (activeTools === undefined) {
        if ((profile.disallowedTools?.length ?? 0) > 0) {
          return `${header}\n  Tools: all except ${profile.disallowedTools!.join(', ')}`;
        }
        return `${header}\n  Tools: all`;
      }
      if (activeTools.length === 0) {
        return `${header}\n  Tools: none`;
      }
      return `${header}\n  Tools: ${activeTools.join(', ')}`;
    })
    .join('\n');
}

function formatBackgroundAgentResult(
  taskId: string,
  handle: SubagentHandle,
  description: string,
  allowBackground: boolean,
): string {
  return [
    `task_id: ${taskId}`,
    'status: running',
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'automatic_notification: true',
    '',
    `description: ${description}`,
    '',
    allowBackground
      ? `next_step: The completion arrives automatically in a later turn — do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user. (If you have nothing to do until it finishes, run such tasks in the foreground next time.)`
      : 'next_step: The completion arrives automatically in a later turn.',
    `resume_hint: To continue or recover this same subagent later, call Agent(resume="${handle.agentId}", prompt="..."). The parameter is agent_id ("${handle.agentId}"), NOT task_id ("${taskId}") or source_id from a later <notification>. Recovery cases: a later <notification type="task.lost" | "task.failed" | "task.killed"> for this subagent — its conversation history is preserved across session restarts and resume will pick it up.`,
  ].join('\n');
}

function formatForegroundAgentSuccess(handle: SubagentHandle, result: string): string {
  return [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'status: completed',
    '',
    '[summary]',
    result,
  ].join('\n');
}

function formatForegroundAgentFailure(
  handle: SubagentHandle,
  message: string,
  timedOut: boolean,
): string {
  const lines = [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'status: failed',
    '',
    `subagent error: ${message}`,
  ];
  if (timedOut) {
    lines.push(
      `resume_hint: Continue with Agent(resume="${handle.agentId}", prompt="continue"). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost.`,
    );
  }
  return lines.join('\n');
}

function launchErrorMessage(error: unknown, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) return USER_INTERRUPTED_SUBAGENT_MESSAGE;
  if (isAbortError(error)) return formatSubagentStoppedMessage(errorMessage(signal.reason));
  return error instanceof Error ? error.message : String(error);
}

function formatSubagentStoppedMessage(reason: string | undefined): string {
  const normalized = reason?.trim();
  if (normalized === userCancellationReason().message) return USER_INTERRUPTED_SUBAGENT_MESSAGE;
  if (normalized === undefined || normalized.length === 0) return SUBAGENT_STOPPED_MESSAGE;
  return `${SUBAGENT_STOPPED_MESSAGE} Reason: ${normalized}`;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return undefined;
}
