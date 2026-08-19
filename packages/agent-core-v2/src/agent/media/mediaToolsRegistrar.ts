/**
 * Media tool production registration — the Agent-scope service that keeps
 * `ReadMediaFile` in the tool registry in sync with the bound model.
 *
 * Media tools cannot ride the module-level `registerAgentToolService(...)`
 * contribution table: its activation runs when the Agent is created, and at
 * that point no model is bound yet — the capabilities are still
 * `UNKNOWN_CAPABILITY`, so a capability gate would permanently skip the
 * tool. Registration instead re-runs whenever the resolved model changes:
 * every live profile/model update publishes `agent.status.updated`, while
 * `dispatcher.hooks.onDidRestore` refreshes once after silent resume replay. This
 * service re-invokes {@link registerMediaTools} when the model alias or its
 * media capabilities differ from what it last registered (rebinding the
 * video uploader to the new model, and dropping the tool when the model
 * loses media input). The `inlineVideoSupported` flag rides the same
 * refresh: it is derived from the model's protocol because only the OpenAI
 * family drops inline video on the wire — every other protocol that
 * converts `video_url` takes the inline fallback when no upload hook
 * exists. A model alias that fails to resolve keeps the previous
 * registration and an uncommitted key, so the next refresh retries instead
 * of installing degraded media behavior; unexpected resolution failures are
 * logged through `log`.
 *
 * The plain-data state (`registeredKey`) is registered into `agentState`
 * (`IAgentStateService`) and read/written through it; `registration` stays an
 * instance field (the live `IDisposable` tool-registration handle, not plain
 * data).
 */
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { ILogService } from '#/_base/log/log';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { type ModelRequester } from '#/kosong/model/modelRequester';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { extendWorkspaceWithSkillRoots } from '#/tool/path-access';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { isCodedError } from '#/errors';
import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';

import { IAgentMediaToolsRegistrar } from './mediaTools';
import { createVideoUploader, registerMediaTools } from './registerMediaTools';

export const mediaRegisteredKeyKey = defineState<string | undefined>(
  'media.registeredKey',
  () => undefined as string | undefined,
);

export class AgentMediaToolsRegistrar extends Service implements IAgentMediaToolsRegistrar {
  declare readonly _serviceBrand: undefined;

  private registration: IDisposable | undefined;

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IEventBus eventBus: IEventBus,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly log: ILogService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {
    super();
    this.states.contributeState(mediaRegisteredKeyKey);
    this.refresh();
    this._register(
      this.dispatcher.hooks.onDidRestore.register('media', async (_ctx, next) => {
        this.refresh();
        await next();
      }),
    );
    this._register(eventBus.subscribe(AgentStatusUpdated, () => this.refresh()));
    this._register(this.runtime.onDidChange(() => this.refresh()));
    this._register(toDisposable(() => this.registration?.dispose()));
  }

  private get registeredKey(): string | undefined {
    return this.states.get(mediaRegisteredKeyKey);
  }

  private set registeredKey(value: string | undefined) {
    this.states.set(mediaRegisteredKeyKey, value);
  }

  private refresh(): void {
    const capabilities = this.profile.getModelCapabilities();
    const modelAlias = this.profile.getModel();
    if (!this.runtime.isAvailable(['fs'])) {
      const key = [
        modelAlias,
        String(capabilities.image_in),
        String(capabilities.video_in),
        'runtime-unavailable',
      ].join('|');
      if (key === this.registeredKey) return;
      this.registeredKey = key;
      this.registration?.dispose();
      this.registration = undefined;
      return;
    }
    const inspected = this.runtime.inspect();
    const identityKey = [
      inspected.identity.workspaceId,
      inspected.identity.runtimeId,
      inspected.identity.generation,
    ].join('|');
    const key = [
      modelAlias,
      String(capabilities.image_in),
      String(capabilities.video_in),
      identityKey,
      inspected.status,
      inspected.environment.pathClass,
      String(inspected.capabilities.has('fs')),
    ].join('|');
    if (key === this.registeredKey) return;
    const workspaceCtx = this.workspaceCtx;
    const skillCatalog = this.skillCatalog;
    const runtime = this.runtime;
    const pathClass = inspected.environment.pathClass;
    let requester: ModelRequester | undefined;
    let model: Model | undefined;
    if (modelAlias !== '') {
      try {
        requester = this.modelCatalog.getRequester(modelAlias);
        model = requester.model;
      } catch (error) {
        // Keep the previous registration and the uncommitted key so the next
        // refresh retries instead of installing degraded media behavior.
        if (!isExpectedMissingModelError(error)) {
          this.log.error(
            `Failed to resolve model "${modelAlias}" for media tool registration.`,
            { error },
          );
        }
        return;
      }
    }
    this.registeredKey = key;
    this.registration?.dispose();
    this.registration = registerMediaTools(this.toolRegistry, {
      runtime,
      workspace: {
        get workspaceDir() {
          return workspaceCtx.workDir;
        },
        get additionalDirs() {
          return extendWorkspaceWithSkillRoots(
            { workspaceDir: workspaceCtx.workDir, additionalDirs: workspaceCtx.additionalDirs },
            skillCatalog?.catalog.getSkillRoots() ?? [],
            pathClass,
          ).additionalDirs;
        },
      },
      capabilities,
      videoUploader: createVideoUploader(requester, {
        client: this.telemetry,
        props: {
          model: modelAlias,
          provider_type: model?.providerType ?? model?.protocol,
          protocol: model?.protocol,
        },
      }),
      inlineVideoSupported: model?.protocol !== 'openai' && model?.protocol !== 'openai_responses',
      telemetry: this.telemetry,
    });
  }
}

function isExpectedMissingModelError(error: unknown): boolean {
  return isCodedError(error) && error.code === CONFIG_INVALID_ERROR_CODE;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMediaToolsRegistrar,
  AgentMediaToolsRegistrar,
  ScopeActivation.OnScopeCreated,
  'media',
);
