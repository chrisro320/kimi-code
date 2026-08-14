import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { Event } from '#/_base/event';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { buildCompactionSummaryText } from '#/agent/contextMemory/compactionHandoff';
import {
  IAgentContextMemoryService,
  type ContextCompactionInput,
  type ContextCompactionResult,
} from '#/agent/contextMemory/contextMemory';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import type { FullCompactionTask } from '#/agent/fullCompaction/fullCompaction';
import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
  type CompactDelegation,
  type ContextManager,
  type IAgentLLMRequesterService as AgentLLMRequester,
} from '#/agent/llmRequester/llmRequester';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAcpService } from '#/features/acp/acp';
import { AcpService } from '#/features/acp/acpService';
import { ACP_SIDECAR_KEY, type AcpSidecar } from '#/features/acp/sidecar';
import { APIContextOverflowError } from '#/kosong/contract/errors';
import type { ContentPart, Message } from '#/kosong/contract/message';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import type { TodoItem } from '#/session/todo/todoItem';
import type { CompressionState } from 'acp-kernel';

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
  readonly startInternal: ReturnType<typeof vi.fn>;
} {
  let registered: ContextManager | undefined;
  const startInternal = vi.fn(() => {
    throw new Error('startInternal was called without a mock implementation');
  });
  const service = {
    _serviceBrand: undefined,
    registerContextManager: (manager: ContextManager) => {
      registered = manager;
      return { dispose: vi.fn() };
    },
    getActiveContextManager: () => registered,
    startInternal,
  } as unknown as AgentLLMRequester;
  return {
    service,
    manager: () => {
      if (registered === undefined) throw new Error('manager was not registered');
      return registered;
    },
    startInternal,
  };
}

function textMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function assistantMessage(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

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

function makeFinish(text: string, options: { readonly truncated?: boolean } = {}): AgentLLMRequestFinish {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
    usage: { inputOther: 10, output: 42, inputCacheRead: 0, inputCacheCreation: 0 },
    providerFinishReason: options.truncated === true ? 'truncated' : 'stop',
  } as unknown as AgentLLMRequestFinish;
}

function makeTask(): FullCompactionTask {
  return {
    abortController: new AbortController(),
    promise: Promise.resolve({} as never),
    trigger: 'manual',
    tokenCount: 12_345,
    originTurnId: 7,
  } as unknown as FullCompactionTask;
}

function createService(agentId = 'main', store = createStore()) {
  const disposables = new DisposableStore();
  const ix = disposables.add(new TestInstantiationService());
  const requester = createRequester();
  const env: { history: readonly Message[] } = { history: [] };
  const todos: { current: readonly TodoItem[] } = { current: [] };
  const applyCompaction = vi.fn((input: ContextCompactionInput): ContextCompactionResult => ({
    summary: input.summary,
    contextSummary: input.contextSummary ?? '',
    compactedCount: input.compactedCount,
    tokensBefore: input.tokensBefore,
    tokensAfter: 500,
    keptUserMessageCount: 0,
  }));
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
    applyCompaction,
  } as unknown as IAgentContextMemoryService);
  ix.set(IAgentContextProjectorService, {
    _serviceBrand: undefined,
    project: (messages: readonly Message[]) => messages,
  } as unknown as IAgentContextProjectorService);
  ix.set(ISessionTodoService, {
    _serviceBrand: undefined,
    getTodos: () => todos.current,
  } as unknown as ISessionTodoService);
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IAcpService, new SyncDescriptor(AcpService));
  const service = ix.get(IAcpService);
  return { disposables, requester, service, store, env, todos, applyCompaction };
}

function transform(manager: ContextManager, messages: readonly Message[]) {
  return manager.transformMessages({
    messages,
    usedContextTokens: 0,
    maxContextTokens: 100_000,
    signal: new AbortController().signal,
  });
}

function willCompact(
  manager: ContextManager,
  input: { readonly instruction?: string } = {},
  signal = new AbortController().signal,
): Promise<CompactDelegation> {
  return Promise.resolve(
    manager.onWillCompact!({
      task: makeTask(),
      input: { source: 'manual', ...(input.instruction === undefined ? {} : { instruction: input.instruction }) },
      signal,
    }),
  );
}

