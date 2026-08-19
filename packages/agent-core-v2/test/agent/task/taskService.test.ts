import { Readable, type Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
  type ContextInjectionProvider,
} from '#/agent/contextInjector/contextInjector';
import {
  IAgentTaskService,
  type AgentTask,
  type AgentTaskInfo,
} from '#/agent/task/task';
import { renderNotificationXml } from '#/agent/task/notificationXml';
import { AgentTaskService } from '#/agent/task/taskService';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IWireService } from '#/wire/wire';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { ITaskService } from '#/app/task/task';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

import { stubLog } from '../../_base/log/stubs';
import { stubContextMemory } from '../contextMemory/stubs';
import { stubLoopWithHooks } from '../loop/stubs';
import type { TaskServiceTestManager } from './stubs';

/** Records what the resolver asked the apply path to do, so a test can assert
 * that a replay applied nothing and that a resumed apply was flagged as such. */
const applyMock = vi.hoisted(() => ({
  calls: [] as { resume: boolean }[],
  onApply: undefined as undefined | (() => Promise<void>),
  fail: undefined as undefined | 'clean' | 'dirty',
}));
vi.mock('#/session/subagent/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/session/subagent/worktree')>();
  return {
    ...actual,
    applySubagentWorktreeCandidate: async (
      _services: never,
      _draft: never,
      _scope: never,
      options?: { readonly resume?: boolean },
    ) => {
      applyMock.calls.push({ resume: options?.resume === true });
      await applyMock.onApply?.();
      if (applyMock.fail === 'dirty') {
        throw new actual.SubagentCandidateApplyDirtyError('candidate_path_diverged: resumed apply');
      }
      if (applyMock.fail === 'clean') throw new Error('candidate_path_diverged: docs/readme.md');
      return { applied: true };
    },
  };
});

function fakeProcessTask(): AgentTask {
  return {
    idPrefix: 'test',
    kind: 'process',
    description: 'fake process task',
    start: () => {},
    toInfo: (base) => ({ ...base, kind: 'process', command: 'echo', pid: 0, exitCode: null }),
  };
}

type RestoreHook = IEventDispatcher['hooks']['onDidRestore'];

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

function stubWireService(): IWireService {
  return {
    _serviceBrand: undefined,
    seal: async () => {},
    appendRecord: () => {},
    readJournal: async function* () {},
    flush: async () => {},
  };
}

