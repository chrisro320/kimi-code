import { createControlledPromise } from '@antfu/utils';
import { describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { DomainEvent, IEventBus } from '#/app/event/eventBus';
import { IEventBus as IEventBusToken } from '#/app/event/eventBus';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentLifecycleService as IAgentLifecycleServiceToken } from '#/session/agentLifecycle/agentLifecycle';
import type { ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionSubagentService as ISessionSubagentServiceToken } from '#/session/subagent/subagent';

import { mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';

interface BusStub {
  readonly bus: IEventBus;
  readonly publish: ReturnType<typeof vi.fn>;
  readonly handlers: Map<string, (event: DomainEvent) => void>;
  readonly disposed: ReturnType<typeof vi.fn>;
}

function busStub(): BusStub {
  const handlers = new Map<string, (event: DomainEvent) => void>();
  const publish = vi.fn();
  const disposed = vi.fn();
  const bus = {
    _serviceBrand: undefined,
    publish,
    subscribe: vi.fn((...args: unknown[]) => {
      const type = args.length === 2 ? (args[0] as string) : undefined;
      const handler = (args.length === 2 ? args[1] : args[0]) as (event: DomainEvent) => void;
      if (type !== undefined) handlers.set(type, handler);
      return {
        dispose: () => {
          if (type !== undefined) handlers.delete(type);
          disposed();
        },
      } as IDisposable;
    }),
  } as unknown as IEventBus;
  return { bus, publish, handlers, disposed };
}

function requesterHandle(
  requesterBus: IEventBus,
  lifecycle: IAgentLifecycleService,
  subagents: ISessionSubagentService,
): IAgentScopeHandle {
  return {
    id: 'main',
    kind: 3,
    accessor: {
      get: ((serviceId: unknown) => {
        if (serviceId === IEventBusToken) return requesterBus;
        if (serviceId === IAgentLifecycleServiceToken) return lifecycle;
        if (serviceId === ISessionSubagentServiceToken) return subagents;
        return undefined;
      }) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
  } as IAgentScopeHandle;
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
    const lifecycle = {
      get: (agentId: string) =>
        agentId === 'child-1'
          ? ({
              id: 'child-1',
              accessor: { get: (id: unknown) => (id === IEventBusToken ? child.bus : undefined) },
            } as unknown as IAgentScopeHandle)
          : undefined,
    } as unknown as IAgentLifecycleService;
    const completion = createControlledPromise<{ summary: string }>();
    const mirrored = mirrorAgentRun(
      requesterHandle(requester.bus, lifecycle, subagentsStub()),
      { agentId: 'child-1', turn: {} as never, completion },
      { profileName: 'coder', signal: new AbortController().signal },
    );

    child.handlers.get('agent.status.updated')?.({
      type: 'agent.status.updated',
      usage: { total: USAGE },
    } as DomainEvent);
    expect(requester.publish).toHaveBeenCalledWith({
      type: 'subagent.progress',
      subagentId: 'child-1',
      usage: USAGE,
    });

    // No usage total → no progress event.
    requester.publish.mockClear();
    child.handlers.get('agent.status.updated')?.({
      type: 'agent.status.updated',
      usage: {},
    } as DomainEvent);
    child.handlers.get('agent.status.updated')?.({
      type: 'agent.status.updated',
    } as DomainEvent);
    expect(requester.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subagent.progress' }),
    );

    // The subscription dies with the run: no progress after settle.
    completion.resolve({ summary: 'done' });
    await expect(mirrored).resolves.toEqual({ summary: 'done' });
    expect(child.disposed).toHaveBeenCalledOnce();
    requester.publish.mockClear();
    child.handlers.get('agent.status.updated')?.({
      type: 'agent.status.updated',
      usage: { total: USAGE },
    } as DomainEvent);
    expect(requester.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subagent.progress' }),
    );
  });

  it('disposes the progress subscription when the run fails', async () => {
    const requester = busStub();
    const child = busStub();
    const lifecycle = {
      get: (agentId: string) =>
        agentId === 'child-1'
          ? ({
              id: 'child-1',
              accessor: { get: (id: unknown) => (id === IEventBusToken ? child.bus : undefined) },
            } as unknown as IAgentScopeHandle)
          : undefined,
    } as unknown as IAgentLifecycleService;
    const mirrored = mirrorAgentRun(
      requesterHandle(requester.bus, lifecycle, subagentsStub()),
      { agentId: 'child-1', turn: {} as never, completion: Promise.reject(new Error('boom')) },
      { profileName: 'coder', signal: new AbortController().signal },
    );

    await expect(mirrored).rejects.toThrow('boom');
    expect(child.disposed).toHaveBeenCalledOnce();
    expect(requester.publish).toHaveBeenCalledWith({
      type: 'subagent.failed',
      subagentId: 'child-1',
      error: 'boom',
    });
  });

  it('mirrors without progress forwarding when the child handle is gone', async () => {
    const requester = busStub();
    const lifecycle = { get: () => undefined } as unknown as IAgentLifecycleService;
    const mirrored = mirrorAgentRun(
      requesterHandle(requester.bus, lifecycle, subagentsStub()),
      { agentId: 'child-1', turn: {} as never, completion: Promise.resolve({ summary: 'done' }) },
      { profileName: 'coder', signal: new AbortController().signal },
    );

    await expect(mirrored).resolves.toEqual({ summary: 'done' });
    expect(requester.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subagent.completed', subagentId: 'child-1' }),
    );
  });
});
