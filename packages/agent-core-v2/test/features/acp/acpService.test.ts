import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { Event } from '#/_base/event';
import {
  IAgentLLMRequesterService,
  type ContextManager,
  type IAgentLLMRequesterService as AgentLLMRequester,
} from '#/agent/llmRequester/llmRequester';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { ACP_MANAGER_ID, IAcpService } from '#/features/acp/acp';
import { AcpService } from '#/features/acp/acpService';
import { ACP_SIDECAR_KEY, type AcpSidecar } from '#/features/acp/sidecar';
import type { ContentPart, Message } from '#/kosong/contract/message';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionTodoService } from '#/session/todo/sessionTodo';

interface StoreHarness {
  readonly values: Map<string, unknown>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly set: ReturnType<typeof vi.fn>;
  readonly delete: ReturnType<typeof vi.fn>;
  readonly service: IAtomicDocumentStore;
}

function createStore(): StoreHarness {
  const values = new Map<string, unknown>();
  const get = vi.fn(async (scope: string, key: string) => values.get(`${scope}/${key}`));
  const set = vi.fn(async (scope: string, key: string, value: unknown) => {
    values.set(`${scope}/${key}`, value);
  });
  const remove = vi.fn(async (scope: string, key: string) => {
    values.delete(`${scope}/${key}`);
  });
  return {
    values,
    get,
    set,
    delete: remove,
    service: {
      _serviceBrand: undefined,
      get: async <T>(scope: string, key: string) => get(scope, key) as Promise<T | undefined>,
      set,
      delete: remove,
      list: vi.fn(async () => []),
      watch: vi.fn(() => (() => ({ dispose() {} })) as Event<void>),
      acquire: vi.fn(() => ({ dispose() {} })),
    },
  };
}

function createRequester(): {
  readonly service: AgentLLMRequester;
  readonly manager: () => ContextManager;
  readonly registrationDisposed: ReturnType<typeof vi.fn>;
} {
  let registered: ContextManager | undefined;
  const registrationDisposed = vi.fn();
  const service = {
    _serviceBrand: undefined,
    registerContextManager: (manager: ContextManager) => {
      registered = manager;
      return { dispose: registrationDisposed };
    },
    getActiveContextManager: () => registered,
  } as unknown as AgentLLMRequester;
  return {
    service,
    manager: () => {
      if (registered === undefined) throw new Error('manager was not registered');
      return registered;
    },
    registrationDisposed,
  };
}

function textMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

const SUMMARY =
  'Folded the opening investigation segment covering setup, markers one to three, and findings.';

function bigMessages(count: number, size = 3000): Message[] {
  return Array.from({ length: count }, (_, index) =>
    textMessage(`MARKER-${index + 1} ${'x'.repeat(size)}`),
  );
}

function messageText(message: Message): string {
  return message.content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function compressPairHistory(): Message[] {
  const bigUser = (marker: string): Message => textMessage(`${marker} ${'x'.repeat(4000)}`);
  const compressCall: Message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Compressing the oldest range.' }],
    toolCalls: [
      {
        type: 'function',
        id: 'call_c1',
        name: 'compress',
        arguments: '{"content":[{"startId":"m00001","endId":"m00002","summary":"earlier fold"}]}',
      },
    ],
  };
  const compressResult: Message = {
    role: 'tool',
    toolCallId: 'call_c1',
    name: 'compress',
    content: [{ type: 'text', text: '{"ok":true}' }],
    toolCalls: [],
  };
  return [
    bigUser('MARKER-1'),
    compressCall,
    compressResult,
    textMessage(`foldneedle ${'x'.repeat(4000)}`),
    bigUser('MARKER-5'),
    bigUser('MARKER-6'),
    bigUser('MARKER-7'),
    bigUser('MARKER-8'),
    bigUser('MARKER-9'),
  ];
}

function transform(
  manager: ContextManager,
  messages: readonly Message[],
  signal = new AbortController().signal,
  limits: { readonly usedContextTokens: number; readonly maxContextTokens: number } = {
    usedContextTokens: 0,
    maxContextTokens: 100_000,
  },
) {
  return manager.transformMessages({
    messages,
    usedContextTokens: limits.usedContextTokens,
    maxContextTokens: limits.maxContextTokens,
    signal,
  });
}

