/**
 * Scenario: progressive tool disclosure shapes the provider-visible tool view,
 * dynamic history, selection results, executor interception, and announcements.
 *
 * Responsibilities: assert the gate contract, profile-active filtering,
 * loadable/loaded MCP settlement, and the select_tools built-in behavior.
 * Wiring: real toolSelect, registry, announcement sidecar, system reminder,
 * and hook slots with fake loop/context memory/profile/flag/event services;
 * executor tests use the real executor with telemetry and truncation stubs.
 * Run: ../../node_modules/.bin/vitest run test/toolSelect/toolSelectService.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { createServices, type ServiceRegistration, type TestInstantiationService } from '#/_base/di/test';
import { OrderedHookSlot } from '#/hooks';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2, Event2Class } from '#/app/event/event2';
import { IFlagService } from '#/app/flag/flag';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ToolCall } from '#/kosong/contract/message';
import { createCompactionSummaryMessage } from '#/agent/contextMemory/compactionHandoff';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import type { UndoCut } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { LoopRecordedEvent } from '#/agent/contextMemory/loopEventFold';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { AgentContextInjectorService } from '#/agent/contextInjector/contextInjectorService';
import { CompactionCompleted } from '#/agent/fullCompaction/compactionOps';
import {
  IAgentLoopService,
  type AfterStepContext,
  type BeforeStepContext,
  type EnqueueReceipt,
  type LoopRunResult,
  type StepEnqueueOptions,
  type Turn,
} from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import type { StepRequest } from '#/agent/loop/stepRequest';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import type {
  ExecutableTool,
  ToolDisclosure,
  ToolExecution,
} from '#/tool/toolContract';
import { IAgentToolExecutorService, type ToolExecutionResult } from '#/agent/toolExecutor/toolExecutor';
import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { DYNAMIC_TOOL_SCHEMA_VARIANT, LOADABLE_TOOLS_VARIANT } from '#/agent/toolSelect/dynamicTools';
import { TOOL_SELECT_FLAG_ID } from '#/agent/toolSelect/flag';
import { IAgentToolSelectService, SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import { IAgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncements';
import { AgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncementsService';
import { IAgentToolSelectSchemasService } from '#/agent/toolSelect/toolSelectSchemas';
import { AgentToolSelectSchemasService } from '#/agent/toolSelect/toolSelectSchemasService';
import { AgentToolSelectService } from '#/agent/toolSelect/toolSelectService';
import { SelectToolsTool } from '#/agent/tools/select-tools/selectToolsTool';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  composeLeanCapability,
  LEAN_MODE_TOOL_NAMES,
} from '#/agent/toolSelect/minimalCatalogue';
import { IWireService } from '#/wire/wire';
import { ILogService } from '#/_base/log/log';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { registerLogServices } from '../../_base/log/stubs';
import { recordingTelemetry } from '../../app/telemetry/stubs';
import { registerStateServices } from '../../state/stubs';
import { stubToolExecutor, stubWire } from '../loop/stubs';
import { registerToolResultTruncationServices } from '../toolResultTruncation/stubs';

const MCP_ALPHA = 'mcp__srv__alpha';
const MCP_BETA = 'mcp__srv__beta';
const MCP_GAMMA = 'mcp__srv__gamma';
const MCP_GONE = 'mcp__srv__gone';
const MINIMAL_SHELL = 'mcp__lean-ctx__ctx_shell';
const MINIMAL_READ = 'mcp__lean-ctx__ctx_read';
const MINIMAL_SEARCH = 'mcp__lean-ctx__ctx_search';
const MINIMAL_PATCH = 'mcp__lean-ctx__ctx_patch';
const OFF_CATALOGUE = 'Write';
const USER_DEFERRED = 'dashboard_create';
const USER_INLINE = 'echo_inline';
const REQUIRED_PAYLOAD_PARAMETERS = {
  type: 'object',
  required: ['payload'],
  properties: { payload: { type: 'string' } },
  additionalProperties: false,
};

let disposables: DisposableStore;
let capabilities: ModelCapability;
let flagEnabled: boolean;
let activeToolNames: ReadonlySet<string> | undefined;
let disclosureToolActive: boolean;

beforeEach(() => {
  disposables = new DisposableStore();
  capabilities = makeCapabilities({ tool_use: true, dynamically_loaded_tools: true });
  flagEnabled = false;
  activeToolNames = undefined;
  disclosureToolActive = true;
});

afterEach(() => disposables.dispose());

function makeCapabilities(overrides: {
  readonly tool_use?: boolean;
  readonly dynamically_loaded_tools?: boolean;
  readonly minimal_mode?: boolean;
} = {}): ModelCapability {
  return {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: overrides.tool_use ?? false,
    max_context_tokens: 128_000,
    dynamically_loaded_tools: overrides.dynamically_loaded_tools,
    minimal_mode: overrides.minimal_mode,
  };
}

function toolCall(id: string, name: string, args: unknown = {}): ToolCall {
  return { type: 'function', id, name, arguments: JSON.stringify(args) };
}

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function assistantMessage(text: string): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

function inFlightAssistantMessage(): ContextMessage {
  return { role: 'assistant', content: [], toolCalls: [] };
}

function schemaMessage(...names: string[]): ContextMessage {
  return {
    role: 'system',
    content: [],
    toolCalls: [],
    tools: names.map((name) => ({ name, description: `${name} desc`, parameters: {} })),
    origin: { kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT },
  };
}

class StubMcpTool implements ExecutableTool<Record<string, unknown>> {
  readonly description: string;
  calls = 0;
  readonly parameters: Record<string, unknown>;

  constructor(
    readonly name: string,
    private readonly output: string = 'mcp ok',
    parameters?: Record<string, unknown>,
  ) {
    this.description = `${name} desc`;
    this.parameters = parameters ?? {
      type: 'object',
      additionalProperties: true,
    };
  }

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => {
        this.calls += 1;
        return { output: this.output };
      },
    };
  }
}

class EchoTool implements ExecutableTool<Record<string, unknown>> {
  readonly description = 'Echo input text.';
  readonly parameters: Record<string, unknown> = { type: 'object', additionalProperties: true };
  calls = 0;

  constructor(readonly name = 'Echo') {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => {
        this.calls += 1;
        return { output: 'echo ok' };
      },
    };
  }
}

class RecordingEventBus implements IEventBus {
  readonly _serviceBrand = undefined;
  private readonly typedHandlers = new Map<string, Array<(event: Event2) => void>>();
  private readonly allHandlers: Array<(event: Event2) => void> = [];
  readonly published: Event2[] = [];

  publish(event: Event2): void {
    this.published.push(event);
    for (const handler of this.allHandlers) handler(event);
    for (const handler of this.typedHandlers.get(event.type) ?? []) handler(event);
  }

  subscribe(
    typeOrHandler: string | Event2Class | ((event: Event2) => void),
    maybeHandler?: (event: Event2) => void,
  ) {
    if (typeof typeOrHandler === 'function' && !('type' in typeOrHandler)) {
      const handler = typeOrHandler as (event: Event2) => void;
      this.allHandlers.push(handler);
      return toDisposable(() => {
        const index = this.allHandlers.indexOf(handler);
        if (index >= 0) this.allHandlers.splice(index, 1);
      });
    }
    const type = typeof typeOrHandler === 'string' ? typeOrHandler : (typeOrHandler as Event2Class).type;
    const list = this.typedHandlers.get(type) ?? [];
    const handler = maybeHandler!;
    list.push(handler);
    this.typedHandlers.set(type, list);
    return toDisposable(() => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    });
  }
}

class FakeLoopService implements IAgentLoopService {
  readonly _serviceBrand = undefined;

  readonly hooks: IAgentLoopService['hooks'] = {
    onWillBeginStep: new OrderedHookSlot<BeforeStepContext>(),
    onDidFinishStep: new OrderedHookSlot<AfterStepContext>(),
  };

  cancelFromUser(): void {}

  enqueue(_request: StepRequest, _options?: StepEnqueueOptions): EnqueueReceipt {
    throw new Error('unused in this suite');
  }

  async run(): Promise<LoopRunResult> {
    throw new Error('unused in this suite');
  }

  status() {
    return { state: 'idle' as const, pendingTurnIds: [], hasPendingRequests: false };
  }

  cancel(_turnId?: number, _reason?: unknown): boolean {
    throw new Error('unused in this suite');
  }

  tryAcquireQuiescence(): IDisposable | undefined {
    return toDisposable(() => {});
  }

  hasPendingRequests(): boolean {
    return false;
  }

  async settled(): Promise<void> {}

  registerLoopErrorHandler(): IDisposable {
    throw new Error('unused in this suite');
  }
}

class FakeContextMemory implements IAgentContextMemoryService {
  readonly _serviceBrand = undefined;
  readonly history: ContextMessage[] = [];
  readonly appended: ContextMessage[] = [];

  get(): readonly ContextMessage[] {
    return this.history;
  }

  append(...messages: readonly ContextMessage[]): void {
    this.appended.push(...messages);
  }

  appendLoopEvent(_event: LoopRecordedEvent): void {
    throw new Error('unused in this suite');
  }

  publishTrailingRemoval(): boolean {
    return false;
  }

  clear(): void {
    this.history.length = 0;
    this.appended.length = 0;
  }

  undo(): UndoCut {
    throw new Error('unused in this suite');
  }

  applyCompaction(): never {
    throw new Error('unused in this suite');
  }

  landAppended(): void {
    this.history.push(...this.appended);
    this.appended.length = 0;
  }

  landAnnouncement(content: string): void {
    this.history.push({
      role: 'user',
      content: [{ type: 'text', text: `<system-reminder>\n${content.trim()}\n</system-reminder>` }],
      toolCalls: [],
      origin: { kind: 'system_trigger', name: LOADABLE_TOOLS_VARIANT },
    });
  }
}

interface Harness {
  readonly ix: TestInstantiationService;
  readonly sut: IAgentToolSelectService;
  readonly registry: IAgentToolRegistryService;
  readonly contextMemory: FakeContextMemory;
  readonly loop: FakeLoopService;
  readonly eventBus: RecordingEventBus;
}

function registerSharedServices(
  reg: ServiceRegistration,
  contextMemory: FakeContextMemory,
  loop: FakeLoopService,
  eventBus: RecordingEventBus,
): void {
  registerStateServices(reg);
  reg.defineInstance(
    IAgentScopeContext,
    makeAgentScopeContext({ agentId: 'main', agentScope: 'sessions/ws/session/agents/main' }),
  );
  reg.defineInstance(IEventBus, eventBus);
  reg.defineInstance(IAgentLoopService, loop);
  reg.defineInstance(IAgentContextMemoryService, contextMemory);
  reg.definePartialInstance(IAgentProfileService, {
    getModelCapabilities: () => capabilities,
  });
  reg.definePartialInstance(IAgentToolPolicyService, {
    isToolActive: (name: string) => activeToolNames === undefined || activeToolNames.has(name),
    isToolActiveForDisclosure: () => disclosureToolActive,
  });
  reg.definePartialInstance(IFlagService, {
    enabled: (id: string) => (id === TOOL_SELECT_FLAG_ID ? flagEnabled : false),
  });
  reg.defineInstance(IWireService, stubWire());
  reg.defineInstance(IEventDispatcher, {
    _serviceBrand: undefined,
    hooks: { onDidRestore: new OrderedHookSlot() },
    dispatch: async (event: Event2) => {
      eventBus.publish(event);
    },
  } as unknown as IEventDispatcher);
  reg.define(IAgentContextInjectorService, AgentContextInjectorService);
  reg.define(IAgentToolRegistryService, AgentToolRegistryService);
  reg.define(IAgentToolSelectService, AgentToolSelectService);
  reg.define(IAgentToolSelectAnnouncementsService, AgentToolSelectAnnouncementsService);
  reg.define(IAgentToolSelectSchemasService, AgentToolSelectSchemasService);
  reg.define(IAgentSystemReminderService, AgentSystemReminderService);
  registerLogServices(reg);
}

function mountAnnouncements(ix: TestInstantiationService): void {
  ix.get(IAgentToolSelectAnnouncementsService);
  ix.get(IAgentToolSelectSchemasService);
}

function createHarness(): Harness {
  const contextMemory = new FakeContextMemory();
  const loop = new FakeLoopService();
  const eventBus = new RecordingEventBus();
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      registerSharedServices(reg, contextMemory, loop, eventBus);
      reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
    },
    strict: true,
  });
  mountAnnouncements(ix);
  return {
    ix,
    sut: ix.get(IAgentToolSelectService),
    registry: ix.get(IAgentToolRegistryService),
    contextMemory,
    loop,
    eventBus,
  };
}

interface ExecutorHarness extends Harness {
  readonly executor: IAgentToolExecutorService;
}

function createExecutorHarness(): ExecutorHarness {
  const contextMemory = new FakeContextMemory();
  const loop = new FakeLoopService();
  const eventBus = new RecordingEventBus();
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      registerSharedServices(reg, contextMemory, loop, eventBus);
      reg.defineInstance(ITelemetryService, recordingTelemetry([]));
      reg.defineInstance(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
      reg.define(IAgentToolExecutorService, AgentToolExecutorService);
      registerToolResultTruncationServices(reg);
    },
    strict: true,
  });
  mountAnnouncements(ix);
  return {
    ix,
    sut: ix.get(IAgentToolSelectService),
    registry: ix.get(IAgentToolRegistryService),
    executor: ix.get(IAgentToolExecutorService),
    contextMemory,
    loop,
    eventBus,
  };
}

function registerMcp(h: Harness, tool: StubMcpTool): IDisposable {
  const registration = h.registry.register(tool, { source: 'mcp' });
  disposables.add(registration);
  return registration;
}

function registerBuiltin(h: Harness, tool: EchoTool): void {
  disposables.add(h.registry.register(tool, { source: 'builtin' }));
}

function registerUser(
  h: Harness,
  tool: EchoTool,
  disclosure?: ToolDisclosure,
): IDisposable {
  const registration = h.registry.register(tool, { source: 'user', disclosure });
  disposables.add(registration);
  return registration;
}

function announcementText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function isNewAnnouncement(message: ContextMessage): boolean {
  return message.origin?.kind === 'injection' && message.origin.variant === LOADABLE_TOOLS_VARIANT;
}

async function announce(h: Harness, step = 1): Promise<string | undefined> {
  const before = h.contextMemory.appended.length;
  await h.loop.hooks.onWillBeginStep.run({
    turnId: 1,
    step,
    firstStepOfTurn: step === 1,
    signal: new AbortController().signal,
  });
  const announcement = h.contextMemory.appended.slice(before).find(isNewAnnouncement);
  h.contextMemory.landAppended();
  if (announcement === undefined) return undefined;
  return announcementText(announcement);
}

async function announceAfterCompaction(h: Harness): Promise<string | undefined> {
  h.eventBus.publish(
    new ContextSpliced({ agentId: 'main',
      start: 0,
      deleteCount: 1,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Compacted summary.' }],
          toolCalls: [],
          origin: { kind: 'compaction_summary' },
        },
      ],
    }),
  );
  return announce(h, 99);
}

async function declareSchemas(h: Harness, step = 1): Promise<ContextMessage | undefined> {
  const before = h.contextMemory.appended.length;
  await h.loop.hooks.onWillBeginStep.run({
    turnId: 1,
    step,
    firstStepOfTurn: step === 1,
    signal: new AbortController().signal,
  });
  const fresh = h.contextMemory.appended.splice(before);
  const declared = fresh.find(
    (message) =>
      message.origin?.kind === 'injection' &&
      message.origin.variant === DYNAMIC_TOOL_SCHEMA_VARIANT,
  );
  if (declared !== undefined) h.contextMemory.history.push(declared);
  return declared;
}

async function execute(
  h: ExecutorHarness,
  call: ToolCall,
): Promise<readonly ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];
  for await (const result of h.executor.execute([call], {
    signal: new AbortController().signal,
    turnId: 1,
  })) {
    results.push(result);
  }
  return results;
}

describe('AgentToolSelectService gate', () => {
  it('opens only when dynamically_loaded_tools capability, tool_use capability and flag are all on', () => {
    flagEnabled = true;
    const { sut } = createHarness();
    expect(sut.enabled()).toBe(true);
  });

  it('stays closed without the dynamically_loaded_tools capability', () => {
    flagEnabled = true;
    capabilities = makeCapabilities({ tool_use: true, dynamically_loaded_tools: false });
    const { sut } = createHarness();
    expect(sut.enabled()).toBe(false);
  });

  it('stays closed without tool_use capability', () => {
    flagEnabled = true;
    capabilities = makeCapabilities({ tool_use: false, dynamically_loaded_tools: true });
    const { sut } = createHarness();
    expect(sut.enabled()).toBe(false);
  });

  it('stays closed without the flag', () => {
    flagEnabled = false;
    const { sut } = createHarness();
    expect(sut.enabled()).toBe(false);
  });
});

describe('AgentToolSelectService S0 baseline (gate closed)', () => {
  it('shapeTools returns the identical array when dynamically_loaded_tools is absent', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const entries = h.registry.list();
    expect(h.sut.shapeTools(entries)).toBe(entries);
  });

  it('shapeHistory returns the identical array when there is nothing to strip', () => {
    const h = createHarness();
    const messages: readonly ContextMessage[] = [userMessage('a'), userMessage('b')];
    expect(h.sut.shapeHistory(messages)).toBe(messages);
  });

  it('shapeTools filters select_tools itself out of the view', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    const shaped = h.sut.shapeTools(h.registry.list());
    expect(shaped.map((entry) => entry.name)).toEqual(['Echo']);
    expect(shaped.every((entry) => entry.deferred === undefined)).toBe(true);
  });

  it('keeps deferred user tools inline while the disclosure gate is closed', () => {
    const h = createHarness();
    registerUser(h, new EchoTool(USER_DEFERRED), 'deferred');

    const shaped = h.sut.shapeTools(h.registry.list());

    expect(shaped.map((entry) => entry.name)).toContain(USER_DEFERRED);
    expect(shaped.find((entry) => entry.name === USER_DEFERRED)?.deferred).toBeUndefined();
  });

  it('shapeTools applies profile filtering and removes select_tools while the gate is closed', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    activeToolNames = new Set(['Echo']);

    const shaped = h.sut.shapeTools(h.registry.list());
    expect(shaped.map((entry) => entry.name)).toEqual(['Echo']);
  });

  it('select_tools execution self-guards while the gate is closed', async () => {
    const h = createHarness();
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const execution = selectTools.resolveExecution({ names: [MCP_ALPHA] });
    expect(execution.isError).toBeUndefined();
    if (execution.isError === true) throw new Error('expected a runnable execution');
    const result = await execution.execute({
      turnId: 1,
      toolCallId: 'call-1',
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      output: 'select_tools is not available for the current model.',
      isError: true,
    });
  });

  it('shapeHistory strips dynamic-tool protocol context without touching the canonical history', () => {
    const h = createHarness();
    h.contextMemory.landAnnouncement('<tools_added>\nt\n</tools_added>');
    h.contextMemory.history.push(schemaMessage('t'), userMessage('keep'));
    const shaped = h.sut.shapeHistory(h.contextMemory.get());
    expect(shaped.map((message) => message.role)).toEqual(['user']);
    expect(h.contextMemory.get()).toHaveLength(3);
  });

  it('missing-tool wording falls back to the default message', async () => {
    const h = createExecutorHarness();
    const results = await execute(h, toolCall('call-1', MCP_GONE));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.output).toBe(`Tool "${MCP_GONE}" not found`);
    expect(results[0]!.result.isError).toBe(true);
  });
});

describe('AgentToolSelectService view shaping (gate open)', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it('hides unloaded MCP tools, marks loaded MCP tools deferred, keeps non-deferred builtins and select_tools', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));

    const shaped = h.sut.shapeTools(h.registry.list());
    expect(shaped.map((entry) => entry.name)).toEqual(['Echo', MCP_ALPHA, SELECT_TOOLS_TOOL_NAME]);
    const byName = new Map(shaped.map((entry) => [entry.name, entry]));
    expect(byName.get(MCP_ALPHA)?.deferred).toBe(true);
    expect(byName.get('Echo')?.deferred).toBeUndefined();
    expect(byName.get(SELECT_TOOLS_TOOL_NAME)?.deferred).toBeUndefined();
  });

  it('hides unloaded deferred builtins and marks loaded ones deferred', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    registerBuiltin(h, new EchoTool('EnterPlanMode'));
    registerBuiltin(h, new EchoTool('CronList'));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    h.contextMemory.history.push(schemaMessage('EnterPlanMode'));

    const shaped = h.sut.shapeTools(h.registry.list());
    expect(shaped.map((entry) => entry.name)).toEqual([
      'Echo',
      'EnterPlanMode',
      SELECT_TOOLS_TOOL_NAME,
    ]);
    expect(shaped.find((entry) => entry.name === 'EnterPlanMode')?.deferred).toBe(true);
    expect(shaped.find((entry) => entry.name === 'Echo')?.deferred).toBeUndefined();
    expect(shaped.map((entry) => entry.name)).not.toContain('CronList');
  });

  it('defers only opted-in user tools and restores them after selection', () => {
    const h = createHarness();
    registerUser(h, new EchoTool(USER_DEFERRED), 'deferred');
    registerUser(h, new EchoTool(USER_INLINE));

    const beforeLoad = h.sut.shapeTools(h.registry.list());
    expect(beforeLoad.map((entry) => entry.name)).toContain(USER_INLINE);
    expect(beforeLoad.map((entry) => entry.name)).not.toContain(USER_DEFERRED);

    h.contextMemory.history.push(schemaMessage(USER_DEFERRED));
    const afterLoad = h.sut.shapeTools(h.registry.list());
    expect(afterLoad.map((entry) => entry.name)).toContain(USER_DEFERRED);
    expect(afterLoad.find((entry) => entry.name === USER_DEFERRED)?.deferred).toBe(true);
    expect(afterLoad.find((entry) => entry.name === USER_INLINE)?.deferred).toBeUndefined();
  });

  it('keeps select_tools visible when the profile omits it while hiding inactive tools', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));
    activeToolNames = new Set([MCP_ALPHA]);

    const shaped = h.sut.shapeTools(h.registry.list());
    expect(shaped.map((entry) => entry.name)).toEqual([
      MCP_ALPHA,
      SELECT_TOOLS_TOOL_NAME,
    ]);
  });

  it('hides select_tools when an explicit policy disables disclosure', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    activeToolNames = new Set([MCP_ALPHA]);
    disclosureToolActive = false;

    const shaped = h.sut.shapeTools(h.registry.list());

    expect(shaped.map((entry) => entry.name)).not.toContain(SELECT_TOOLS_TOOL_NAME);
  });

  it('shapeHistory returns the identical array', () => {
    const h = createHarness();
    h.contextMemory.history.push(userMessage('a'), schemaMessage(MCP_ALPHA));
    const messages = h.contextMemory.get();
    expect(h.sut.shapeHistory(messages)).toBe(messages);
  });

  it('shapeHistory removes loaded schemas when the profile disables them', () => {
    const h = createHarness();
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA, MCP_BETA), userMessage('keep'));
    activeToolNames = new Set([MCP_BETA]);

    const shaped = h.sut.shapeHistory(h.contextMemory.get());

    expect(shaped).toHaveLength(2);
    expect(shaped[0]!.tools?.map((tool) => tool.name)).toEqual([MCP_BETA]);
    expect(h.contextMemory.get()[0]!.tools?.map((tool) => tool.name)).toEqual([
      MCP_ALPHA,
      MCP_BETA,
    ]);
  });

  it('shapeHistory removes a deferred user schema after unregister', () => {
    const h = createHarness();
    const registration = registerUser(h, new EchoTool(USER_DEFERRED), 'deferred');
    h.contextMemory.history.push(schemaMessage(USER_DEFERRED));
    registration.dispose();

    expect(h.sut.shapeHistory(h.contextMemory.get())).toEqual([]);
    expect(h.sut.load([USER_DEFERRED])).toEqual({
      toLoad: [],
      alreadyAvailable: [],
      unknown: [USER_DEFERRED],
    });
    expect(h.contextMemory.get()[0]?.tools?.map((tool) => tool.name)).toEqual([
      USER_DEFERRED,
    ]);
  });

  it('shapeHistory removes a deferred schema after re-registering the user tool inline', () => {
    const h = createHarness();
    registerUser(h, new EchoTool(USER_DEFERRED), 'deferred');
    h.contextMemory.history.push(schemaMessage(USER_DEFERRED));
    registerUser(h, new EchoTool(USER_DEFERRED));

    expect(h.sut.shapeHistory(h.contextMemory.get())).toEqual([]);
    const inline = h.sut
      .shapeTools(h.registry.list())
      .find((entry) => entry.name === USER_DEFERRED);
    expect(inline).toEqual(
      expect.objectContaining({ name: USER_DEFERRED, disclosure: undefined }),
    );
    expect(inline?.deferred).toBeUndefined();
    expect(h.sut.load([USER_DEFERRED])).toEqual({
      toLoad: [],
      alreadyAvailable: [],
      unknown: [USER_DEFERRED],
    });
  });
});

describe('AgentToolSelectService.load', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it('settles per name: toLoad, alreadyAvailable, unknown', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));

    const result = h.sut.load([MCP_BETA, MCP_ALPHA, MCP_GONE]);
    expect(result.toLoad).toEqual([MCP_BETA]);
    expect(result.alreadyAvailable).toEqual([MCP_ALPHA]);
    expect(result.unknown).toEqual([MCP_GONE]);

    expect(h.contextMemory.appended).toHaveLength(0);
    const declared = await declareSchemas(h);
    expect(declared?.role).toBe('system');
    expect(declared?.tools?.map((tool) => tool.name)).toEqual([MCP_BETA]);
    expect(declared?.origin).toEqual({ kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT });
  });

  it('loads deferred builtins the same way as MCP tools', async () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool('EnterPlanMode'));
    registerBuiltin(h, new EchoTool('CronList'));
    h.contextMemory.history.push(schemaMessage('EnterPlanMode'));

    const result = h.sut.load(['CronList', 'EnterPlanMode', 'NotATool']);
    expect(result.toLoad).toEqual(['CronList']);
    expect(result.alreadyAvailable).toEqual(['EnterPlanMode']);
    expect(result.unknown).toEqual(['NotATool']);
    const declared = await declareSchemas(h);
    expect(declared?.tools?.map((tool) => tool.name)).toEqual(['CronList']);
  });

  it('does not treat non-deferred builtins as loadable', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    const result = h.sut.load(['Echo']);
    expect(result.toLoad).toEqual([]);
    expect(result.unknown).toEqual(['Echo']);
  });

  it('loads the schema of an opted-in user tool', async () => {
    const h = createHarness();
    registerUser(h, new EchoTool(USER_DEFERRED), 'deferred');

    expect(h.sut.load([USER_DEFERRED])).toEqual({
      toLoad: [USER_DEFERRED],
      alreadyAvailable: [],
      unknown: [],
    });
    const declared = await declareSchemas(h);
    expect(declared?.tools?.map((tool) => tool.name)).toEqual([USER_DEFERRED]);
  });

  it('sorts the declared schemas by name', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_BETA));
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    h.sut.load([MCP_BETA, MCP_ALPHA]);
    const declared = await declareSchemas(h);
    expect(declared?.tools?.map((tool) => tool.name)).toEqual([MCP_ALPHA, MCP_BETA]);
  });

  it('declares a selected schema after its MCP tool reconnects before a later boundary', async () => {
    const h = createHarness();
    const registration = registerMcp(h, new StubMcpTool(MCP_ALPHA));

    expect(h.sut.load([MCP_ALPHA]).toLoad).toEqual([MCP_ALPHA]);
    registration.dispose();
    expect(await declareSchemas(h)).toBeUndefined();

    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const declared = await declareSchemas(h, 2);
    expect(declared?.tools?.map((tool) => tool.name)).toEqual([MCP_ALPHA]);
  });

  it('reports names filtered out by the profile as unknown', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    activeToolNames = new Set([MCP_ALPHA]);

    const result = h.sut.load([MCP_ALPHA, MCP_BETA]);
    expect(result.toLoad).toEqual([MCP_ALPHA]);
    expect(result.unknown).toEqual([MCP_BETA]);
    const declared = await declareSchemas(h);
    expect(declared?.tools?.map((tool) => tool.name)).toEqual([MCP_ALPHA]);
  });

  it('pending ledger leads the history inside the defer window', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    h.sut.load([MCP_ALPHA]);
    expect(h.contextMemory.get().some((message) => message.tools !== undefined)).toBe(false);
    const reselect = h.sut.load([MCP_ALPHA]);
    expect(reselect.alreadyAvailable).toEqual([MCP_ALPHA]);
    expect(reselect.toLoad).toEqual([]);

    await declareSchemas(h);
    const afterLanding = h.sut.load([MCP_ALPHA]);
    expect(afterLanding.alreadyAvailable).toEqual([MCP_ALPHA]);
  });

  it('clears the pending ledger after compaction completes', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    h.sut.load([MCP_ALPHA]);
    h.eventBus.publish(
      new CompactionCompleted({ agentId: 'main',
        result: { summary: '', compactedCount: 0, tokensBefore: 0, tokensAfter: 0 },
      }),
    );
    expect(h.sut.load([MCP_ALPHA]).toLoad).toEqual([MCP_ALPHA]);
  });

  it('clears the pending ledger after a full-prefix context splice', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    h.sut.load([MCP_ALPHA]);
    h.eventBus.publish(new ContextSpliced({ agentId: 'main', start: 0, deleteCount: 2, messages: [] }));
    expect(h.sut.load([MCP_ALPHA]).toLoad).toEqual([MCP_ALPHA]);
  });

  it('keeps the pending ledger across a compaction replacement splice', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    h.sut.load([MCP_ALPHA]);
    h.eventBus.publish(
      new ContextSpliced({ agentId: 'main',
        start: 0,
        deleteCount: 2,
        messages: [userMessage('Compacted summary.')],
      }),
    );

    expect(h.sut.load([MCP_ALPHA]).alreadyAvailable).toEqual([MCP_ALPHA]);
    const declared = await declareSchemas(h);
    expect(declared?.tools?.map((tool) => tool.name)).toEqual([MCP_ALPHA]);
  });

  it('reconciles the pending ledger with history when a mid-history splice removes schema messages', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));

    h.sut.load([MCP_ALPHA]);
    await declareSchemas(h);
    h.sut.load([MCP_BETA]);
    await declareSchemas(h, 2);
    expect(h.sut.load([MCP_ALPHA]).alreadyAvailable).toEqual([MCP_ALPHA]);
    expect(h.sut.load([MCP_BETA]).alreadyAvailable).toEqual([MCP_BETA]);

    h.contextMemory.history.splice(1, 1);
    h.eventBus.publish(new ContextSpliced({ agentId: 'main', start: 1, deleteCount: 2, messages: [] }));

    expect(h.sut.load([MCP_ALPHA]).alreadyAvailable).toEqual([MCP_ALPHA]);
    expect(h.sut.load([MCP_BETA]).toLoad).toEqual([MCP_BETA]);
  });

  it('keeps the pending ledger across tail appends', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    h.sut.load([MCP_ALPHA]);
    h.eventBus.publish(
      new ContextSpliced({ agentId: 'main', start: 3, deleteCount: 0, messages: [userMessage('x')] }),
    );
    expect(h.sut.load([MCP_ALPHA]).alreadyAvailable).toEqual([MCP_ALPHA]);
  });

  it('renders the select_tools tool output per name for mixed load results', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const ctx = { turnId: 1, toolCallId: 'call-1', signal: new AbortController().signal };

    const mixed = selectTools.resolveExecution({ names: [MCP_BETA, MCP_ALPHA, MCP_GONE] });
    if (mixed.isError === true) throw new Error('expected a runnable execution');
    expect(await mixed.execute(ctx)).toEqual({
      output: [
        `Loaded: ${MCP_BETA}`,
        `Already available: ${MCP_ALPHA}`,
        `Unknown tool: ${MCP_GONE}. Pick from the latest announced tools list.`,
      ].join('\n'),
    });
  });

  it('returns an error when select_tools only receives unknown names', async () => {
    const h = createHarness();
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const ctx = { turnId: 1, toolCallId: 'call-1', signal: new AbortController().signal };
    const unknownOnly = selectTools.resolveExecution({ names: [MCP_GONE] });
    if (unknownOnly.isError === true) throw new Error('expected a runnable execution');
    expect(await unknownOnly.execute(ctx)).toEqual({
      output: `Unknown tool: ${MCP_GONE}. Pick from the latest announced tools list.`,
      isError: true,
    });
  });
});

describe('AgentToolSelectService executor interception', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it('the executor settles the intercepted call without running the tool', async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA);
    registerMcp(h, alpha);

    const results = await execute(h, toolCall('call-1', MCP_ALPHA));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBe(true);
    expect(results[0]!.result.output).toContain('is available but not loaded');
    expect(alpha.calls).toBe(0);
  });

  it('the executor returns loading guidance before validating args for an unloaded MCP tool', async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA, 'mcp ok', REQUIRED_PAYLOAD_PARAMETERS);
    registerMcp(h, alpha);

    const results = await execute(h, toolCall('call-1', MCP_ALPHA, { unexpected: true }));
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toEqual({
      output:
        `Tool "${MCP_ALPHA}" is available but not loaded. ` +
        `Call select_tools with ["${MCP_ALPHA}"] first, then call the tool.`,
      isError: true,
      stopTurn: false,
    });
    expect(alpha.calls).toBe(0);
  });

  it('the executor runs the tool once its schema is loaded', async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA);
    registerMcp(h, alpha);
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));

    const results = await execute(h, toolCall('call-1', MCP_ALPHA));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.output).toBe('mcp ok');
    expect(alpha.calls).toBe(1);
  });

  it('the executor rejects a loaded MCP tool when the profile disables it', async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA);
    registerMcp(h, alpha);
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));
    activeToolNames = new Set([]);

    const results = await execute(h, toolCall('call-1', MCP_ALPHA));

    expect(results).toHaveLength(1);
    expect(results[0]!.result).toEqual({
      output:
        `Tool "${MCP_ALPHA}" was loaded but is no longer active. Ask the user to enable it before calling it again.`,
      isError: true,
      stopTurn: false,
    });
    expect(alpha.calls).toBe(0);
  });

  it('the executor runs non-deferred builtins without loading', async () => {
    const h = createExecutorHarness();
    const echo = new EchoTool();
    registerBuiltin(h, echo);

    const results = await execute(h, toolCall('call-1', 'Echo'));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.output).toBe('echo ok');
    expect(echo.calls).toBe(1);
  });

  it('the executor intercepts unloaded deferred builtins', async () => {
    const h = createExecutorHarness();
    const plan = new EchoTool('EnterPlanMode');
    registerBuiltin(h, plan);

    const results = await execute(h, toolCall('call-1', 'EnterPlanMode'));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBe(true);
    expect(results[0]!.result.output).toContain('is available but not loaded');
    expect(plan.calls).toBe(0);
  });

  it('the executor runs a deferred builtin once its schema is loaded', async () => {
    const h = createExecutorHarness();
    const plan = new EchoTool('EnterPlanMode');
    registerBuiltin(h, plan);
    h.contextMemory.history.push(schemaMessage('EnterPlanMode'));

    const results = await execute(h, toolCall('call-1', 'EnterPlanMode'));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.output).toBe('echo ok');
    expect(plan.calls).toBe(1);
  });

  it('intercepts an unloaded deferred user tool and runs it after selection', async () => {
    const h = createExecutorHarness();
    const dashboard = new EchoTool(USER_DEFERRED);
    registerUser(h, dashboard, 'deferred');

    const beforeLoad = await execute(h, toolCall('call-1', USER_DEFERRED));
    expect(beforeLoad[0]!.result.output).toContain('is available but not loaded');
    expect(dashboard.calls).toBe(0);

    h.contextMemory.history.push(schemaMessage(USER_DEFERRED));
    const afterLoad = await execute(h, toolCall('call-2', USER_DEFERRED));
    expect(afterLoad[0]!.result.output).toBe('echo ok');
    expect(dashboard.calls).toBe(1);
  });
});

describe('AgentToolSelectService missing tool wording', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it('tells a loaded-but-disconnected MCP tool apart from an unknown name', async () => {
    const h = createExecutorHarness();
    h.contextMemory.history.push(schemaMessage(MCP_GONE));

    const results = await execute(h, toolCall('call-1', MCP_GONE));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBe(true);
    expect(results[0]!.result.output).toBe(
      `Tool "${MCP_GONE}" was loaded but its MCP server is currently disconnected. ` +
        'It may become available again when the server reconnects; do not retry immediately.',
    );
  });

  it('keeps the default message for a name that was never loaded', async () => {
    const h = createExecutorHarness();
    const results = await execute(h, toolCall('call-1', MCP_GONE));
    expect(results[0]!.result.output).toBe(`Tool "${MCP_GONE}" not found`);
  });

  it('reports a loaded user tool that is no longer registered', async () => {
    const h = createExecutorHarness();
    const registration = registerUser(h, new EchoTool(USER_DEFERRED), 'deferred');
    h.contextMemory.history.push(schemaMessage(USER_DEFERRED));
    registration.dispose();

    const results = await execute(h, toolCall('call-1', USER_DEFERRED));

    expect(results[0]!.result.output).toBe(
      `Tool "${USER_DEFERRED}" was loaded but is no longer registered. ` +
        'Do not retry it unless it becomes available again.',
    );
  });
});

describe('AgentToolSelectService loadable-tools announcements', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it('announces the full loadable set on first run, then stays silent while unchanged', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_BETA));
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    const first = await announce(h);
    expect(first).toContain(`<tools_added>\n${MCP_ALPHA}\n${MCP_BETA}\n</tools_added>`);
    expect(first).not.toContain('<tools_removed>');

    expect(await announce(h, 2)).toBeUndefined();
  });

  it('announces deferred builtins alongside MCP tools', async () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool('EnterPlanMode'));
    registerBuiltin(h, new EchoTool());
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    const first = await announce(h);
    expect(first).toContain('EnterPlanMode');
    expect(first).toContain(MCP_ALPHA);
    expect(first).not.toContain('\nEcho\n');
    expect(first).not.toContain('<tools_added>\nEcho\n');
  });

  it('waits until the next boundary before announcing registry diffs', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    await announce(h);

    registerMcp(h, new StubMcpTool(MCP_GAMMA));
    expect(await announce(h, 2)).toBeUndefined();

    h.eventBus.publish(new TurnStarted({ agentId: 'main', turnId: 99, origin: { kind: 'user' } }));
    const diff = await announce(h);
    expect(diff).toContain(`<tools_added>\n${MCP_GAMMA}\n</tools_added>`);
  });

  it('diffs registry additions and removals against the folded announcements', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const betaRegistration = h.registry.register(new StubMcpTool(MCP_BETA), { source: 'mcp' });
    disposables.add(betaRegistration);

    await announce(h);

    betaRegistration.dispose();
    registerMcp(h, new StubMcpTool(MCP_GAMMA));
    h.eventBus.publish(new TurnStarted({ agentId: 'main', turnId: 99, origin: { kind: 'user' } }));

    const diff = await announce(h);
    expect(diff).toContain(`<tools_added>\n${MCP_GAMMA}\n</tools_added>`);
    expect(diff).toContain(`<tools_removed>\n${MCP_BETA}\n</tools_removed>`);
  });

  it('re-announces the full set after compaction discards the history', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));

    await announce(h);
    expect(await announce(h, 2)).toBeUndefined();

    h.contextMemory.clear();
    const reannounced = await announceAfterCompaction(h);
    expect(reannounced).toContain(`<tools_added>\n${MCP_ALPHA}\n${MCP_BETA}\n</tools_added>`);
  });

  it('announces only profile-active tools', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    activeToolNames = new Set([MCP_BETA]);

    const first = await announce(h);
    expect(first).toContain(`<tools_added>\n${MCP_BETA}\n</tools_added>`);
    expect(first).not.toContain(MCP_ALPHA);
  });

  it('stays silent while the gate is closed', async () => {
    flagEnabled = false;
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    expect(await announce(h)).toBeUndefined();
  });
});

// Lean mode is the same regime chosen per session rather than declared per
// model. It exists to keep the request prefix small, so where the declared mode
// hands back the full catalogue on a miss, this one must not: that would send
// every tool while the user believes the session is lean.
describe('AgentToolSelectService lean mode', () => {
  const [LEAN_READ, LEAN_SEARCH, LEAN_SHELL, LEAN_PATCH] = LEAN_MODE_TOOL_NAMES;

  beforeEach(() => {
    capabilities = composeLeanCapability(makeCapabilities({ tool_use: true }), true);
  });

  function registerLean(h: Harness, names: readonly string[] = LEAN_MODE_TOOL_NAMES): void {
    for (const name of names) registerBuiltin(h, new EchoTool(name));
  }

  it('narrows the catalogue to the lean-ctx tools', () => {
    const h = createHarness();
    registerLean(h);
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    const shaped = h.sut.shapeTools(h.registry.list());

    expect(new Set(shaped.map((entry) => entry.name))).toEqual(new Set(LEAN_MODE_TOOL_NAMES));
  });

  it('sends the intersection when one lean tool is missing', () => {
    const h = createHarness();
    registerLean(h, [LEAN_READ!, LEAN_SEARCH!, LEAN_SHELL!]);
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));

    const shaped = h.sut.shapeTools(h.registry.list());

    expect(new Set(shaped.map((entry) => entry.name))).toEqual(
      new Set([LEAN_READ, LEAN_SEARCH, LEAN_SHELL]),
    );
    expect(shaped.map((entry) => entry.name)).not.toContain(OFF_CATALOGUE);
  });

  it('warns once about the missing lean tools', () => {
    const h = createHarness();
    registerLean(h, [LEAN_READ!]);

    h.sut.shapeTools(h.registry.list());
    h.sut.shapeTools(h.registry.list());

    const warnings = h.eventBus.published.filter(
      (event) =>
        event.type === 'warning' &&
        (event as unknown as { code?: string }).code === 'lean-mode-tools-unavailable',
    );
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as unknown as { message: string }).message).toContain(LEAN_PATCH!);
  });

  // The refusal to fall back is the whole contract: with no lean tool present
  // the session composes nothing and says so, rather than quietly shipping the
  // full catalogue the mode exists to avoid.
  it('composes nothing and warns when no lean tool is available', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    const entries = h.registry.list();
    const shaped = h.sut.shapeTools(entries);

    expect(shaped).toEqual([]);
    expect(shaped).not.toBe(entries);
    const warning = h.eventBus.published.find(
      (event) =>
        event.type === 'warning' &&
        (event as unknown as { code?: string }).code === 'lean-mode-tools-unavailable',
    );
    expect((warning as unknown as { message: string } | undefined)?.message).toContain('lean-ctx MCP server');
  });

  // Sensitivity check for every assertion above: without the session flag the
  // same capability object narrows nothing.
  it('leaves the catalogue untouched when lean is not composed', () => {
    capabilities = composeLeanCapability(makeCapabilities({ tool_use: true }), false);
    const h = createHarness();
    registerLean(h);
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));

    const entries = h.registry.list();
    expect(h.sut.shapeTools(entries)).toBe(entries);
  });

  // A model that declares the capability keeps the old all-or-nothing degrade;
  // only the session-chosen mode narrows to the intersection.
  it('keeps the declared capability degrading to the full catalogue', () => {
    capabilities = makeCapabilities({ tool_use: true, minimal_mode: true });
    const h = createHarness();
    registerBuiltin(h, new EchoTool(MINIMAL_SHELL));
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));

    const entries = h.registry.list();
    expect(h.sut.shapeTools(entries)).toBe(entries);
  });
});

describe('AgentToolSelectService minimal mode', () => {
  beforeEach(() => {
    capabilities = makeCapabilities({ tool_use: true, minimal_mode: true });
  });

  function registerMinimal(h: Harness): void {
    registerBuiltin(h, new EchoTool(MINIMAL_SHELL));
    registerBuiltin(h, new EchoTool(MINIMAL_READ));
    registerBuiltin(h, new EchoTool(MINIMAL_SEARCH));
    registerBuiltin(h, new EchoTool(MINIMAL_PATCH));
  }

  it('narrows the catalogue to the minimal tools', () => {
    const h = createHarness();
    registerMinimal(h);
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    const shaped = h.sut.shapeTools(h.registry.list());

    expect(new Set(shaped.map((entry) => entry.name))).toEqual(
      new Set([MINIMAL_SHELL, MINIMAL_READ, MINIMAL_SEARCH, MINIMAL_PATCH]),
    );
  });

  // The whole point of the mode: the catalogue is fixed for the session, so no
  // amount of conversation widens it. There is no promotion path to latch.
  it('stays narrow however much the conversation has produced', () => {
    const h = createHarness();
    registerMinimal(h);
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));
    h.contextMemory.history.push(
      userMessage('go'),
      assistantMessage('on it'),
      userMessage('again'),
      { role: 'assistant', content: [], toolCalls: [toolCall('call-1', MINIMAL_READ)] },
      assistantMessage('still here'),
    );

    const shaped = h.sut.shapeTools(h.registry.list());

    expect(new Set(shaped.map((entry) => entry.name))).toEqual(
      new Set([MINIMAL_SHELL, MINIMAL_READ, MINIMAL_SEARCH, MINIMAL_PATCH]),
    );
  });

  it('stays narrow across a compaction that replaces the history', () => {
    const h = createHarness();
    registerMinimal(h);
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));
    h.contextMemory.history.push(assistantMessage('on it'));
    h.sut.shapeTools(h.registry.list());

    h.contextMemory.history.length = 0;
    h.contextMemory.history.push(userMessage('next'), createCompactionSummaryMessage('summary'));

    const shaped = h.sut.shapeTools(h.registry.list());

    expect(new Set(shaped.map((entry) => entry.name))).toEqual(
      new Set([MINIMAL_SHELL, MINIMAL_READ, MINIMAL_SEARCH, MINIMAL_PATCH]),
    );
  });

  it('keeps the full catalogue when one of the minimal tools is not registered', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool(MINIMAL_SHELL));
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));

    const entries = h.registry.list();
    expect(h.sut.shapeTools(entries)).toBe(entries);
  });

  it('keeps the full catalogue when the profile disables a minimal tool', () => {
    const h = createHarness();
    registerMinimal(h);
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));
    activeToolNames = new Set([MINIMAL_SHELL, OFF_CATALOGUE]);

    const shaped = h.sut.shapeTools(h.registry.list());

    expect(shaped.map((entry) => entry.name)).toEqual([MINIMAL_SHELL, OFF_CATALOGUE]);
  });

  // Sensitivity check for every assertion above.
  it('leaves the catalogue untouched when the capability is absent', () => {
    capabilities = makeCapabilities({ tool_use: true });
    const h = createHarness();
    registerMinimal(h);
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));

    const entries = h.registry.list();
    expect(h.sut.shapeTools(entries)).toBe(entries);
  });

  it('narrows even while progressive disclosure is also on', () => {
    flagEnabled = true;
    capabilities = makeCapabilities({
      tool_use: true,
      dynamically_loaded_tools: true,
      minimal_mode: true,
    });
    const h = createHarness();
    registerMinimal(h);
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    const shaped = h.sut.shapeTools(h.registry.list());

    expect(new Set(shaped.map((entry) => entry.name))).toEqual(
      new Set([MINIMAL_SHELL, MINIMAL_READ, MINIMAL_SEARCH, MINIMAL_PATCH]),
    );
  });

  // The refusal must not promise a later opening — there is not one.
  it('tells the model an off-catalogue tool never opens', async () => {
    const h = createExecutorHarness();
    registerMinimal(h);
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));

    const results = await execute(h, toolCall('call-1', OFF_CATALOGUE));

    expect(results).toHaveLength(1);
    expect(results[0]!.result.output).toContain('no further tool opens later');
    expect(results[0]!.result.output).not.toContain('next step');
    expect(results[0]!.result.isError).toBe(true);
  });

  it('keeps refusing an off-catalogue tool on a later step', async () => {
    const h = createExecutorHarness();
    registerMinimal(h);
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));
    h.contextMemory.history.push(userMessage('go'), assistantMessage('on it'));

    const results = await execute(h, toolCall('call-1', OFF_CATALOGUE));

    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBe(true);
  });

  it('lets a minimal tool run', async () => {
    const h = createExecutorHarness();
    registerMinimal(h);

    const results = await execute(h, toolCall('call-1', MINIMAL_SHELL, { payload: 'ok' }));

    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBeFalsy();
  });

  // An empty catalogue is a legal measurement setting but an unusable session,
  // and nothing opens later to rescue it. A config typo must not reach that
  // state silently.
  it('warns when the configured catalogue is empty', () => {
    capabilities = { ...makeCapabilities({ tool_use: true, minimal_mode: true }),
      minimal_mode_tools: [] };
    const h = createHarness();
    registerMinimal(h);
    const warn = vi.spyOn(h.ix.get(ILogService), 'warn');

    expect(h.sut.shapeTools(h.registry.list())).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('minimal_mode_tools is empty'),
    );
  });

  // Degrading has to be all-or-nothing. When `narrowTools` gives up it hands the
  // model the full catalogue, so the refusal gate must give up too — otherwise
  // every tool is listed and every tool is refused, quoting a catalogue that is
  // not in effect, and the model has no way out of the loop.
  it('stops refusing once narrowing has degraded', async () => {
    const h = createExecutorHarness();
    registerBuiltin(h, new EchoTool(MINIMAL_SHELL));
    registerBuiltin(h, new EchoTool(OFF_CATALOGUE));

    const entries = h.registry.list();
    expect(h.sut.shapeTools(entries)).toBe(entries);

    const results = await execute(h, toolCall('call-1', OFF_CATALOGUE, { payload: 'ok' }));

    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBeFalsy();
  });
});
