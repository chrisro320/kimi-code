import { createControlledPromise } from '@antfu/utils';
import { describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event2 } from '#/app/event/event2';
import type { IEventBus } from '#/app/event/eventBus';
import { IEventBus as IEventBusToken } from '#/app/event/eventBus';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentLifecycleService as IAgentLifecycleServiceToken } from '#/session/agentLifecycle/agentLifecycle';
import type { ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionSubagentService as ISessionSubagentServiceToken } from '#/session/subagent/subagent';

import { mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';

interface BusStub {
  readonly bus: IEventBus;
  readonly publish: ReturnType<typeof vi.fn>;
  readonly handlers: Map<unknown, (event: Event2<any>) => void>;
  readonly disposed: ReturnType<typeof vi.fn>;
}

function busStub(): BusStub {
  const handlers = new Map<unknown, (event: Event2<any>) => void>();
  const publish = vi.fn();
  const disposed = vi.fn();
  const bus = {
    _serviceBrand: undefined,
    publish,
    subscribe: vi.fn((...args: unknown[]) => {
      const key = args.length === 2 ? args[0] : undefined;
      const handler = (args.length === 2 ? args[1] : args[0]) as (event: Event2<any>) => void;
      if (key !== undefined) handlers.set(key, handler);
      return {
        dispose: () => {
          if (key !== undefined) handlers.delete(key);
          disposed();
        },
      } as IDisposable;
    }),
  } as unknown as IEventBus;
  return { bus, publish, handlers, disposed };
}

function dispatcherStub() {
  return {
    _serviceBrand: undefined,
    hooks: { onDidRestore: { register: () => ({ dispose: () => {} }) } },
    dispatch: vi.fn(async () => {}),
    flush: async () => {},
    restore: async () => {},
  } as unknown as IEventDispatcher & { dispatch: ReturnType<typeof vi.fn> };
}

function requesterHandle(
  requesterBus: IEventBus,
  dispatcher: IEventDispatcher,
  lifecycle: IAgentLifecycleService,
  subagents: ISessionSubagentService,
): IAgentScopeHandle {
  return {
    id: 'main',
    kind: 3,
    accessor: {
      get: ((serviceId: unknown) => {
        if (serviceId === IEventDispatcher) return dispatcher;
        if (serviceId === IAgentLifecycleServiceToken) return lifecycle;
        if (serviceId === ISessionSubagentServiceToken) return subagents;
        return undefined;
      }) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
    // `as unknown` because 0.34.0 widened IAgentScopeHandle past what this
    // partial stub covers; matching the other stubs in this file.
  } as unknown as IAgentScopeHandle;
}

const USAGE = { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 };

function subagentsStub(): ISessionSubagentService {
  return {
    _serviceBrand: undefined,
    hooks: { onWillStartAgentTask: { run: async () => {} } },
    notifyAgentTaskStopped: vi.fn(),
  } as unknown as ISessionSubagentService;
}

describe('mirrorAgentRun subagent.progress', () => {
  it("forwards the child's live usage totals as subagent.progress on the requester stream", async () => {
    const requester = busStub();
    const child = busStub();
    const dispatcher = dispatcherStub();
    const lifecycle = {
      findAgentHandle: (agentId: string) =>
        agentId === 'child-1'
          ? ({
              id: 'child-1',
              accessor: {
                get: (id: unknown) => {
                  if (id === IEventBusToken) return child.bus;
                  return undefined;
                },
              },
            } as unknown as IAgentScopeHandle)
          : undefined,
    } as unknown as IAgentLifecycleService;
    const completion = createControlledPromise<{ summary: string }>();
    const mirrored = mirrorAgentRun(
      requesterHandle(requester.bus, dispatcher, lifecycle, subagentsStub()),
      { agentId: 'child-1', turn: {} as never, completion },
      { profileName: 'coder', signal: new AbortController().signal },
    );

    child.handlers.get(AgentStatusUpdated)?.(new AgentStatusUpdated({ agentId: 'main', usage: { total: USAGE } }));
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'subagent.progress',
        subagentId: 'child-1',
        usage: USAGE,
      }),
    );

    // No usage total → no progress event.
    dispatcher.dispatch.mockClear();
    child.handlers.get(AgentStatusUpdated)?.(new AgentStatusUpdated({ agentId: 'main', usage: {} }));
    child.handlers.get(AgentStatusUpdated)?.(new AgentStatusUpdated({ agentId: 'main' }));
    expect(dispatcher.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subagent.progress' }),
    );

    // The subscription dies with the run: no progress after settle.
    completion.resolve({ summary: 'done' });
    await expect(mirrored).resolves.toEqual({ summary: 'done' });
    expect(child.disposed).toHaveBeenCalledOnce();
    dispatcher.dispatch.mockClear();
    child.handlers.get(AgentStatusUpdated)?.(new AgentStatusUpdated({ agentId: 'main', usage: { total: USAGE } }));
    expect(dispatcher.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subagent.progress' }),
    );
  });

  it('disposes the progress subscription when the run fails', async () => {
    const requester = busStub();
    const child = busStub();
    const dispatcher = dispatcherStub();
    const lifecycle = {
      findAgentHandle: (agentId: string) =>
        agentId === 'child-1'
          ? ({
              id: 'child-1',
              accessor: { get: (id: unknown) => (id === IEventBusToken ? child.bus : undefined) },
            } as unknown as IAgentScopeHandle)
          : undefined,
    } as unknown as IAgentLifecycleService;
    const mirrored = mirrorAgentRun(
      requesterHandle(requester.bus, dispatcher, lifecycle, subagentsStub()),
      { agentId: 'child-1', turn: {} as never, completion: Promise.reject(new Error('boom')) },
      { profileName: 'coder', signal: new AbortController().signal },
    );

    await expect(mirrored).rejects.toThrow('boom');
    expect(child.disposed).toHaveBeenCalledOnce();
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'subagent.failed',
        subagentId: 'child-1',
        error: 'boom',
      }),
    );
  });

  it('mirrors without progress forwarding when the child handle is gone', async () => {
    const requester = busStub();
    const dispatcher = dispatcherStub();
    const lifecycle = { findAgentHandle: () => undefined } as unknown as IAgentLifecycleService;
    const mirrored = mirrorAgentRun(
      requesterHandle(requester.bus, dispatcher, lifecycle, subagentsStub()),
      { agentId: 'child-1', turn: {} as never, completion: Promise.resolve({ summary: 'done' }) },
      { profileName: 'coder', signal: new AbortController().signal },
    );

    await expect(mirrored).resolves.toEqual({ summary: 'done' });
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subagent.completed', subagentId: 'child-1' }),
    );
  });
});