function createService(agentId = 'main', store = createStore()) {
  const disposables = new DisposableStore();
  const ix = disposables.add(new TestInstantiationService());
  const requester = createRequester();
  const env: { history: readonly Message[] } = { history: [] };
  ix.set(
    IAgentScopeContext,
    makeAgentScopeContext({
      agentId,
      agentScope: `sessions/ws/session/agents/${agentId}`,
    }),
  );
  ix.set(IAtomicDocumentStore, store.service);
  ix.set(IAgentLLMRequesterService, requester.service);
  ix.set(IAgentContextMemoryService, {
    _serviceBrand: undefined,
    get: () => env.history,
  } as unknown as IAgentContextMemoryService);
  const project = vi.fn((messages: readonly Message[]) => messages);
  ix.set(IAgentContextProjectorService, {
    _serviceBrand: undefined,
    project,
  } as unknown as IAgentContextProjectorService);
  ix.set(ISessionTodoService, {
    _serviceBrand: undefined,
    getTodos: () => [],
  } as unknown as ISessionTodoService);
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IAcpService, new SyncDescriptor(AcpService));
  const service = ix.get(IAcpService);
  return { disposables, requester, service, store, env, project, eventBus: ix.get(IEventBus) };
}

describe('AcpService', () => {
  let owned: DisposableStore[];

  beforeEach(() => {
    owned = [];
  });

  afterEach(() => {
    for (const disposables of owned) disposables.dispose();
  });

  it('registers without sidecar I/O and disposes its manager registration', () => {
    const setup = createService();
    owned.push(setup.disposables);

    expect(setup.requester.manager().id).toBe(ACP_MANAGER_ID);
    expect(setup.store.get).not.toHaveBeenCalled();
    expect(setup.store.set).not.toHaveBeenCalled();

    setup.disposables.dispose();
    expect(setup.requester.registrationDisposed).toHaveBeenCalledOnce();
    owned = [];
  });

  it('persists stable refs while returning the original raw-equivalent messages', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = [textMessage('one'), textMessage('two')];

    const first = await transform(setup.requester.manager(), messages);
    const second = await transform(setup.requester.manager(), messages);

    expect(first).toEqual({ messages, accounting: 'raw-equivalent' });
    expect(first.messages).toBe(messages);
    expect(second.messages).toBe(messages);
    expect(setup.store.set).toHaveBeenCalledOnce();
    const sidecar = setup.store.values.get(
      `sessions/ws/session/agents/main/acp/${ACP_SIDECAR_KEY}`,
    ) as AcpSidecar;
    expect(sidecar.refs.map((record) => record.ref)).toEqual(['m00001', 'm00002']);
    expect(sidecar.refs.every((record) => /^[0-9a-f]{64}$/.test(record.digest))).toBe(true);
    expect(JSON.stringify(sidecar)).not.toContain('one');
    expect(JSON.stringify(sidecar)).not.toContain('two');
    expect(setup.service.status()).toMatchObject({ health: 'healthy', refs: 2 });
  });

  it('fails open instead of transferring refs after an ambiguous duplicate edit', async () => {
    const setup = createService('duplicates');
    owned.push(setup.disposables);
    const duplicate = textMessage('same');
    await transform(setup.requester.manager(), [duplicate, duplicate]);
    const before = structuredClone(setup.store.values);
    const messages = [duplicate];

    const result = await transform(setup.requester.manager(), messages);

    expect(result.messages).toBe(messages);
    expect(setup.service.status()).toMatchObject({
      health: 'degraded',
      reason: 'ACP cannot safely remap an edited duplicate message sequence',
    });
    expect(setup.store.values).toEqual(before);
  });

  it('publishes the acp health slice on the agent event bus while the manager is active', async () => {
    const setup = createService('publish');
    owned.push(setup.disposables);
    const seen: Array<'healthy' | 'degraded'> = [];
    setup.eventBus.subscribe('agent.status.updated', (event) => {
      if (event.acp !== undefined) seen.push(event.acp);
    });
    const duplicate = textMessage('same');

    await transform(setup.requester.manager(), [duplicate, duplicate]);
    expect(seen).toEqual(['healthy']);

    await transform(setup.requester.manager(), [duplicate]);
    expect(seen).toEqual(['healthy', 'degraded']);
  });

  it('stays silent on the event bus while another context manager is active', async () => {
    const setup = createService('suppressed');
    owned.push(setup.disposables);
    const seen: Array<'healthy' | 'degraded'> = [];
    setup.eventBus.subscribe('agent.status.updated', (event) => {
      if (event.acp !== undefined) seen.push(event.acp);
    });
    const requester = setup.requester.service as unknown as {
      getActiveContextManager: () => ContextManager;
    };
    requester.getActiveContextManager = () => ({ id: 'other-manager' }) as ContextManager;
    const duplicate = textMessage('same');

    await transform(setup.requester.manager(), [duplicate, duplicate]);
    await transform(setup.requester.manager(), [duplicate]);
    expect(setup.service.status().health).toBe('degraded');

    await setup.service.reset();
    expect(setup.service.status().health).toBe('healthy');
    expect(seen).toEqual([]);
  });

  it('fails open on load, validation, and save failure without changing durable state', async () => {
    const messages = [textMessage('safe')];
    const loadFailure = createService('load-failure');
    owned.push(loadFailure.disposables);
    loadFailure.store.get.mockRejectedValueOnce(new Error('read failed'));
    const loadResult = await transform(loadFailure.requester.manager(), messages);
    expect(loadResult.messages).toBe(messages);
    expect(loadFailure.store.set).not.toHaveBeenCalled();

    const corrupt = createService('corrupt');
    owned.push(corrupt.disposables);
    corrupt.store.values.set(
      `sessions/ws/session/agents/corrupt/acp/${ACP_SIDECAR_KEY}`,
      { schemaVersion: 99 },
    );
    const corruptResult = await transform(corrupt.requester.manager(), messages);
    expect(corruptResult.messages).toBe(messages);
    expect(corrupt.service.status()).toMatchObject({ health: 'degraded' });

    const failing = createService('failing');
    owned.push(failing.disposables);
    await transform(failing.requester.manager(), [textMessage('durable')]);
    const durable = structuredClone(failing.store.values);
    failing.store.set.mockRejectedValueOnce(new Error('disk full'));
    const saveResult = await transform(failing.requester.manager(), [
      textMessage('durable'),
      textMessage('new'),
    ]);
    expect(saveResult.messages).toBeInstanceOf(Array);
    expect(failing.store.values).toEqual(durable);
    expect(failing.service.status()).toMatchObject({ health: 'degraded', reason: 'disk full', refs: 1 });
  });

  it('rejects invalid allocator state before allocating a duplicate ref', async () => {
    const setup = createService('allocator');
    owned.push(setup.disposables);
    const messages = [textMessage('safe')];
    await transform(setup.requester.manager(), messages);
    const key = `sessions/ws/session/agents/allocator/acp/${ACP_SIDECAR_KEY}`;
    const valid = setup.store.values.get(key) as AcpSidecar;
    setup.store.values.set(key, { ...valid, nextRef: 1 });

    const result = await transform(setup.requester.manager(), [...messages, textMessage('new')]);

    expect(result.accounting).toBe('raw-equivalent');
    expect(result.messages[0]).toBe(messages[0]);
    expect(setup.service.status()).toMatchObject({ health: 'degraded' });
    expect(setup.store.set).toHaveBeenCalledOnce();
  });

  it('rejects aborted transforms before sidecar I/O', async () => {
    const setup = createService('aborted');
    owned.push(setup.disposables);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(transform(setup.requester.manager(), [textMessage('safe')], controller.signal)).rejects.toThrow(
      'cancelled',
    );
    expect(setup.store.get).not.toHaveBeenCalled();
    expect(setup.store.set).not.toHaveBeenCalled();
  });

  it('rejects reset after service disposal without touching storage', async () => {
    const setup = createService('disposed');
    const reset = setup.service.reset.bind(setup.service);
    setup.disposables.dispose();
    owned = [];

    await expect(reset()).rejects.toBeDefined();
    expect(setup.store.delete).not.toHaveBeenCalled();
  });

  it('rejects duplicated live refs as corrupt state', async () => {
    const setup = createService('live-refs');
    owned.push(setup.disposables);
    await transform(setup.requester.manager(), [textMessage('one'), textMessage('two')]);
    const key = `sessions/ws/session/agents/live-refs/acp/${ACP_SIDECAR_KEY}`;
    const valid = setup.store.values.get(key) as AcpSidecar;
    setup.store.values.set(key, { ...valid, liveSequence: ['m00001', 'm00001'] });

    await transform(setup.requester.manager(), [textMessage('one'), textMessage('two')]);

    expect(setup.service.status()).toMatchObject({ health: 'degraded' });
  });

  it('isolates sidecars and reset to the current agent scope', async () => {
    const store = createStore();
    const main = createService('main', store);
    const sub = createService('agent-1', store);
    owned.push(main.disposables, sub.disposables);
    const mainKey = `sessions/ws/session/agents/main/acp/${ACP_SIDECAR_KEY}`;
    const subKey = `sessions/ws/session/agents/agent-1/acp/${ACP_SIDECAR_KEY}`;
    await transform(main.requester.manager(), [textMessage('main')]);
    await transform(sub.requester.manager(), [textMessage('sub')]);
    expect(store.values.has(mainKey)).toBe(true);
    expect(store.values.has(subKey)).toBe(true);

    await sub.service.reset();
    expect(store.values.has(mainKey)).toBe(true);
    expect(store.values.has(subKey)).toBe(false);
  });

  it('compresses a range and folds it out of the next transform', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = bigMessages(10);
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);

    const result = await setup.service.compress({
      ranges: [{ startRef: 'm00001', endRef: 'm00003', summary: SUMMARY, topic: 'opening' }],
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('b1');

    const next = await transform(setup.requester.manager(), messages);
    expect(next.accounting).toBe('transformed');
    expect(next.messages).not.toBe(messages);
    // The kernel always keeps the first user message, so m00001 survives the fold.
    expect(next.messages).toHaveLength(9);
    const summary = next.messages[0]!;
    const rest = next.messages.slice(1);
    expect(summary.role).toBe('system');
    expect(messageText(summary)).toContain('[Compressed conversation section]');
    expect(messageText(summary)).toContain('opening');
    const body = rest.map(messageText).join('\n');
    expect(body).toContain('MARKER-1');
    expect(body).not.toContain('MARKER-2');
    expect(body).not.toContain('MARKER-3');
    expect(body).toContain('MARKER-4');
    expect(body).toContain('MARKER-10');
  });

  it('restores identity after a restart and decompress', async () => {
    const store = createStore();
    const first = createService('main', store);
    owned.push(first.disposables);
    const messages = bigMessages(10);
    first.env.history = messages;
    await transform(first.requester.manager(), messages);
    await first.service.compress({
      ranges: [{ startRef: 'm00001', endRef: 'm00003', summary: SUMMARY }],
    });

    const second = createService('main', store);
    owned.push(second.disposables);
    second.env.history = messages;
    const folded = await transform(second.requester.manager(), messages);
    expect(folded.accounting).toBe('transformed');

    const restored = await second.service.decompress({ blockId: 'b1' });
    expect(restored.ok).toBe(true);
    expect(restored.message).toContain('MARKER-1');
    expect(restored.message).toContain('MARKER-3');

    const identity = await transform(second.requester.manager(), messages);
    expect(identity.accounting).toBe('raw-equivalent');
    expect(identity.messages).toBe(messages);
    const sidecar = second.store.values.get(
      `sessions/ws/session/agents/main/acp/${ACP_SIDECAR_KEY}`,
    ) as AcpSidecar;
    expect(sidecar.refs.map((record) => record.ref)).toEqual(
      Array.from({ length: 10 }, (_, index) => `m${String(index + 1).padStart(5, '0')}`),
    );
  });

  it('finds folded content and its owning block via search', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = bigMessages(10);
    messages[1] = textMessage(`MARKER-2 zqxwvc ${'x'.repeat(3000)}`);
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    await setup.service.compress({
      ranges: [{ startRef: 'm00001', endRef: 'm00003', summary: SUMMARY }],
    });

    const result = await setup.service.search({ query: 'zqxwvc' });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('m00002');
    expect(result.message).toContain('b1');
  });

  it('keeps durable state untouched when the post-compression save fails', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = bigMessages(10);
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    setup.store.set.mockRejectedValueOnce(new Error('disk full'));

    const result = await setup.service.compress({
      ranges: [{ startRef: 'm00001', endRef: 'm00003', summary: SUMMARY }],
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('disk full');
    const sidecar = setup.store.values.get(
      `sessions/ws/session/agents/main/acp/${ACP_SIDECAR_KEY}`,
    ) as AcpSidecar;
    expect((sidecar.compressionState as { blocks: unknown[] }).blocks).toHaveLength(0);
    expect(setup.service.status().blocks).toBe(0);
  });

  it('rejects ranges that are too small or entirely inside the protected zone', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = bigMessages(10);
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);

    const small = await setup.service.compress({
      ranges: [{ startRef: 'm00001', endRef: 'm00001', summary: SUMMARY }],
    });
    expect(small.ok).toBe(false);
    expect(small.message).toContain('too small');

    const protectedZone = await setup.service.compress({
      ranges: [{ startRef: 'm00006', endRef: 'm00008', summary: SUMMARY }],
    });
    expect(protectedZone.ok).toBe(false);
    expect(protectedZone.message).toContain('protected zone');
  });

  it('truncates oversized tool results when the context is full', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const call: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Reading the large file now.' }],
      toolCalls: [
        { type: 'function', id: 'call_1', name: 'read_file', arguments: '{"path":"big.txt"}' },
      ],
    };
    const result: Message = {
      role: 'tool',
      toolCallId: 'call_1',
      name: 'read_file',
      content: [{ type: 'text', text: 'y'.repeat(60_000) }],
      toolCalls: [],
    };
    const trailing = Array.from({ length: 6 }, (_, index) => textMessage(`follow-up ${index + 1}`));
    const messages = [call, result, ...trailing];

    const outcome = await transform(
      setup.requester.manager(),
      messages,
      new AbortController().signal,
      { usedContextTokens: 100_000, maxContextTokens: 100_000 },
    );

    expect(outcome.accounting).toBe('transformed');
    const tool = outcome.messages.find((message) => message.role === 'tool');
    expect(tool).toBeDefined();
    const text = messageText(tool!);
    expect(text).toContain('[truncated for context space]');
    expect(text.length).toBeLessThan(60_000);
    const assistant = outcome.messages.find((message) => message.role === 'assistant');
    expect(assistant?.toolCalls.map((entry) => entry.id)).toEqual(['call_1']);
  });

  it('reports ACP status with health and usage', async () => {
    const setup = createService();
    owned.push(setup.disposables);

    const result = await setup.service.statusReport();

    expect(result.ok).toBe(true);
    expect(result.message).toContain('ACP active');
    expect(result.message).toContain('health: healthy');
  });

  it('fails tools closed when the compression state is corrupt', async () => {
    const setup = createService('corrupt-tools');
    owned.push(setup.disposables);
    const messages = [textMessage('safe')];
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    const key = `sessions/ws/session/agents/corrupt-tools/acp/${ACP_SIDECAR_KEY}`;
    const valid = setup.store.values.get(key) as AcpSidecar;
    setup.store.values.set(key, { ...valid, compressionState: { garbage: true } });

    const result = await setup.service.compress({
      ranges: [{ startRef: 'm00001', endRef: 'm00001', summary: SUMMARY }],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('corrupt');

    const search = await setup.service.search({ query: 'safe' });
    expect(search.ok).toBe(false);
    expect(search.message).toContain('corrupt');
  });

  it('appends an emergency nudge to the turn output when the kernel asks for compression', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = [textMessage('one'), textMessage('two')];

    const outcome = await transform(
      setup.requester.manager(),
      messages,
      new AbortController().signal,
      { usedContextTokens: 85_000, maxContextTokens: 100_000 },
    );

    expect(outcome.accounting).toBe('transformed');
    expect(outcome.messages).not.toBe(messages);
    expect(messages).toHaveLength(2);
    expect(outcome.messages.slice(0, messages.length)).toEqual(messages);
    const nudge = outcome.messages[messages.length]!;
    expect(nudge.role).toBe('system');
    expect(messageText(nudge)).toContain('Context limit reached');
  });

  it('never folds compress tool metadata into a block', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = compressPairHistory();
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);

    const result = await setup.service.compress({
      // Kernel refs run over core messages: m00003 is the compress tool-call
      // core, m00004 its result, m00005 the foldneedle user message.
      ranges: [{ startRef: 'm00001', endRef: 'm00005', summary: SUMMARY }],
      toolCallId: 'call_c1',
    });

    expect(result.ok).toBe(true);
    const sidecar = setup.store.values.get(
      `sessions/ws/session/agents/main/acp/${ACP_SIDECAR_KEY}`,
    ) as AcpSidecar;
    const state = sidecar.compressionState as {
      blocks: {
        readonly effectiveMessageIds: readonly string[];
        readonly compressCallId?: string;
      }[];
    };
    expect(state.blocks[0]!.effectiveMessageIds).toEqual(['m00001', 'm00002', 'm00004']);
    expect(state.blocks[0]!.compressCallId).toBe('call_c1');

    // The recorded compressCallId keeps the call/result pair visible while
    // its block is active; only the folded message bodies leave the view.
    const next = await transform(setup.requester.manager(), messages);
    expect(next.accounting).toBe('transformed');
    const assistant = next.messages.find((message) => message.role === 'assistant');
    expect(assistant?.toolCalls.map((entry) => entry.id)).toEqual(['call_c1']);
    expect(next.messages.some((message) => message.role === 'tool')).toBe(true);
    const body = next.messages.map(messageText).join('\n');
    expect(body).not.toContain('foldneedle');
    expect(body).toContain('MARKER-5');

    // Search speaks kernel refs: the folded foldneedle message is raw m00004,
    // which the model sees as m00005 because the compress pair holds two refs.
    const found = await setup.service.search({ query: 'foldneedle' });
    expect(found.ok).toBe(true);
    expect(found.message).toContain('m00005');
    expect(found.message).toContain('b1');
  });

  it('hides a consumed compress call once its block is distilled away', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = compressPairHistory();
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    const folded = await setup.service.compress({
      ranges: [{ startRef: 'm00001', endRef: 'm00005', summary: SUMMARY }],
      toolCallId: 'call_c1',
    });
    expect(folded.ok).toBe(true);

    const distilled = await setup.service.compress({
      ranges: [
        {
          startRef: 'b1',
          endRef: 'b1',
          summary:
            'Distilled the tier-one opening fold into a single denser tier-two summary block.',
          topic: 'distilled opening',
        },
      ],
    });
    expect(distilled.ok).toBe(true);

    // b1 is consumed by tier-2 b2, so call_c1 is no longer referenced by any
    // active block: the kernel hides the pair, and the rebuild must stay valid.
    const next = await transform(setup.requester.manager(), messages);
    expect(next.accounting).toBe('transformed');
    expect(next.messages.some((message) => message.role === 'assistant')).toBe(false);
    expect(next.messages.some((message) => message.role === 'tool')).toBe(false);
    const summaries = next.messages.filter((message) => message.role === 'system');
    expect(summaries).toHaveLength(1);
    expect(messageText(summaries[0]!)).toContain('distilled opening');
    const body = next.messages.map(messageText).join('\n');
    expect(body).toContain('MARKER-1');
    expect(body).not.toContain('foldneedle');
    expect(setup.service.status()).toMatchObject({ health: 'healthy', blocks: 2 });
  });

  it('degrades to the untouched input when the persisted compression state is corrupt', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = bigMessages(10);
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    const key = `sessions/ws/session/agents/main/acp/${ACP_SIDECAR_KEY}`;
    const valid = setup.store.values.get(key) as AcpSidecar;
    const corrupted = { ...valid, compressionState: { garbage: true } };
    setup.store.values.set(key, corrupted);

    const outcome = await transform(setup.requester.manager(), messages);

    expect(outcome.accounting).toBe('raw-equivalent');
    expect(outcome.messages).toBe(messages);
    expect(setup.service.status().health).toBe('degraded');
    expect(setup.store.values.get(key)).toEqual(corrupted);
  });

  it('reports live context usage in the status report', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = [textMessage('one'), textMessage('two')];
    await transform(setup.requester.manager(), messages, new AbortController().signal, {
      usedContextTokens: 85_000,
      maxContextTokens: 100_000,
    });

    const result = await setup.service.statusReport();

    expect(result.ok).toBe(true);
    expect(result.message).toContain('85.0%');
    expect(result.message).toContain('85000');
  });

  it('appends the emergency nudge on every turn while over the threshold', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = [textMessage('one'), textMessage('two')];
    const limits = { usedContextTokens: 85_000, maxContextTokens: 100_000 };

    const first = await transform(
      setup.requester.manager(),
      messages,
      new AbortController().signal,
      limits,
    );
    const second = await transform(
      setup.requester.manager(),
      messages,
      new AbortController().signal,
      limits,
    );

    for (const outcome of [first, second]) {
      expect(outcome.accounting).toBe('transformed');
      const nudge = outcome.messages[outcome.messages.length - 1]!;
      expect(nudge.role).toBe('system');
      expect(messageText(nudge)).toContain('Context limit reached');
    }
  });

  it('unwinds nested blocks level by level and restores folded content', async () => {
    const messages = compressPairHistory();
    const distillRange = {
      startRef: 'b1',
      endRef: 'b1',
      summary: 'Distilled the tier-one opening fold into a single denser tier-two summary block.',
    };
    const key = `sessions/ws/session/agents/main/acp/${ACP_SIDECAR_KEY}`;

    // (a) Shallow decompress reactivates the tier-one block; a second
    // decompress restores the folded message bodies.
    const shallow = createService();
    owned.push(shallow.disposables);
    shallow.env.history = messages;
    await transform(shallow.requester.manager(), messages);
    await shallow.service.compress({
      ranges: [{ startRef: 'm00001', endRef: 'm00005', summary: SUMMARY }],
      toolCallId: 'call_c1',
    });
    await shallow.service.compress({ ranges: [distillRange] });

    const undistilled = await shallow.service.decompress({ blockId: 'b2' });
    expect(undistilled.ok).toBe(true);
    const afterShallow = shallow.store.values.get(key) as AcpSidecar;
    expect(
      (afterShallow.compressionState as { blocks: { blockId: string }[] }).blocks.map(
        (block) => block.blockId,
      ),
    ).toEqual(['b1']);

    const refolded = await transform(shallow.requester.manager(), messages);
    expect(refolded.accounting).toBe('transformed');
    const refoldedBody = refolded.messages.map(messageText).join('\n');
    expect(refoldedBody).toContain('[Compressed conversation section]');
    expect(refoldedBody).toContain('Folded the opening investigation segment');
    expect(refoldedBody).not.toContain('foldneedle');

    const unfolded = await shallow.service.decompress({ blockId: 'b1' });
    expect(unfolded.ok).toBe(true);
    // Fully unwound: every folded body is back in the view. The compress
    // call/result pair stays hidden — with no active block referencing it,
    // the kernel treats the pair as consumed metadata, not content.
    const unwound = await transform(shallow.requester.manager(), messages);
    expect(unwound.accounting).toBe('transformed');
    expect(unwound.messages).toHaveLength(messages.length - 1);
    const unwoundBody = unwound.messages.map(messageText).join('\n');
    expect(unwoundBody).toContain('foldneedle');
    expect(unwoundBody).toContain('MARKER-9');
    expect(unwound.messages.some((message) => message.role === 'tool')).toBe(false);
    const unwoundAssistant = unwound.messages.find((message) => message.role === 'assistant');
    expect(unwoundAssistant?.toolCalls).toHaveLength(0);
    expect(shallow.service.status().health).toBe('healthy');

    // (b) A full decompress of the tier-two block unwinds the whole chain.
    const full = createService('main', createStore());
    owned.push(full.disposables);
    full.env.history = messages;
    await transform(full.requester.manager(), messages);
    await full.service.compress({
      ranges: [{ startRef: 'm00001', endRef: 'm00005', summary: SUMMARY }],
      toolCallId: 'call_c1',
    });
    await full.service.compress({ ranges: [distillRange] });

    const restored = await full.service.decompress({ blockId: 'b2', full: true });
    expect(restored.ok).toBe(true);
    const afterFull = full.store.values.get(key) as AcpSidecar;
    expect((afterFull.compressionState as { blocks: unknown[] }).blocks).toHaveLength(0);
    const fullUnwound = await transform(full.requester.manager(), messages);
    expect(fullUnwound.accounting).toBe('transformed');
    const fullBody = fullUnwound.messages.map(messageText).join('\n');
    expect(fullBody).toContain('foldneedle');
    expect(fullBody).toContain('MARKER-9');
    expect(fullUnwound.messages.some((message) => message.role === 'tool')).toBe(false);
  });

  it('emits the kernel-filtered compress arguments once a range is distilled away', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const bigUser = (marker: string): Message => textMessage(`${marker} ${'x'.repeat(6000)}`);
    const foldArgs = `{"content":[{"startId":"m00001","endId":"m00002","summary":"${SUMMARY}"},{"startId":"m00003","endId":"m00003","summary":"${SUMMARY}"}]}`;
    const compressCall: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Folding both ranges.' }],
      toolCalls: [
        { type: 'function', id: 'call_c1', name: 'compress', arguments: foldArgs },
      ],
    };
    const compressResult: Message = {
      role: 'tool',
      toolCallId: 'call_c1',
      name: 'compress',
      content: [{ type: 'text', text: '{"ok":true}' }],
      toolCalls: [],
    };
    const messages: Message[] = [
      ...Array.from({ length: 8 }, (_, index) => bigUser(`MARKER-${index + 1}`)),
      compressCall,
      compressResult,
    ];
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);

    const folded = await setup.service.compress({
      // Core refs: m00001..m00008 are the user messages, m00009 the assistant
      // text, m00010 the compress call core, m00011 its result.
      ranges: [
        { startRef: 'm00001', endRef: 'm00002', summary: SUMMARY },
        { startRef: 'm00003', endRef: 'm00003', summary: SUMMARY },
      ],
      toolCallId: 'call_c1',
    });
    expect(folded.ok).toBe(true);

    const distilled = await setup.service.compress({
      ranges: [
        {
          startRef: 'b1',
          endRef: 'b1',
          summary: 'Distilled the tier-one fold A into a single denser tier-two summary block.',
        },
      ],
    });
    expect(distilled.ok).toBe(true);

    // b1 is consumed, b2 still references call_c1: the call pair survives but
    // the kernel filters the consumed range out of its arguments.
    const next = await transform(setup.requester.manager(), messages);
    expect(next.accounting).toBe('transformed');
    const assistant = next.messages.find((message) => message.role === 'assistant');
    expect(assistant?.toolCalls).toHaveLength(1);
    expect(assistant?.toolCalls[0]).toMatchObject({ id: 'call_c1', name: 'compress' });
    expect(assistant?.toolCalls[0]!.arguments).toBe(
      `{"content":[{"startId":"m00003","endId":"m00003","summary":"${SUMMARY}"}]}`,
    );
    expect(setup.service.status().health).toBe('healthy');
  });

  it('re-projects the tool view when an undo plus edit keeps the history length', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = bigMessages(10);
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    const folded = await setup.service.compress({
      ranges: [{ startRef: 'm00001', endRef: 'm00003', summary: SUMMARY }],
    });
    expect(folded.ok).toBe(true);

    // Undo drops the tail message and a new one lands: the history length is
    // unchanged, so only the snapshot prefix check notices the divergence.
    setup.env.history = [...messages.slice(0, 9), textMessage('fresh tail marker')];

    const gone = await setup.service.search({ query: 'MARKER-10' });
    expect(gone.ok).toBe(true);
    expect(gone.message).not.toContain('MARKER-10 x');
    const kept = await setup.service.search({ query: 'fresh tail' });
    expect(kept.ok).toBe(true);
    expect(kept.message).toContain('fresh tail');
  });

  it('reuses the tool view when the requester hands over a cloned history', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = bigMessages(10);
    setup.env.history = messages;
    // The real requester passes structuredClone(history) to the manager, so
    // the transform input never reference-matches the live history; the view
    // snapshot must be taken from the live side instead.
    await transform(setup.requester.manager(), structuredClone(messages));

    const result = await setup.service.search({ query: 'MARKER-7' });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('m00007');
    expect(setup.project).not.toHaveBeenCalled();
  });
});
