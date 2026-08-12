/**
 * Scenario: media tool registration follows the bound model — the registrar
 * re-registers `ReadMediaFile` when the model alias or media capabilities
 * change, and a model alias that fails to resolve keeps the previous
 * registration with an uncommitted key so the next refresh retries instead
 * of silently installing degraded media behavior.
 *
 * Wiring: real AgentMediaToolsRegistrar with stubbed profile, model catalog,
 * tool registry, and log/event/wire services. Run:
 * pnpm test -- test/agent/media/mediaToolsRegistrar.test.ts
 */

import { SyncDescriptor } from '#/_base/di/descriptors';
import { toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IAgentMediaToolsRegistrar } from '#/agent/media/mediaTools';
import {
  AgentMediaToolsRegistrar,
  mediaRegisteredKeyKey,
} from '#/agent/media/mediaToolsRegistrar';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ModelCapability } from '#/kosong/contract/capability';
import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import { Error2 } from '#/errors';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IWireService } from '#/wire/wire';
import { describe, expect, it, vi } from 'vitest';

import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

const MEDIA_CAPABILITIES: ModelCapability = {
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: false,
  max_context_tokens: 1000,
};

function wireModel(): Model {
  return {
    id: 'm',
    name: 'wire-model',
    aliases: [],
    protocol: 'anthropic',
    baseUrl: 'https://example.test',
    headers: {},
    capabilities: MEDIA_CAPABILITIES,
    maxContextSize: 1000,
    alwaysThinking: false,
    providerName: 'p',
    authProvider: { getAuth: async () => undefined },
  };
}

function createRegistrar(options: {
  readonly modelAlias?: string;
  readonly resolveRequester: (id: string) => ModelRequester;
}) {
  const modelAlias = options.modelAlias ?? 'alias';
  const getRequester = vi.fn<IModelCatalog['getRequester']>(options.resolveRequester);
  const registerTool = vi.fn(() => toDisposable(() => {}));
  const logError = vi.fn();
  const refreshHandlers: Array<() => void> = [];
  const telemetryRecords: TelemetryRecord[] = [];
  const eventBus = {
    _serviceBrand: undefined,
    publish: () => undefined,
    subscribe: (event: string, handler: () => void) => {
      if (event === 'agent.status.updated') refreshHandlers.push(handler);
      return toDisposable(() => {});
    },
  } as unknown as IEventBus;
  const wire = {
    hooks: { onDidRestore: { register: () => toDisposable(() => {}) } },
  } as unknown as IWireService;
  const states = new AgentStateService();

  const ix = new TestInstantiationService();
  ix.stub(IAgentToolRegistryService, { register: registerTool, list: () => [] });
  ix.stub(IAgentProfileService, {
    getModel: () => modelAlias,
    getModelCapabilities: () => MEDIA_CAPABILITIES,
  });
  ix.stub(IModelCatalog, { getRequester });
  ix.stub(ILogService, { error: logError });
  ix.stub(IEventBus, eventBus);
  ix.stub(IWireService, wire);
  ix.stub(ITelemetryService, recordingTelemetry(telemetryRecords));
  ix.stub(IHostFileSystem, {} as unknown as IHostFileSystem);
  ix.stub(IHostEnvironment, {} as unknown as IHostEnvironment);
  ix.stub(ISessionWorkspaceContext, {} as unknown as ISessionWorkspaceContext);
  ix.stub(ISessionSkillCatalog, {
    catalog: { getSkillRoots: () => [] },
  } as unknown as ISessionSkillCatalog);
  ix.set(IAgentStateService, states);
  ix.set(IAgentMediaToolsRegistrar, new SyncDescriptor(AgentMediaToolsRegistrar));

  return {
    registrar: ix.get(IAgentMediaToolsRegistrar),
    getRequester,
    registerTool,
    logError,
    states,
    fireRefresh: () => {
      for (const handler of refreshHandlers) handler();
    },
  };
}

describe('AgentMediaToolsRegistrar', () => {
  it('keeps the key uncommitted on a missing model and retries on the next refresh', () => {
    const missing = new Error2(
      CONFIG_INVALID_ERROR_CODE,
      'Model "ghost" is not configured in config.toml.',
    );
    const ctx = createRegistrar({
      modelAlias: 'ghost',
      resolveRequester: () => {
        throw missing;
      },
    });

    expect(ctx.getRequester).toHaveBeenCalledWith('ghost');
    expect(ctx.registerTool).not.toHaveBeenCalled();
    expect(ctx.states.get(mediaRegisteredKeyKey)).toBeUndefined();
    expect(ctx.logError).not.toHaveBeenCalled();

    const requester = { model: wireModel() } as unknown as ModelRequester;
    ctx.getRequester.mockImplementation(() => requester);
    ctx.fireRefresh();

    expect(ctx.getRequester).toHaveBeenCalledTimes(2);
    expect(ctx.registerTool).toHaveBeenCalledTimes(1);
    expect(ctx.states.get(mediaRegisteredKeyKey)).toBe('ghost|true|false');
  });

  it('logs unexpected resolution failures and keeps the key uncommitted', () => {
    const boom = new Error('boom');
    const ctx = createRegistrar({
      modelAlias: 'ghost',
      resolveRequester: () => {
        throw boom;
      },
    });

    expect(ctx.logError).toHaveBeenCalledWith(
      expect.stringContaining('"ghost"'),
      expect.objectContaining({ error: boom }),
    );
    expect(ctx.registerTool).not.toHaveBeenCalled();
    expect(ctx.states.get(mediaRegisteredKeyKey)).toBeUndefined();
  });

  it('commits the key and registers the tool once resolution succeeds', () => {
    const requester = { model: wireModel() } as unknown as ModelRequester;
    const ctx = createRegistrar({
      modelAlias: 'alias',
      resolveRequester: () => requester,
    });

    expect(ctx.getRequester).toHaveBeenCalledWith('alias');
    expect(ctx.registerTool).toHaveBeenCalledTimes(1);
    expect(ctx.states.get(mediaRegisteredKeyKey)).toBe('alias|true|false');

    ctx.fireRefresh();
    expect(ctx.getRequester).toHaveBeenCalledTimes(1);
    expect(ctx.registerTool).toHaveBeenCalledTimes(1);
  });
});