const SIDECAR_KEY = `sessions/ws/session/agents/main/acp/${ACP_SIDECAR_KEY}`;

describe('AcpService compaction takeover', () => {
  let owned: DisposableStore[];

  beforeEach(() => {
    owned = [];
  });

  afterEach(() => {
    for (const disposables of owned) disposables.dispose();
  });

  it('takes over: summarizes the compacted view, persists the sidecar before the fold, returns the receipt', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = bigMessages(10);
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    await setup.service.compress({
      ranges: [
        {
          startRef: 'm00001',
          endRef: 'm00003',
          summary: 'Folded the opening investigation segment covering setup and markers one to three.',
          topic: 'opening',
        },
      ],
    });
    const folded = await transform(setup.requester.manager(), messages);
    expect(folded.accounting).toBe('transformed');
    const sidecarBefore = setup.store.values.get(SIDECAR_KEY) as AcpSidecar;
    const stateBefore = sidecarBefore.compressionState as CompressionState;
    expect(stateBefore.stats.tokensCompressed).toBeGreaterThan(0);
    setup.todos.current = [{ title: 'Ship the takeover', status: 'in_progress' }];
    setup.requester.startInternal.mockImplementation(() => ({
      trace: undefined,
      result: Promise.resolve(makeFinish('ACP fold summary.')),
    }));

    const delegation = await willCompact(setup.requester.manager(), {
      instruction: 'keep the API notes',
    });

    expect(delegation.handled).toBe(true);
    const call = setup.requester.startInternal.mock.calls[0]!;
    expect(call[0]).toEqual({ manager: undefined, transform: 'bypass' });
    const overrides = call[1]!;
    expect(overrides.tools).toEqual([]);
    expect(overrides.source).toEqual({
      type: 'operation',
      turnId: 7,
      requestKind: 'acp_compaction',
    });
    const requestMessages = overrides.messages!;
    expect(requestMessages).toHaveLength(folded.messages.length + 1);
    folded.messages.forEach((message, index) => {
      expect(requestMessages[index]).toBe(message);
    });
    const requestBody = requestMessages.map(messageText).join('\n');
    expect(requestBody).not.toContain('MARKER-2');
    expect(requestBody).toContain('[Compressed conversation section]');
    expect(messageText(requestMessages[requestMessages.length - 1]!)).toContain(
      'Optional user instruction:\nkeep the API notes',
    );

    // Durable order: the sidecar reset lands before the fold receipt.
    const setOrders = setup.store.set.mock.invocationCallOrder;
    const foldOrder = setup.applyCompaction.mock.invocationCallOrder[0]!;
    expect(setOrders[setOrders.length - 1]!).toBeLessThan(foldOrder);

    const foldInput = setup.applyCompaction.mock.calls[0]![0] as ContextCompactionInput;
    expect(foldInput.compactedCount).toBe(messages.length);
    expect(foldInput.tokensBefore).toBe(12_345);
    expect(foldInput.summaryOutputTokens).toBe(42);
    expect(foldInput.summary).toContain('ACP fold summary.');
    expect(foldInput.summary).toContain('## TODO List');
    expect(foldInput.summary).toContain('Ship the takeover');
    expect(foldInput.contextSummary).toBe(buildCompactionSummaryText(foldInput.summary));
    expect(delegation).toEqual({
      handled: true,
      result: {
        summary: foldInput.summary,
        contextSummary: foldInput.contextSummary,
        compactedCount: messages.length,
        tokensBefore: 12_345,
        tokensAfter: 500,
        keptUserMessageCount: 0,
      },
    });

    const sidecarAfter = setup.store.values.get(SIDECAR_KEY) as AcpSidecar;
    const stateAfter = sidecarAfter.compressionState as CompressionState;
    expect(stateAfter.blocks).toEqual([]);
    expect(stateAfter.stats).toEqual(stateBefore.stats);
    expect(sidecarAfter.refs).toEqual(sidecarBefore.refs);
    expect(sidecarAfter.nextRef).toBe(sidecarBefore.nextRef);
    expect(setup.service.status()).toMatchObject({ health: 'healthy', blocks: 0, refs: 10 });

    // The cached view is dropped: a second round declines until a new turn runs.
    expect(await willCompact(setup.requester.manager())).toEqual({ handled: false });
  });

  it('declines to the built-in round without a healthy reusable view', async () => {
    // No turn since enable: no lastView at all.
    const fresh = createService('fresh');
    owned.push(fresh.disposables);
    fresh.env.history = [textMessage('one')];
    expect(await willCompact(fresh.requester.manager())).toEqual({ handled: false });
    expect(fresh.requester.startInternal).not.toHaveBeenCalled();

    // Empty live history.
    const empty = createService('empty');
    owned.push(empty.disposables);
    expect(await willCompact(empty.requester.manager())).toEqual({ handled: false });
    expect(empty.requester.startInternal).not.toHaveBeenCalled();

    // Live history grew after the last transform (e.g. a PreCompact append).
    const grown = createService('grown');
    owned.push(grown.disposables);
    const base = [textMessage('one'), textMessage('two')];
    grown.env.history = base;
    await transform(grown.requester.manager(), base);
    grown.env.history = [...base, textMessage('three')];
    expect(await willCompact(grown.requester.manager())).toEqual({ handled: false });
    expect(grown.requester.startInternal).not.toHaveBeenCalled();
    expect(grown.applyCompaction).not.toHaveBeenCalled();

    // Same length but edited in place (undo + regrow).
    const edited = createService('edited');
    owned.push(edited.disposables);
    edited.env.history = base;
    await transform(edited.requester.manager(), base);
    edited.env.history = [textMessage('one'), textMessage('TWO')];
    expect(await willCompact(edited.requester.manager())).toEqual({ handled: false });
    expect(edited.requester.startInternal).not.toHaveBeenCalled();

    // Degraded health.
    const corrupt = createService('corrupt');
    owned.push(corrupt.disposables);
    corrupt.store.values.set(SIDECAR_KEY.replace('/main/', '/corrupt/'), { schemaVersion: 99 });
    corrupt.env.history = base;
    await transform(corrupt.requester.manager(), base);
    expect(corrupt.service.status().health).toBe('degraded');
    expect(await willCompact(corrupt.requester.manager())).toEqual({ handled: false });
    expect(corrupt.requester.startInternal).not.toHaveBeenCalled();
  });

  it('propagates a summarizer failure without any durable mutation', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = [textMessage('one'), textMessage('two')];
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    const setCalls = setup.store.set.mock.calls.length;
    setup.requester.startInternal.mockImplementation(() => ({
      trace: undefined,
      result: Promise.reject(new Error('provider down')),
    }));

    await expect(willCompact(setup.requester.manager())).rejects.toThrow('provider down');
    expect(setup.store.set.mock.calls.length).toBe(setCalls);
    expect(setup.applyCompaction).not.toHaveBeenCalled();
    expect(setup.service.status().health).toBe('healthy');
  });

  it('fails the round on a truncated or empty summary', async () => {
    const truncated = createService('truncated');
    owned.push(truncated.disposables);
    const messages = [textMessage('one')];
    truncated.env.history = messages;
    await transform(truncated.requester.manager(), messages);
    truncated.requester.startInternal.mockImplementation(() => ({
      trace: undefined,
      result: Promise.resolve(makeFinish('partial', { truncated: true })),
    }));
    await expect(willCompact(truncated.requester.manager())).rejects.toThrow('truncated');
    expect(truncated.applyCompaction).not.toHaveBeenCalled();

    const empty = createService('empty-summary');
    owned.push(empty.disposables);
    empty.env.history = messages;
    await transform(empty.requester.manager(), messages);
    empty.requester.startInternal.mockImplementation(() => ({
      trace: undefined,
      result: Promise.resolve(makeFinish('   ')),
    }));
    await expect(willCompact(empty.requester.manager())).rejects.toThrow('non-empty summary');
    expect(empty.applyCompaction).not.toHaveBeenCalled();
  });

  it('throws when the sidecar save fails, leaving the context unfolded', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = [textMessage('one'), textMessage('two')];
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    setup.requester.startInternal.mockImplementation(() => ({
      trace: undefined,
      result: Promise.resolve(makeFinish('ACP fold summary.')),
    }));
    setup.store.set.mockRejectedValueOnce(new Error('disk full'));

    await expect(willCompact(setup.requester.manager())).rejects.toThrow('disk full');
    expect(setup.applyCompaction).not.toHaveBeenCalled();
    expect(setup.service.status().health).toBe('healthy');
  });

  it('aborts when the live history gains non-user messages mid-round', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = [textMessage('one'), textMessage('two')];
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    const setCalls = setup.store.set.mock.calls.length;
    setup.requester.startInternal.mockImplementation(() => ({
      trace: undefined,
      result: (async () => {
        setup.env.history = [...messages, assistantMessage('late assistant output')];
        return makeFinish('ACP fold summary.');
      })(),
    }));

    const failure = await willCompact(setup.requester.manager()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('AbortError');
    expect(setup.store.set.mock.calls.length).toBe(setCalls);
    expect(setup.applyCompaction).not.toHaveBeenCalled();
  });

  it('still folds when only real user input arrived mid-round', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = [textMessage('one'), textMessage('two')];
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    setup.requester.startInternal.mockImplementation(() => ({
      trace: undefined,
      result: (async () => {
        setup.env.history = [...messages, textMessage('late user input')];
        return makeFinish('ACP fold summary.');
      })(),
    }));

    const delegation = await willCompact(setup.requester.manager());
    expect(delegation.handled).toBe(true);
    expect(setup.applyCompaction.mock.calls[0]![0]).toMatchObject({
      compactedCount: messages.length,
    });
  });

  it('rejects an already-aborted signal before any I/O', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = [textMessage('one')];
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    const getCalls = setup.store.get.mock.calls.length;
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      willCompact(setup.requester.manager(), {}, controller.signal),
    ).rejects.toThrow('cancelled');
    expect(setup.requester.startInternal).not.toHaveBeenCalled();
    expect(setup.store.get.mock.calls.length).toBe(getCalls);
    expect(setup.applyCompaction).not.toHaveBeenCalled();
  });

  it('declines after compress or decompress invalidated the cached view', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = bigMessages(10);
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    const compressResult = await setup.service.compress({
      ranges: [
        {
          startRef: 'm00001',
          endRef: 'm00003',
          summary: 'Folded the first three markers into a durable compressed block for the test.',
          topic: 'opening',
        },
      ],
    });
    expect(compressResult.ok).toBe(true);

    // compress() reset the kernel state; the pre-compress view must not drive
    // a takeover even though no new turn ran.
    expect(await willCompact(setup.requester.manager())).toEqual({ handled: false });
    expect(setup.requester.startInternal).not.toHaveBeenCalled();
    expect(setup.applyCompaction).not.toHaveBeenCalled();

    // Same after decompress(): the fresh view built on the compressed state is
    // dropped when the block unfolds.
    const sidecar = setup.store.values.get(SIDECAR_KEY) as AcpSidecar;
    const blockId = (sidecar.compressionState as CompressionState).blocks[0]!.blockId;
    await transform(setup.requester.manager(), messages);
    await setup.service.decompress({ blockId });
    expect(await willCompact(setup.requester.manager())).toEqual({ handled: false });
    expect(setup.requester.startInternal).not.toHaveBeenCalled();
    expect(setup.applyCompaction).not.toHaveBeenCalled();
  });

  it('declines when the summarizer request overflows, leaving state untouched', async () => {
    const setup = createService();
    owned.push(setup.disposables);
    const messages = [textMessage('one'), textMessage('two')];
    setup.env.history = messages;
    await transform(setup.requester.manager(), messages);
    const setCalls = setup.store.set.mock.calls.length;
    setup.requester.startInternal.mockImplementation(() => ({
      trace: undefined,
      result: Promise.reject(new APIContextOverflowError(400, 'Context length exceeded', 'req-x')),
    }));

    await expect(willCompact(setup.requester.manager())).resolves.toEqual({ handled: false });
    expect(setup.store.set.mock.calls.length).toBe(setCalls);
    expect(setup.applyCompaction).not.toHaveBeenCalled();
    expect(setup.service.status().health).toBe('healthy');
  });
});