describe('AgentTaskService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let eventBus: EventBusService;
  let injectionProviders: Map<string, ContextInjectionProvider>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    eventBus = disposables.add(new EventBusService());
    injectionProviders = new Map();
    ix.stub(ILogService, stubLog());
    ix.stub(IAgentConversationUndoParticipantRegistry, {
      register: () => toDisposable(() => {}),
      list: () => [],
    });
    ix.stub(IWireService, stubWireService());
    ix.stub(IEventBus, eventBus);
    ix.stub(IAgentContextInjectorService, {
      register: (name, provider) => {
        injectionProviders.set(name, provider as ContextInjectionProvider);
        return toDisposable(() => {
          injectionProviders.delete(name);
        });
      },
    });
    ix.stub(ITaskService, {
      run: () => {
        throw new Error('ITaskService.run is not used by this test');
      },
      defer: () => {
        throw new Error('ITaskService.defer is not used by this test');
      },
    });
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(ITelemetryService, { track: () => {}, track2: () => {} });
    ix.stub(IAgentToolRegistryService, {
      register: () => toDisposable(() => {}),
    });
    ix.stub(IAgentLoopService, stubLoopWithHooks());
    ix.stub(IConfigRegistry, { registerSection: () => {} });
    ix.stub(IConfigService, {
      get: (() => undefined) as IConfigService['get'],
    });
    ix.stub(
      ISessionContext,
      makeSessionContext({
        sessionId: 'test-session',
        workspaceId: 'test-ws',
        sessionDir: '/tmp/test-session',
        sessionScope: 'sessions/test-ws/test-session',
        cwd: '/tmp/test-session',
      }),
    );
    ix.stub(
      IAgentScopeContext,
      makeAgentScopeContext({
        agentId: 'main',
        agentScope: 'sessions/test-ws/test-session/agents/main',
      }),
    );
    ix.stub(IAtomicDocumentStore, {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    });
    ix.stub(IFileSystemStorageService, {
      read: async () => undefined,
      readStream: async function* () {},
      write: async () => {},
      writeStream: async () => {},
      append: async () => {},
      list: async () => [],
      delete: async () => {},
      flush: async () => {},
      close: async () => {},
    });
    ix.stub(IAgentBlobService, noopBlob);
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    ix.set(IAgentTaskService, new SyncDescriptor(AgentTaskService));
  });
  afterEach(() => disposables.dispose());

  it('registerTask / list / readOutput / stop', async () => {
    const svc = ix.get(IAgentTaskService);
    const id = svc.registerTask(fakeProcessTask());
    const listed = svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.taskId).toBe(id);
    expect(listed[0]?.kind).toBe('process');
    expect(await svc.readOutput(id)).toBe('');
    await svc.stop(id);
  });

  it('wait with a timeout beyond the timer ceiling does not resolve immediately', async () => {
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(fakeProcessTask());
    const waited = svc.wait(taskId, 10 * 365 * 24 * 3600 * 1000);
    const early = await Promise.race([
      waited.then(() => 'returned' as const),
      new Promise<'waiting'>((resolve) => setTimeout(() => {
        resolve('waiting');
      }, 50)),
    ]);
    expect(early).toBe('waiting');
    await svc.stop(taskId);
    await expect(waited).resolves.toMatchObject({ taskId });
  });

  function capturingWire(): { records: Record<string, unknown>[] } {
    const records: Record<string, unknown>[] = [];
    ix.stub(IWireService, {
      ...stubWireService(),
      appendRecord: (record: Record<string, unknown>) => {
        records.push(record);
      },
    } as IWireService);
    return { records };
  }

  function outputtingTask(output: string): AgentTask {
    return {
      ...fakeProcessTask(),
      start: async (sink) => {
        sink.appendOutput(output);
        await sink.settle({ status: 'completed' });
      },
    };
  }

  /** The default stubs above answer every read with `undefined`; candidate
   * resolution needs a store that actually round-trips what it wrote. */
  function candidateStore(): void {
    const docs = new Map<string, unknown>();
    ix.stub(IAtomicDocumentStore, {
      get: async (scope: string, name: string) => docs.get(`${scope}/${name}`),
      set: async (scope: string, name: string, value: unknown) => {
        docs.set(`${scope}/${name}`, value);
      },
      delete: async (scope: string, name: string) => {
        docs.delete(`${scope}/${name}`);
      },
      list: async () => [...docs.keys()],
    } as unknown as IAtomicDocumentStore);
  }

  function candidateTask(): AgentTask {
    return {
      idPrefix: 'agent',
      kind: 'agent',
      description: 'scope expansion candidate',
      start: async (sink: { settle: (s: unknown) => Promise<void> }) => {
        await sink.settle({
          status: 'input_required',
          editingCandidate: {
            draft: {
              version: 1,
              candidateHash: 'hash-1',
              repoRoot: '/repo',
              commonDir: '/repo/.git',
              headCommit: 'c0ffee',
              scope: ['src/**'],
              requestedScope: ['src/**', 'docs/readme.md'],
              paths: [
                {
                  relPath: 'docs/readme.md',
                  classification: 'outside-scope',
                  before: { state: { kind: 'absent' } },
                  after: { state: { kind: 'absent' } },
                },
              ],
            },
          },
        });
      },
      toInfo: (base: object) => ({ ...base, kind: 'agent' }),
    } as unknown as AgentTask;
  }

  it('replays the recorded resolution when the same deny is resent', async () => {
    // The first deny moves the task to a terminal status, so gating on
    // `input_required` would make every resend throw `candidate_already_resolved`
    // and leave the advertised idempotent path unreachable.
    candidateStore();
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(candidateTask());
    await svc.wait(taskId, 1000);
    expect(svc.getTask(taskId)?.status).toBe('input_required');

    const request = {
      taskId,
      candidateHash: 'hash-1',
      requestedScope: ['src/**', 'docs/readme.md'],
      action: 'deny',
    } as const;
    const first = await svc.resolveScopeExpansion(request);
    const second = await svc.resolveScopeExpansion(request);

    expect(first).toMatchObject({ resolution: 'denied', idempotent: false });
    expect(second).toMatchObject({ resolution: 'denied', idempotent: true });
  });

  it('rejects the opposite action after a candidate was resolved', async () => {
    candidateStore();
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(candidateTask());
    await svc.wait(taskId, 1000);

    const requestedScope = ['src/**', 'docs/readme.md'];
    await svc.resolveScopeExpansion({ taskId, candidateHash: 'hash-1', requestedScope, action: 'deny' });

    await expect(
      svc.resolveScopeExpansion({ taskId, candidateHash: 'hash-1', requestedScope, action: 'approve' }),
    ).rejects.toThrow(/candidate_already_resolved/);
  });

  it('task.terminated dispatch carries the retained output tail as outputTail', async () => {
    const { records } = capturingWire();
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(outputtingTask('line one\nline two\n'));

    await svc.wait(taskId, 1000);

    const terminated = records.filter((record) => record['type'] === 'task.terminated');
    expect(terminated).toHaveLength(1);
    expect(terminated[0]).toMatchObject({
      info: { taskId, status: 'completed' },
      outputTail: 'line one\nline two\n',
    });
  });

  it('task.terminated outputTail is bounded to the last 4 KiB of retained output', async () => {
    const { records } = capturingWire();
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(outputtingTask('x'.repeat(8 * 1024)));

    await svc.wait(taskId, 1000);

    const terminated = records.find((record) => record['type'] === 'task.terminated');
    expect(terminated?.['outputTail']).toBe('x'.repeat(4 * 1024));
  });

  it('task.terminated dispatch omits outputTail when the task produced no output', async () => {
    const { records } = capturingWire();
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask({
      ...fakeProcessTask(),
      start: async (sink) => {
        await sink.settle({ status: 'completed' });
      },
    });

    await svc.wait(taskId, 1000);

    const terminated = records.find((record) => record['type'] === 'task.terminated');
    expect(terminated?.['outputTail']).toBeUndefined();
  });

  function stubTaskConfig(value: unknown): void {
    ix.stub(IConfigService, {
      get: ((domain: string) => (domain === 'task' ? value : undefined)) as IConfigService['get'],
    });
  }

  function stubTaskWrites(): AgentTaskInfo[] {
    const writes: AgentTaskInfo[] = [];
    ix.stub(IAtomicDocumentStore, {
      get: async () => undefined,
      set: async <T,>(_scope: string, _key: string, value: T) => {
        writes.push(value as AgentTaskInfo);
      },
      delete: async () => {},
      list: async () => [],
    });
    return writes;
  }

  function abortObservingTask(onAbort: (reason: unknown) => void): AgentTask {
    return {
      ...fakeProcessTask(),
      start: ({ signal }) => {
        if (signal.aborted) {
          onAbort(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => onAbort(signal.reason));
      },
    };
  }

  it('stopAllOnExit suppresses and persists terminal state for detached tasks', async () => {
    const writes = stubTaskWrites();
    const svc = ix.get(IAgentTaskService);
    const first = svc.registerTask(fakeProcessTask());
    const second = svc.registerTask(fakeProcessTask());

    const stopped = await svc.stopAllOnExit('Session closed');

    expect(stopped.map((info) => info.taskId).toSorted()).toEqual([first, second].toSorted());
    for (const taskId of [first, second]) {
      const info = svc.getTask(taskId);
      expect(info?.status).toBe('killed');
      expect(info?.stopReason).toBe('Session closed');
      expect(info?.terminalNotificationSuppressed).toBe(true);
      const persisted = writes.filter((write) => write.taskId === taskId);
      expect(
        persisted.some(
          (write) =>
            write.status === 'running' && write.terminalNotificationSuppressed === true,
        ),
      ).toBe(true);
      expect(persisted.at(-1)).toMatchObject({
        status: 'killed',
        terminalNotificationSuppressed: true,
      });
    }
  });

  it('stopAllOnExit does not persist a foreground-only task', async () => {
    const writes = stubTaskWrites();
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(fakeProcessTask(), { detached: false });

    await svc.stopAllOnExit('Session closed');

    expect(writes).toEqual([]);
    expect(svc.getTask(taskId)).toMatchObject({
      status: 'killed',
      detached: false,
      terminalNotificationSuppressed: undefined,
    });
  });

  it('stopAllOnExit leaves tasks running when keepAliveOnExit is set', async () => {
    stubTaskConfig({ keepAliveOnExit: true });
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(fakeProcessTask());

    const stopped = await svc.stopAllOnExit('Session closed');

    expect(stopped).toEqual([]);
    expect(svc.getTask(taskId)?.status).toBe('running');

    await svc.stop(taskId);
  });

  it('dispose aborts live tasks as a last resort', async () => {
    const svc = ix.get(IAgentTaskService);
    let abortReason: unknown;
    svc.registerTask(abortObservingTask((reason) => (abortReason = reason)), {
      timeoutMs: 60_000,
    });

    disposables.dispose();
    await Promise.resolve();

    expect(abortReason).toBe('Session closed');
  });

  it('scope disposal requests SIGKILL when a process ignores SIGTERM', async () => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    let resolveWait!: (code: number) => void;
    const wait = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    const kill = vi.fn(async (signal: NodeJS.Signals) => {
      if (signal !== 'SIGKILL') return;
      stdout.push(null);
      stderr.push(null);
      resolveWait(137);
    });
    const proc = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr,
      pid: 4244,
      exitCode: null,
      wait: () => wait,
      kill,
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as IHostProcess;
    const svc = ix.get(IAgentTaskService);
    svc.registerTask(new ProcessTask(proc, 'ignore-term', 'long-running process'));
    await Promise.resolve();

    disposables.dispose();
    await Promise.resolve();

    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('dispose leaves tasks running when keepAliveOnExit is set', async () => {
    stubTaskConfig({ keepAliveOnExit: true });
    const svc = ix.get(IAgentTaskService);
    let aborted = false;
    const forceStop = vi.fn(async () => {});
    svc.registerTask({
      ...abortObservingTask(() => (aborted = true)),
      forceStop,
    });
    await Promise.resolve();

    disposables.dispose();

    expect(aborted).toBe(false);
    expect(forceStop).not.toHaveBeenCalled();
  });

  it('scope disposal leaves a process running when keepAliveOnExit is set', async () => {
    stubTaskConfig({ keepAliveOnExit: true });
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    let resolveWait!: (code: number) => void;
    const wait = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    const proc = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr,
      pid: 4245,
      exitCode: null,
      wait: () => wait,
      kill: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as IHostProcess;
    const svc = ix.get(IAgentTaskService);
    svc.registerTask(new ProcessTask(proc, 'keep-running', 'long-running process'));
    await Promise.resolve();

    disposables.dispose();
    await Promise.resolve();

    expect(proc.kill).not.toHaveBeenCalled();
    expect(proc.dispose).not.toHaveBeenCalled();

    stdout.push(null);
    stderr.push(null);
    resolveWait(0);
    await Promise.resolve();
  });

  it('stop requests force-stop when killGracePeriodMs is zero', async () => {
    stubTaskConfig({ killGracePeriodMs: 0 });
    const svc = ix.get(IAgentTaskService);
    let forceStopped = false;
    const taskId = svc.registerTask({
      ...fakeProcessTask(),
      start: () => new Promise<void>(() => {}),
      forceStop: async () => {
        forceStopped = true;
      },
    });

    const info = await svc.stop(taskId);

    expect(forceStopped).toBe(true);
    expect(info?.status).toBe('killed');
  });

  function mapBackedDocs(): IAtomicDocumentStore {
    const map = new Map<string, unknown>();
    return {
      _serviceBrand: undefined,
      get: async <T,>(scope: string, key: string): Promise<T | undefined> =>
        map.get(`${scope}/${key}`) as T | undefined,
      set: async <T,>(scope: string, key: string, value: T): Promise<void> => {
        map.set(`${scope}/${key}`, value);
      },
      delete: async (scope: string, key: string): Promise<void> => {
        map.delete(`${scope}/${key}`);
      },
      list: async (scope: string, prefix = ''): Promise<readonly string[]> =>
        [...map.keys()]
          .filter((key) => key.startsWith(`${scope}/${prefix}`))
          .map((key) => key.slice(scope.length + 1)),
    } as unknown as IAtomicDocumentStore;
  }

  function buildAgentIx(
    agentId: string,
    docs: IAtomicDocumentStore,
    bytes: IFileSystemStorageService,
  ): TestInstantiationService {
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IAgentConversationUndoParticipantRegistry, {
      register: () => toDisposable(() => {}),
      list: () => [],
    });
    ix.stub(IWireService, stubWireService());
    ix.stub(IEventBus, disposables.add(new EventBusService()));
    ix.stub(IAgentContextInjectorService, {
      register: () => toDisposable(() => {}),
    });
    ix.stub(ITaskService, {
      run: () => {
        throw new Error('ITaskService.run is not used by this test');
      },
      defer: () => {
        throw new Error('ITaskService.defer is not used by this test');
      },
    });
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(ITelemetryService, { track: () => {}, track2: () => {} });
    ix.stub(IAgentLoopService, stubLoopWithHooks());
    ix.stub(IConfigService, {
      get: (() => undefined) as IConfigService['get'],
    });
    ix.stub(
      ISessionContext,
      makeSessionContext({
        sessionId: 'test-session',
        workspaceId: 'test-ws',
        sessionDir: '/tmp/test-session',
        sessionScope: 'sessions/test-ws/test-session',
        cwd: '/tmp/test-session',
      }),
    );
    ix.stub(
      IAgentScopeContext,
      makeAgentScopeContext({
        agentId,
        agentScope: `sessions/test-ws/test-session/agents/${agentId}`,
      }),
    );
    ix.stub(IAtomicDocumentStore, docs);
    ix.stub(IFileSystemStorageService, bytes);
    ix.stub(IAgentBlobService, noopBlob);
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    ix.set(IAgentTaskService, new SyncDescriptor(AgentTaskService));
    return ix;
  }

  it('restore touches only the agent own task records', async () => {
    const docs = mapBackedDocs();
    const bytes = new InMemoryStorageService();
    const subScope = 'sessions/test-ws/test-session/agents/agent-1';
    await docs.set(`${subScope}/tasks`, 'bash-abcdef01.json', {
      taskId: 'bash-abcdef01',
      kind: 'process',
      command: 'sleep 60',
      description: 'sub task',
      pid: 4242,
      startedAt: 1,
      endedAt: null,
      exitCode: null,
      status: 'running',
      detached: true,
    });

    const main = buildAgentIx('main', docs, bytes).get(
      IAgentTaskService,
    ) as TaskServiceTestManager;
    await main.loadFromDisk();
    const lost = await main.reconcile();

    expect(lost).toEqual([]);
    expect(main.list(false)).toEqual([]);
    const untouched = await docs.get<{ status: string }>(
      `${subScope}/tasks`,
      'bash-abcdef01.json',
    );
    expect(untouched?.status).toBe('running');

    const sub = buildAgentIx('agent-1', docs, bytes).get(
      IAgentTaskService,
    ) as TaskServiceTestManager;
    await sub.loadFromDisk();
    const subLost = await sub.reconcile();
    expect(subLost.map((info) => info.taskId)).toEqual(['bash-abcdef01']);
    expect(subLost[0]?.status).toBe('lost');
  });

  const RESTORED_SCOPE = 'sessions/test-ws/test-session/agents/agent-1/tasks';
  const RESTORED_TASK_ID = 'agent-abcdef02';
  const RESTORED_SCOPE_REQUEST = ['src/**', 'docs/readme.md'];

  /** Seeds what a process that died holding an unresolved candidate leaves
   * behind: an `input_required` task record plus its candidate manifest. */
  async function seedCandidateGhost(
    docs: IAtomicDocumentStore,
    resolution?: { kind: 'approved_applied' | 'denied'; resolvedAt: string; phase?: 'pending' },
  ): Promise<void> {
    await docs.set(RESTORED_SCOPE, `${RESTORED_TASK_ID}.json`, {
      taskId: RESTORED_TASK_ID,
      kind: 'agent',
      description: 'scope expansion candidate',
      startedAt: 1,
      endedAt: null,
      status: 'input_required',
      detached: true,
      candidate: {
        hash: 'hash-1',
        requestedScope: RESTORED_SCOPE_REQUEST,
        paths: ['docs/readme.md'],
      },
    });
    await docs.set(RESTORED_SCOPE, `${RESTORED_TASK_ID}.candidate.json`, {
      version: 1,
      taskId: RESTORED_TASK_ID,
      repoRoot: '/repo',
      commonDir: '/repo/.git',
      headCommit: 'c0ffee',
      originalScope: ['src/**'],
      requestedScope: RESTORED_SCOPE_REQUEST,
      candidateHash: 'hash-1',
      createdAt: new Date(0).toISOString(),
      paths: [
        {
          relPath: 'docs/readme.md',
          classification: 'outside-scope',
          before: { kind: 'absent' },
          after: { kind: 'absent' },
          beforePayload: false,
          afterPayload: false,
        },
      ],
      resolution,
    });
  }

  async function restoredAgent(
    docs: IAtomicDocumentStore,
    bytes: IFileSystemStorageService,
  ): Promise<{ svc: TaskServiceTestManager; lost: readonly AgentTaskInfo[] }> {
    const svc = buildAgentIx('agent-1', docs, bytes).get(
      IAgentTaskService,
    ) as TaskServiceTestManager;
    await svc.loadFromDisk();
    const lost = await svc.reconcile();
    return { svc, lost };
  }

  it('keeps a restored task with an unresolved candidate resolvable instead of lost', async () => {
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs);

    const { svc, lost } = await restoredAgent(docs, new InMemoryStorageService());

    expect(lost).toEqual([]);
    expect(svc.getTask(RESTORED_TASK_ID)?.status).toBe('input_required');
  });

  it('settles rather than keeps a restored task whose candidate is already resolved', async () => {
    // Guards the skip above from widening into "any input_required task
    // survives": a resolved candidate has nothing left to decide, so it leaves
    // reconciliation terminal — at the status its manifest recorded.
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs, { kind: 'denied', resolvedAt: new Date(0).toISOString() });

    const { svc, lost } = await restoredAgent(docs, new InMemoryStorageService());

    expect(lost.map((info) => info.taskId)).toEqual([RESTORED_TASK_ID]);
    expect(svc.getTask(RESTORED_TASK_ID)?.status).toBe('expansion_denied');
  });

  it('marks a restored task lost when its candidate manifest is missing', async () => {
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs);
    await docs.delete(RESTORED_SCOPE, `${RESTORED_TASK_ID}.candidate.json`);

    const { lost } = await restoredAgent(docs, new InMemoryStorageService());

    expect(lost.map((info) => info.taskId)).toEqual([RESTORED_TASK_ID]);
  });

  it('approves a candidate that outlived the process that produced it', async () => {
    applyMock.calls = [];
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs);
    const { svc } = await restoredAgent(docs, new InMemoryStorageService());
    // The intent has to be durable before the workspace is touched, or a crash
    // during the apply leaves no record that the apply was ever attempted.
    let phaseDuringApply: string | undefined;
    applyMock.onApply = async () => {
      const manifest = await docs.get<{ resolution?: { phase?: string } }>(
        RESTORED_SCOPE,
        `${RESTORED_TASK_ID}.candidate.json`,
      );
      phaseDuringApply = manifest?.resolution?.phase;
    };

    const result = await svc.resolveScopeExpansion({
      taskId: RESTORED_TASK_ID,
      candidateHash: 'hash-1',
      requestedScope: RESTORED_SCOPE_REQUEST,
      action: 'approve',
    });

    applyMock.onApply = undefined;
    expect(applyMock.calls).toEqual([{ resume: false }]);
    expect(phaseDuringApply).toBe('pending');
    expect(result).toMatchObject({ resolution: 'approved_applied', idempotent: false });
    expect(svc.getTask(RESTORED_TASK_ID)?.status).toBe('completed');
    const stored = await docs.get<{ status: string }>(RESTORED_SCOPE, `${RESTORED_TASK_ID}.json`);
    expect(stored?.status).toBe('completed');
  });

  it('denies a candidate that outlived the process without touching the workspace', async () => {
    applyMock.calls = [];
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs);
    const { svc } = await restoredAgent(docs, new InMemoryStorageService());

    const result = await svc.resolveScopeExpansion({
      taskId: RESTORED_TASK_ID,
      candidateHash: 'hash-1',
      requestedScope: RESTORED_SCOPE_REQUEST,
      action: 'deny',
    });

    expect(applyMock.calls).toEqual([]);
    expect(result).toMatchObject({ resolution: 'denied' });
    expect(svc.getTask(RESTORED_TASK_ID)?.status).toBe('expansion_denied');
  });

  it('replays a resolved candidate on a restored task without applying again', async () => {
    applyMock.calls = [];
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs, {
      kind: 'approved_applied',
      resolvedAt: new Date(0).toISOString(),
    });
    const svc = buildAgentIx('agent-1', docs, new InMemoryStorageService()).get(
      IAgentTaskService,
    ) as TaskServiceTestManager;
    await svc.loadFromDisk();

    const result = await svc.resolveScopeExpansion({
      taskId: RESTORED_TASK_ID,
      candidateHash: 'hash-1',
      requestedScope: RESTORED_SCOPE_REQUEST,
      action: 'approve',
    });

    expect(applyMock.calls).toEqual([]);
    expect(result).toMatchObject({ resolution: 'approved_applied', idempotent: true });
  });

  it('resumes an apply whose resolution was never written', async () => {
    // The process died between the apply and the manifest write, so the record
    // says `pending`: the workspace, not the record, decides whether the delta
    // landed — the apply path is re-entered in resume mode to find out.
    applyMock.calls = [];
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs, {
      kind: 'approved_applied',
      resolvedAt: new Date(0).toISOString(),
      phase: 'pending',
    });
    const { svc, lost } = await restoredAgent(docs, new InMemoryStorageService());
    expect(lost).toEqual([]);

    const result = await svc.resolveScopeExpansion({
      taskId: RESTORED_TASK_ID,
      candidateHash: 'hash-1',
      requestedScope: RESTORED_SCOPE_REQUEST,
      action: 'approve',
    });

    expect(applyMock.calls).toEqual([{ resume: true }]);
    expect(result).toMatchObject({ resolution: 'approved_applied', idempotent: false });
    const manifest = await docs.get<{ resolution?: { phase?: string } }>(
      RESTORED_SCOPE,
      `${RESTORED_TASK_ID}.candidate.json`,
    );
    expect(manifest?.resolution?.phase).toBeUndefined();
  });

  it('leaves deny available after an approve whose apply failed cleanly', async () => {
    // The pending intent is written before the workspace is touched. If a failed
    // approve left it behind, the kind check would refuse every later deny and
    // the pending phase would keep the task out of the lost sweep — a task the
    // user can neither apply nor dismiss.
    applyMock.calls = [];
    applyMock.fail = 'clean';
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs);
    const { svc } = await restoredAgent(docs, new InMemoryStorageService());
    const request = {
      taskId: RESTORED_TASK_ID,
      candidateHash: 'hash-1',
      requestedScope: RESTORED_SCOPE_REQUEST,
    } as const;

    await expect(svc.resolveScopeExpansion({ ...request, action: 'approve' })).rejects.toThrow(
      /candidate_path_diverged/,
    );
    applyMock.fail = undefined;

    const manifest = await docs.get<{ resolution?: unknown }>(
      RESTORED_SCOPE,
      `${RESTORED_TASK_ID}.candidate.json`,
    );
    expect(manifest?.resolution).toBeUndefined();
    const denied = await svc.resolveScopeExpansion({ ...request, action: 'deny' });
    expect(denied).toMatchObject({ resolution: 'denied' });
    expect(svc.getTask(RESTORED_TASK_ID)?.status).toBe('expansion_denied');
  });

  it('keeps the pending intent when a failed apply left the workspace dirty', async () => {
    // The mirror of the case above: a half-applied workspace must not let the
    // user flip to deny, and the pending record is what a later resume reads.
    applyMock.calls = [];
    applyMock.fail = 'dirty';
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs);
    const { svc } = await restoredAgent(docs, new InMemoryStorageService());
    const request = {
      taskId: RESTORED_TASK_ID,
      candidateHash: 'hash-1',
      requestedScope: RESTORED_SCOPE_REQUEST,
    } as const;

    await expect(svc.resolveScopeExpansion({ ...request, action: 'approve' })).rejects.toThrow(
      /candidate_path_diverged/,
    );
    applyMock.fail = undefined;

    const manifest = await docs.get<{ resolution?: { phase?: string } }>(
      RESTORED_SCOPE,
      `${RESTORED_TASK_ID}.candidate.json`,
    );
    expect(manifest?.resolution?.phase).toBe('pending');
    await expect(svc.resolveScopeExpansion({ ...request, action: 'deny' })).rejects.toThrow(
      /candidate_already_resolved/,
    );
  });

  it('denies a candidate whose path payloads are gone', async () => {
    // Dismissing a candidate needs the manifest, not the payload bytes; reading
    // the draft up front would make a partially lost candidate undismissable.
    applyMock.calls = [];
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs);
    const bytes = new InMemoryStorageService();
    const { svc } = await restoredAgent(docs, bytes);

    const result = await svc.resolveScopeExpansion({
      taskId: RESTORED_TASK_ID,
      candidateHash: 'hash-1',
      requestedScope: RESTORED_SCOPE_REQUEST,
      action: 'deny',
    });

    expect(result).toMatchObject({ resolution: 'denied' });
    expect(applyMock.calls).toEqual([]);
  });

  it('lists a restored candidate among the active tasks', async () => {
    // Before this batch every ghost was terminal by the time anyone listed, so
    // `activeOnly` skipped them all. A candidate the agent cannot see in
    // TaskList is a candidate nobody will ever resolve.
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs);
    const { svc } = await restoredAgent(docs, new InMemoryStorageService());

    expect(svc.list(true).map((info) => info.taskId)).toEqual([RESTORED_TASK_ID]);
  });

  it('settles a restored task at its recorded resolution rather than lost', async () => {
    // The resolution finished but the process died before the task record
    // caught up: the workspace carries the applied delta, so `lost` would be a
    // lie about what happened.
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs, {
      kind: 'approved_applied',
      resolvedAt: new Date(0).toISOString(),
    });

    const { svc, lost } = await restoredAgent(docs, new InMemoryStorageService());

    expect(lost.map((info) => info.status)).toEqual(['completed']);
    expect(svc.getTask(RESTORED_TASK_ID)?.status).toBe('completed');
  });

  it('keeps a restored task waiting when the manifest cannot be read', async () => {
    // `lost` is one-way. A transient storage failure must not spend it.
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs);
    const failing = {
      ...docs,
      get: async <T,>(scope: string, key: string): Promise<T | undefined> => {
        if (key.endsWith('.candidate.json')) throw new Error('STORAGE_DECODE_FAILED');
        return await docs.get<T>(scope, key);
      },
    } as unknown as IAtomicDocumentStore;

    const { svc, lost } = await restoredAgent(failing, new InMemoryStorageService());

    expect(lost).toEqual([]);
    expect(svc.getTask(RESTORED_TASK_ID)?.status).toBe('input_required');
  });

  it('rejects a restored candidate whose requested scope does not match', async () => {
    applyMock.calls = [];
    const docs = mapBackedDocs();
    await seedCandidateGhost(docs);
    const { svc } = await restoredAgent(docs, new InMemoryStorageService());

    await expect(
      svc.resolveScopeExpansion({
        taskId: RESTORED_TASK_ID,
        candidateHash: 'hash-1',
        requestedScope: ['src/**'],
        action: 'approve',
      }),
    ).rejects.toThrow(/candidate_identity_mismatch/);
    expect(applyMock.calls).toEqual([]);
  });

  it('main restore claims a previous v2 session task with its legacy output path', async () => {
    const docs = mapBackedDocs();
    const bytes = new InMemoryStorageService();
    const sessionScope = 'sessions/test-ws/test-session';
    const taskId = 'bash-legacy01';
    await docs.set(`${sessionScope}/tasks`, `${taskId}.json`, {
      taskId,
      kind: 'process',
      command: 'echo legacy',
      description: 'legacy task',
      pid: 4242,
      startedAt: 1,
      endedAt: 2,
      exitCode: 0,
      status: 'completed',
      detached: true,
    });
    await bytes.write(
      `${sessionScope}/tasks/${taskId}`,
      'output.log',
      new TextEncoder().encode('legacy output'),
    );
    let restoreHook!: RestoreHook;
    const mainIx = buildAgentIx('main', docs, bytes);
    const main = mainIx.get(IAgentTaskService);
    restoreHook = mainIx.get(IEventDispatcher).hooks.onDidRestore;

    await restoreHook.run({});

    expect(main.list(false)).toEqual([
      expect.objectContaining({ taskId, description: 'legacy task', status: 'completed' }),
    ]);
    expect(await main.getOutputSnapshot(taskId, 100)).toEqual({
      outputPath: `/tmp/test-session/tasks/${taskId}/output.log`,
      outputSizeBytes: 13,
      previewBytes: 13,
      truncated: false,
      fullOutputAvailable: true,
      preview: 'legacy output',
    });
  });

  it('subagent restore does not claim previous v2 session tasks', async () => {
    const docs = mapBackedDocs();
    const bytes = new InMemoryStorageService();
    const sessionScope = 'sessions/test-ws/test-session';
    const taskId = 'bash-legacy02';
    await docs.set(`${sessionScope}/tasks`, `${taskId}.json`, {
      taskId,
      kind: 'process',
      command: 'echo legacy',
      description: 'legacy task',
      pid: 4242,
      startedAt: 1,
      endedAt: 2,
      exitCode: 0,
      status: 'completed',
      detached: true,
    });
    let restoreHook!: RestoreHook;
    const subIx = buildAgentIx('agent-1', docs, bytes);
    const subagent = subIx.get(IAgentTaskService);
    restoreHook = subIx.get(IEventDispatcher).hooks.onDidRestore;

    await restoreHook.run({});

    expect(subagent.list(false)).toEqual([]);
  });

  function compactionSummary(text: string): ContextMessage {
    return {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'compaction_summary' },
    };
  }

  function publishCompactionSplice(): void {
    eventBus.publish(new ContextSpliced({
      start: 0,
      deleteCount: 2,
      messages: [compactionSummary('Compacted summary.')],
    }));
  }

  async function backgroundTaskReminder(
    context: ContextInjectionContext = {
      injectedPositions: [],
      lastInjectedAt: null,
      isNewTurn: false,
    },
  ): Promise<string | undefined> {
    const provider = injectionProviders.get('background_task_status');
    expect(provider).toBeDefined();
    const content = await provider!(context);
    return typeof content === 'string' ? content : undefined;
  }

  it('injects active background task status when compaction dropped the original launch context', async () => {
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(fakeProcessTask());

    expect(await backgroundTaskReminder()).toBeUndefined();

    publishCompactionSplice();

    const reminder = await backgroundTaskReminder();
    expect(reminder).toContain('The conversation was compacted');
    expect(reminder).toContain(
      'gone — but the tasks are still running from before. Do not start duplicates. Use TaskList to list them, TaskOutput for a non-blocking status/output snapshot',
    );
    expect(reminder).toContain('active_background_tasks: 1');
    expect(reminder).toContain(taskId);
    expect(reminder).toContain('TaskOutput');
    expect(reminder).toContain('TaskList');
    expect(reminder).toContain('TaskStop');
    expect(await backgroundTaskReminder()).toBeUndefined();

    await svc.stop(taskId);
  });

  it('does not carry post-compaction task reminder eligibility forward when no task is active', async () => {
    const svc = ix.get(IAgentTaskService);
    publishCompactionSplice();

    expect(await backgroundTaskReminder()).toBeUndefined();

    const taskId = svc.registerTask(fakeProcessTask());
    expect(await backgroundTaskReminder()).toBeUndefined();

    await svc.stop(taskId);
  });

  const MiB = 1024 * 1024;
  const LIMIT_BYTES = 16 * MiB;

  function streamingProcess(chunks: string[]): {
    proc: IHostProcess;
    kill: ReturnType<typeof vi.fn>;
  } {
    const stdout = Readable.from(chunks);
    const stderr = Readable.from([]);
    let resolveWait!: (code: number) => void;
    const waitP = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    stdout.on('end', () => {
      resolveWait(0);
    });
    const kill = vi.fn(async (signal: string) => {
      stdout.destroy();
      resolveWait(signal === 'SIGKILL' ? 137 : 143);
    });
    const proc = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr,
      pid: 4242,
      exitCode: null,
      wait: () => waitP,
      kill,
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as IHostProcess;
    return { proc, kill };
  }

  function sigtermIgnoringProcess(chunks: string[]): {
    proc: IHostProcess;
    kill: ReturnType<typeof vi.fn>;
  } {
    const stdout = Readable.from(chunks);
    const stderr = Readable.from([]);
    let resolveWait!: (code: number) => void;
    const waitP = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    stdout.on('end', () => {
      resolveWait(0);
    });
    const kill = vi.fn(async (signal: string) => {
      if (signal === 'SIGKILL') {
        stdout.destroy();
        resolveWait(137);
      }
    });
    const proc = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr,
      pid: 4243,
      exitCode: null,
      wait: () => waitP,
      kill,
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as IHostProcess;
    return { proc, kill };
  }

  function agentLikeTask(result: string, description: string): AgentTask {
    return {
      idPrefix: 'agent',
      kind: 'agent',
      description,
      start: async (sink) => {
        sink.appendOutput(result);
        await sink.settle({ status: 'completed' });
      },
      toInfo: (base) => ({ ...base, kind: 'agent' }),
    };
  }

  async function waitForTerminal(
    svc: IAgentTaskService,
    taskId: string,
    timeoutMs = 30_000,
  ): Promise<AgentTaskInfo | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const info = await svc.wait(taskId, 5);
      if (
        info?.status === 'completed' ||
        info?.status === 'failed' ||
        info?.status === 'timed_out' ||
        info?.status === 'killed' ||
        info?.status === 'lost'
      ) {
        return info;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return svc.getTask(taskId);
  }

  function serviceWithAppendCounter(): {
    svc: IAgentTaskService;
    persistedChars: () => number;
  } {
    let persistedChars = 0;
    ix.stub(IFileSystemStorageService, {
      read: async () => undefined,
      readStream: async function* () {},
      write: async () => {},
      writeStream: async () => {},
      append: async (_scope: string, _key: string, chunk: Uint8Array) => {
        persistedChars += chunk.byteLength;
      },
      list: async () => [],
      delete: async () => {},
      flush: async () => {},
      close: async () => {},
    });
    return { svc: ix.get(IAgentTaskService), persistedChars: () => persistedChars };
  }

  it('terminates a foreground command that exceeds the output limit and stops forwarding', async () => {
    const svc = ix.get(IAgentTaskService);
    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
    const { proc, kill } = streamingProcess(chunks);

    let forwardedChars = 0;
    const onOutput = vi.fn((_kind: 'stdout' | 'stderr', text: string) => {
      forwardedChars += text.length;
    });

    const taskId = svc.registerTask(
      new ProcessTask(proc, 'b3sum --length 18446744073709551615', 'hash', onOutput),
      { detached: false, signal: new AbortController().signal, timeoutMs: 60_000 },
    );

    const info = await waitForTerminal(svc, taskId);

    expect(info?.status).toBe('killed');
    expect(info?.stopReason ?? '').toMatch(/output limit/i);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(forwardedChars).toBeLessThanOrEqual(LIMIT_BYTES);
  });

  it('also terminates a detached (background) task for the same output', async () => {
    const svc = ix.get(IAgentTaskService);
    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
    const { proc, kill } = streamingProcess(chunks);

    const taskId = svc.registerTask(new ProcessTask(proc, 'producer', 'bg'), {
      detached: true,
      timeoutMs: 60_000,
    });

    const info = await waitForTerminal(svc, taskId);

    expect(info?.status).toBe('killed');
    expect(info?.stopReason ?? '').toMatch(/output limit/i);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stops enqueuing output to disk once the foreground cap trips', async () => {
    const { svc, persistedChars } = serviceWithAppendCounter();

    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
    const { proc } = sigtermIgnoringProcess(chunks);

    const taskId = svc.registerTask(new ProcessTask(proc, 'runaway', 'hash', () => {}), {
      detached: false,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
    });

    const info = await waitForTerminal(svc, taskId);

    expect(info?.status).toBe('killed');
    expect(persistedChars()).toBeLessThanOrEqual(17 * MiB);
  });

  it('stops appending persisted output once the output limit trips for a detached process task', async () => {
    const { svc, persistedChars } = serviceWithAppendCounter();

    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
    const { proc } = sigtermIgnoringProcess(chunks);

    const taskId = svc.registerTask(new ProcessTask(proc, 'runaway', 'bg', () => {}), {
      detached: true,
      timeoutMs: 60_000,
    });

    const info = await waitForTerminal(svc, taskId);
    await svc.getOutputSnapshot(taskId, 1);

    expect(info?.status).toBe('killed');
    expect(persistedChars()).toBeLessThanOrEqual(17 * MiB);
  });

  it('does not cap or drop a detached subagent result larger than the limit', async () => {
    const { svc, persistedChars } = serviceWithAppendCounter();

    const bigResult = 'y'.repeat(20 * MiB);
    const taskId = svc.registerTask(agentLikeTask(bigResult, 'big subagent result'), {
      detached: true,
      timeoutMs: 60_000,
    });

    const info = await waitForTerminal(svc, taskId);

    expect(info?.status).toBe('completed');
    expect(persistedChars()).toBeGreaterThanOrEqual(bigResult.length);
  });
});

describe('Agent task notification XML', () => {
  it('renders task notifications with escaped attributes and generic children', () => {
    const text = renderNotificationXml({
      id: 'n_"1&2',
      category: 'task',
      type: 'task.done',
      source_kind: 'background_task',
      source_id: 'bg&1',
      title: 'Task finished',
      severity: 'info',
      body: 'The task completed.',
      children: [
        [
          '<output-file path="/tmp/logs/a&amp;b/output.log" bytes="1234">',
          'Read the output file to retrieve the result: /tmp/logs/a&amp;b/output.log',
          '</output-file>',
        ].join('\n'),
      ],
    });

    expect(text).toContain('id="n_&quot;1&amp;2"');
    expect(text).toContain('source_id="bg&amp;1"');
    expect(text).toContain('Title: Task finished');
    expect(text).toContain('Severity: info');
    expect(text).toContain('<output-file path="/tmp/logs/a&amp;b/output.log" bytes="1234">');
    expect(text).toContain(
      'Read the output file to retrieve the result: /tmp/logs/a&amp;b/output.log',
    );
    expect(text).not.toContain('<task-notification>');
    expect(text.trimEnd()).toMatch(/<\/notification>$/);
  });

  it('renders an agent_id attribute when the notification carries one', () => {
    const text = renderNotificationXml({
      id: 'n_lost1',
      category: 'task',
      type: 'task.lost',
      source_kind: 'background_task',
      source_id: 'agent-w7gq3wwj',
      agent_id: 'agent-0',
      title: 'Background agent lost',
      severity: 'warning',
      body: 'Background agent 1 lost.',
    });

    expect(text).toContain('source_id="agent-w7gq3wwj"');
    expect(text).toContain('agent_id="agent-0"');
  });

  it('omits the agent_id attribute when the notification does not carry one', () => {
    const text = renderNotificationXml({
      id: 'n_bash',
      category: 'task',
      type: 'task.completed',
      source_kind: 'background_task',
      source_id: 'bash-abcdef00',
      title: 'Background task completed',
      severity: 'info',
      body: 'echo done completed.',
    });

    expect(text).not.toContain('agent_id=');
  });

  it('ignores unrelated fields while applying attribute fallbacks', () => {
    const text = renderNotificationXml({
      id: '',
      source_kind: 'host',
      tail_output: 'should stay out of the XML',
    });

    expect(text).toContain('id="unknown"');
    expect(text).toContain('category="unknown"');
    expect(text).not.toContain('<task-notification>');
    expect(text).not.toContain('should stay out of the XML');
  });
});
