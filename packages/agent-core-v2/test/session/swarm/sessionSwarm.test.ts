import { createControlledPromise } from '@antfu/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/_base/di/scope';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IEventBus, type DomainEvent } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { APIProviderRateLimitError } from '#/kosong/contract/errors';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import {
  IAgentLifecycleService,
  type CreateAgentOptions,
} from '#/session/agentLifecycle/agentLifecycle';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { createHooks } from '#/hooks';
import {
  type AgentTaskHooks,
  ISessionSubagentService,
} from '#/session/subagent/subagent';
import { ISessionSubagentRoutingService } from '#/session/subagent/routingService';
import { SubagentRoutePool } from '#/session/subagent/routing';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionMetadata,
  type AgentMeta,
  type SessionMetadataChangedEvent,
} from '#/session/sessionMetadata/sessionMetadata';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ILogService } from '#/_base/log/log';
import {
  AgentRunBatch,
  resolveSwarmMaxConcurrency,
  type AgentRunAttemptHandle,
  type AgentRunAttemptOptions,
  type AgentRunBatchLauncher,
  type AgentRunResult,
  type AgentRunSuspendedEvent,
  type AgentSpawnAttemptOptions,
  type QueuedAgentRunTask,
} from '#/session/swarm/agentRunBatch';
import { ISessionSwarmService, type SessionSwarmSpawnTask, type SessionSwarmTask } from '#/session/swarm/sessionSwarm';
import { Error2 } from '#/_base/errors/errors';
import { ErrorCodes } from '#/errors';
import type { IConfigService } from '#/app/config/config';
import { MODELS_SECTION } from '#/app/kosongConfig/configSection';
import { SUBAGENT_SECTION } from '#/session/subagent/configSection';
import {
  ISessionSubagentCircuitService,
  SessionSubagentCircuitService,
} from '#/session/subagent/circuitService';
import { SessionSubagentRoutingService } from '#/session/subagent/routingService';
import { ConfigErrors } from '#/app/config/errors';
import { SessionSwarmService } from '#/session/swarm/sessionSwarmService';

import { stubLog } from '../../_base/log/stubs';

// Isolation acquisition needs a real git repository, which the service-level
// tests below do not have. The override lets a test stand in a fake handle and
// observe what the spawn path does with it; when it is unset every caller
// still runs the real implementation.
const worktreeMock = vi.hoisted(() => ({
  acquire: undefined as
    | undefined
    | ((cwd: string, options?: { readonly scope?: readonly string[] }) => unknown),
}));

vi.mock('#/session/subagent/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/session/subagent/worktree')>();
  return {
    ...actual,
    acquireSubagentWorktree: async (services: never, cwd: string, options: never) =>
      worktreeMock.acquire === undefined
        ? await actual.acquireSubagentWorktree(services, cwd, options)
        : worktreeMock.acquire(cwd, options),
  };
});

describe('resolveSwarmMaxConcurrency', () => {
  it('returns undefined when the variable is unset', () => {
    expect(resolveSwarmMaxConcurrency({})).toBeUndefined();
  });

  it('returns undefined for empty or whitespace-only values', () => {
    expect(
      resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '' }),
    ).toBeUndefined();
    expect(
      resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '   ' }),
    ).toBeUndefined();
  });

  it('throws for non-positive, non-integer, or non-numeric values', () => {
    for (const raw of ['0', '-1', '2.5', 'abc']) {
      expect(() =>
        resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: raw }),
      ).toThrow(/KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY.*positive integer/);
    }
  });

  it('returns the integer for a positive integer value', () => {
    expect(resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '3' })).toBe(3);
    expect(resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: ' 8 ' })).toBe(8);
  });
});

describe('AgentRunBatch scheduling contract', () => {
  it('normal phase starts five tasks immediately, then one task every 700ms', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 9 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: new AbortController().signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(699);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(7);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(8);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(9);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(9);

      attempts.forEach((attempt, index) => {
        attempt.outcome.resolve({
          task: attempt.task,
          agentId: `agent-${String(index + 1)}`,
          status: 'completed',
          result: `result ${String(index + 1)}`,
        });
      });
      const results = await running;

      expect(results).toHaveLength(9);
      expect(results.every((result) => result.status === 'completed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('user cancellation returns completed, started, and not-started task results', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 6 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });
      await vi.advanceTimersByTimeAsync(0);

      controller.abort(userCancellationReason());
      const results = await running;

      expect(
        results.map((result) => ({
          data: result.task.data,
          agentId: result.agentId,
          status: result.status,
          state: result.state,
          result: result.result,
          error: result.error,
        })),
      ).toEqual([
        {
          data: 1,
          agentId: 'agent-1',
          status: 'completed',
          state: undefined,
          result: 'completed 1',
          error: undefined,
        },
        {
          data: 2,
          agentId: 'agent-2',
          status: 'aborted',
          state: 'started',
          result: undefined,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 3,
          agentId: 'agent-3',
          status: 'aborted',
          state: 'started',
          result: undefined,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 4,
          agentId: 'agent-4',
          status: 'aborted',
          state: 'started',
          result: undefined,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 5,
          agentId: 'agent-5',
          status: 'aborted',
          state: 'started',
          result: undefined,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 6,
          agentId: undefined,
          status: 'aborted',
          state: 'not_started',
          result: undefined,
          error:
            'The user manually interrupted this subagent batch before this subagent was started.',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normal phase keeps processing completions while waiting for the next launch', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 6 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: new AbortController().signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });

      await vi.advanceTimersByTimeAsync(699);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);

      attempts.slice(1).forEach((attempt, index) => {
        attempt.outcome.resolve({
          task: attempt.task,
          agentId: `agent-${String(index + 2)}`,
          status: 'completed',
          result: `completed ${String(index + 2)}`,
        });
      });
      await expect(running).resolves.toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase starts when the first provider rate limit stops the normal ramp', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 9 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(5);

      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'completed 2',
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(1);
      expect(attempts[5]!.retryAgentId).toBe('agent-1');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase requeues 429 tasks, emits suspended, and throttles launches', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const onSuspended = vi.fn();
      const { runBatch, attempts } = createMockAgentRunBatchRunner({ onSuspended });
      const running = runBatch(
        Array.from({ length: 8 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      attempts.forEach((attempt) => {
        attempt.markReady();
      });
      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      attempts[1]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-2' });
      await vi.advanceTimersByTimeAsync(0);
      expect(onSuspended).toHaveBeenCalledTimes(2);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(500);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2500);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(2);
      expect(attempts[5]!.retryAgentId).toBe('agent-2');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the only unfinished task on provider rate limit instead of suspending forever', async () => {
    vi.useFakeTimers();
    try {
      const onSuspended = vi.fn();
      const { runBatch, attempts } = createMockAgentRunBatchRunner({ onSuspended });
      const running = runBatch(
        Array.from({ length: 2 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: new AbortController().signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(2);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });
      await vi.advanceTimersByTimeAsync(0);

      attempts[1]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-2' });
      await expect(running).resolves.toMatchObject([
        {
          task: { data: 1 },
          agentId: 'agent-1',
          status: 'completed',
          result: 'completed 1',
        },
        {
          task: { data: 2 },
          agentId: 'agent-2',
          status: 'failed',
          state: 'started',
          error: 'Rate limited',
        },
      ]);
      expect(onSuspended).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit capacity blocks launches while active attempts fill all slots', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 12 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.slice(0, 5).forEach((attempt) => {
        attempt.markReady();
      });

      for (let count = 6; count <= 12; count += 1) {
        await vi.advanceTimersByTimeAsync(700);
        expect(attempts).toHaveLength(count);
        attempts[count - 1]!.markReady();
      }

      attempts.slice(0, 12).forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({
        type: 'rate_limited',
        agentId: 'agent-1',
      });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(3000);
      expect(attempts).toHaveLength(12);

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit recovery adds one capacity slot after three quiet minutes with queued work', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 6 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2000);
      attempts[1]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-2' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2000);
      attempts[2]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-3' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2000);
      attempts[3]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-4' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(179_999);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(4);
      expect(attempts[5]!.retryAgentId).toBe('agent-4');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase keeps launches bounded after repeated 429s', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 8 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      for (let index = 0; index < 3; index += 1) {
        attempts[index]!.outcome.resolve({
          type: 'rate_limited',
          agentId: `agent-${String(index + 1)}`,
        });
        await vi.advanceTimersByTimeAsync(0);
      }

      await vi.advanceTimersByTimeAsync(3000);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(3);
      expect(attempts[5]!.retryAgentId).toBe('agent-3');

      await vi.advanceTimersByTimeAsync(3000);
      expect(attempts).toHaveLength(7);
      expect(attempts[6]!.task.data).toBe(2);
      expect(attempts[6]!.retryAgentId).toBe('agent-2');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase schedules another launch after starting while capacity remains', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 8 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'completed 2',
      });
      attempts[2]!.outcome.resolve({
        task: attempts[2]!.task,
        agentId: 'agent-3',
        status: 'completed',
        result: 'completed 3',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2_999);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(1);
      expect(attempts[5]!.retryAgentId).toBe('agent-1');

      await vi.advanceTimersByTimeAsync(2_999);
      expect(attempts).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(7);
      expect(attempts[6]!.task.data).toBe(6);
      expect(attempts[6]!.retryAgentId).toBeUndefined();

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('task timeout fails only that task', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch([{ ...queuedAgentRunTask(1), timeout: 10_000 }], {
        signal: new AbortController().signal,
      });

      await vi.advanceTimersByTimeAsync(0);
      attempts[0]!.markReady();

      await vi.advanceTimersByTimeAsync(9999);
      expect(attempts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(running).resolves.toMatchObject([
        {
          task: { data: 1 },
          agentId: 'agent-1',
          status: 'failed',
          state: 'started',
          error: 'Subagent timed out.',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not spend task timeout while the task is queued', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        [
          ...Array.from({ length: 5 }, (_, index) => queuedAgentRunTask(index + 1)),
          { ...queuedAgentRunTask(6), timeout: 1000 },
        ],
        { signal: new AbortController().signal },
      );
      void running.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(699);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);

      attempts.slice(0, 5).forEach((attempt, index) => {
        attempt.outcome.resolve({
          task: attempt.task,
          agentId: `agent-${String(index + 1)}`,
          status: 'completed',
          result: `completed ${String(index + 1)}`,
        });
      });
      await vi.advanceTimersByTimeAsync(1);

      await expect(running).resolves.toMatchObject([
        { task: { data: 1 }, status: 'completed' },
        { task: { data: 2 }, status: 'completed' },
        { task: { data: 3 }, status: 'completed' },
        { task: { data: 4 }, status: 'completed' },
        { task: { data: 5 }, status: 'completed' },
        {
          task: { data: 6 },
          agentId: 'agent-6',
          status: 'failed',
          state: 'started',
          error: 'Subagent timed out.',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase continues launching after rate-limited attempts settle', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner({
        readyDelay: (attemptIndex) => (attemptIndex >= 7 ? 100 : undefined),
      });

      const running = runBatch(
        Array.from({ length: 9 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.slice(0, 5).forEach((attempt) => {
        attempt.markReady();
      });

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(7);

      attempts[5]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-6' });
      attempts[6]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-7' });
      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });
      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'completed 2',
      });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(attempts).toHaveLength(8);
      expect(attempts[7]!.task.data).toBe(7);
      expect(attempts[7]!.retryAgentId).toBe('agent-7');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentRunBatch max concurrency cap', () => {
  it('caps in-flight tasks at maxConcurrency during the normal phase', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockAgentRunBatchRunner({ maxConcurrency: 3 });
      const running = runBatch(
        Array.from({ length: 9 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: new AbortController().signal },
      );
      const resolved = new Set<number>();
      const resolveOne = (index: number) => {
        const attempt = attempts[index]!;
        resolved.add(index);
        attempt.outcome.resolve({
          task: attempt.task,
          agentId: `agent-${String(index + 1)}`,
          status: 'completed',
          result: `result ${String(index + 1)}`,
        });
      };
      const inFlight = () => attempts.length - resolved.size;

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(3);
      expect(inFlight()).toBe(3);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(3);

      resolveOne(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(4);
      expect(inFlight()).toBeLessThanOrEqual(3);

      resolveOne(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      expect(inFlight()).toBeLessThanOrEqual(3);

      resolveOne(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(6);
      expect(inFlight()).toBeLessThanOrEqual(3);

      for (let index = 3; index < 9; index += 1) {
        resolveOne(index);
        await vi.advanceTimersByTimeAsync(700);
        expect(inFlight()).toBeLessThanOrEqual(3);
      }

      const results = await running;
      expect(results).toHaveLength(9);
      expect(results.every((result) => result.status === 'completed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentRunBatch swarm item forwarding', () => {
  function recordingLauncher() {
    const spawned: AgentSpawnAttemptOptions[] = [];
    let nextId = 1;
    const launcher: AgentRunBatchLauncher = {
      spawn: vi.fn(async (options) => {
        spawned.push(options);
        return {
          agentId: `agent-${String(nextId++)}`,
          profileName: options.profileName,
          completion: Promise.resolve({ result: 'ok' }),
        };
      }),
      resume: vi.fn(async () => {
        throw new Error('unexpected resume');
      }),
      retry: vi.fn(async () => {
        throw new Error('unexpected retry');
      }),
    };
    return { launcher, spawned };
  }

  function spawnTask(swarmItem?: string): QueuedAgentRunTask {
    return {
      kind: 'spawn',
      data: {},
      profileName: 'subagent',
      parentToolCallId: 'call_swarm',
      prompt: 'Review the file',
      description: 'Review #1 (subagent)',
      swarmItem,
      runInBackground: false,
    };
  }

  it('forwards swarmItem from a spawn task to launcher.spawn', async () => {
    const { launcher, spawned } = recordingLauncher();

    const results = await new AgentRunBatch(launcher, [spawnTask('src/a.ts')]).run();

    expect(launcher.spawn).toHaveBeenCalledOnce();
    expect(spawned[0]).toMatchObject({
      profileName: 'subagent',
      swarmItem: 'src/a.ts',
    });
    expect(results).toMatchObject([{ status: 'completed', agentId: 'agent-1' }]);
  });

  it('leaves swarmItem undefined for spawn tasks without one', async () => {
    const { launcher, spawned } = recordingLauncher();

    await new AgentRunBatch(launcher, [spawnTask()]).run();

    expect(launcher.spawn).toHaveBeenCalledOnce();
    expect(spawned[0]?.swarmItem).toBeUndefined();
  });
});

describe('SessionSwarmService metadata compatibility', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let agents: Record<string, AgentMeta>;
  let handles: Map<string, IAgentScopeHandle>;
  let lifecycle: IAgentLifecycleService;
  let subagents: ISessionSubagentService;
  let createAgent: ReturnType<typeof vi.fn>;
  let runAgent: ReturnType<typeof vi.fn>;
  let resolveSpawnRoute: ReturnType<typeof vi.fn>;
  let eventBus: IEventBus;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    agents = {};
    handles = new Map();
    eventBus = eventBusStub();
    lifecycle = lifecycleStub(handles, eventBus);
    subagents = subagentStub();
    createAgent = lifecycle.create as ReturnType<typeof vi.fn>;
    runAgent = subagents.run as ReturnType<typeof vi.fn>;
    resolveSpawnRoute = vi.fn(async () => undefined);
    handles.set('main', agentHandle('main', lifecycle, eventBus));

    ix.stub(ISessionSubagentRoutingService, {
      _serviceBrand: undefined,
      resolveSpawnRoute,
    } as unknown as ISessionSubagentRoutingService);
    ix.stub(IFlagService, {
      _serviceBrand: undefined,
      // Worktree isolation is exercised by its own dedicated tests; these
      // swarm tests must not be at the mercy of the ambient experimental
      // environment (e.g. KIMI_CODE_EXPERIMENTAL_SUBAGENT_WORKTREE_ISOLATION
      // inherited into the test process).
      enabled: () => false,
    } as unknown as IFlagService);
    ix.stub(IAgentLifecycleService, lifecycle);
    ix.stub(ISessionSubagentService, subagents);
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) =>
        name === 'coder'
          ? normalizeAgentProfile({ name: 'coder', tools: [], systemPrompt: () => '' })
          : undefined,
      getDefault: () => normalizeAgentProfile({ name: 'agent', tools: [], systemPrompt: () => '' }),
      list: () => [],
    });
    ix.stub(
      ISessionContext,
      makeSessionContext({
        sessionId: 's1',
        workspaceId: 'w1',
        sessionDir: '/tmp/kimi/s1',
        sessionScope: 'sessions/w1/s1',
        cwd: '/repo',
      }),
    );
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: Event.None as Event<SessionMetadataChangedEvent>,
      read: async () => ({
        id: 's1',
        createdAt: 0,
        updatedAt: 0,
        archived: false,
        agents,
      }),
      update: async () => {},
      setTitle: async () => {},
      setArchived: async () => {},
      registerAgent: async (agentId, meta) => {
        agents[agentId] = meta;
      },
    });
    ix.stub(ISessionProcessRunner, {
      _serviceBrand: undefined,
      exec: async () => {
        throw new Error('unexpected process exec');
      },
    });
    ix.stub(ILogService, stubLog());
    ix.stub(IModelCatalog, {
      _serviceBrand: undefined,
      get: (alias: string) => {
        if (alias === 'provider/bad') {
          throw new Error2(
            ConfigErrors.codes.CONFIG_INVALID,
            'Model "provider/bad" is not configured in config.toml.',
            { details: { model: 'provider/bad' } },
          );
        }
        return { id: alias } as Model;
      },
    } as IModelCatalog);
    ix.set(ISessionSwarmService, new SyncDescriptor(SessionSwarmService));
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('reads swarm items from caller-owned v2 labels and legacy v1 metadata', async () => {
    agents['v2-child'] = {
      labels: { parentAgentId: 'main', swarmItem: 'src/a.ts' },
    };
    agents['legacy-child'] = {
      type: 'sub',
      parentAgentId: 'main',
      swarmItem: 'src/legacy.ts',
    };
    agents['other-child'] = {
      labels: { parentAgentId: 'other', swarmItem: 'src/other.ts' },
    };

    const service = ix.get(ISessionSwarmService);

    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'v2-child' }),
    ).resolves.toBe('src/a.ts');
    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'legacy-child' }),
    ).resolves.toBe('src/legacy.ts');
    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'other-child' }),
    ).resolves.toBeUndefined();
    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'missing' }),
    ).resolves.toBeUndefined();
  });

  it('prefers labels over legacy metadata fields when both are present', async () => {
    agents['mixed-child'] = {
      labels: { parentAgentId: 'main', swarmItem: 'src/labels.ts' },
      type: 'sub',
      parentAgentId: 'other',
      swarmItem: 'src/legacy.ts',
    };

    const service = ix.get(ISessionSwarmService);

    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'mixed-child' }),
    ).resolves.toBe('src/labels.ts');
    await expect(
      service.getSwarmItem({ callerAgentId: 'other', agentId: 'mixed-child' }),
    ).resolves.toBeUndefined();
  });

  it('normalizes legacy subagent metadata into labels for new writes', () => {
    expect(
      labelsFromAgentMeta({
        type: 'sub',
        parentAgentId: 'main',
        swarmItem: 'src/legacy.ts',
      }),
    ).toEqual({ parentAgentId: 'main', swarmItem: 'src/legacy.ts' });
    expect(
      labelsFromAgentMeta({
        labels: { parentAgentId: 'main', swarmItem: 'src/labels.ts', custom: 'kept' },
        type: 'sub',
        parentAgentId: 'other',
        swarmItem: 'src/legacy.ts',
      }),
    ).toEqual({ parentAgentId: 'main', swarmItem: 'src/labels.ts', custom: 'kept' });
  });

  it('persists caller ownership and swarm item labels on spawned children', async () => {
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [spawnSessionTask('src/a.ts')],
      }),
    ).resolves.toMatchObject([
      {
        agentId: 'agent-new',
        status: 'completed',
        result: 'child summary',
      },
    ]);

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: {
          profile: 'coder',
          model: 'kimi-test',
          thinking: 'medium',
        },
        labels: { parentAgentId: 'main', swarmItem: 'src/a.ts' },
      }),
    );
  });

  it('inherits parent user tools on spawned children', async () => {
    const parentUserTools = userToolServiceStub();
    const childUserTools = userToolServiceStub();
    handles.set(
      'main',
      agentHandle('main', lifecycle, eventBus, {}, new Map([
        [IAgentUserToolService, parentUserTools],
      ])),
    );
    createAgent.mockImplementationOnce((opts: CreateAgentOptions = {}) => {
      const id = opts.agentId ?? 'agent-new';
      const handle = agentHandle(
        id,
        lifecycle,
        eventBus,
        {
          profileName: opts.binding?.profile ?? 'coder',
          modelAlias: opts.binding?.model ?? 'kimi-test',
          thinkingLevel: opts.binding?.thinking ?? 'medium',
        },
        new Map([[IAgentUserToolService, childUserTools]]),
      );
      handles.set(id, handle);
      return handle;
    });
    const service = ix.get(ISessionSwarmService);

    await service.run({
      callerAgentId: 'main',
      tasks: [spawnSessionTask('src/a.ts')],
    });

    expect(childUserTools.inheritUserTools).toHaveBeenCalledWith(parentUserTools);
  });

  it('keeps v1 resume ownership errors inside the per-subagent result', async () => {
    agents['other-child'] = {
      labels: { parentAgentId: 'other', swarmItem: 'src/other.ts' },
    };
    handles.set('other-child', agentHandle('other-child', lifecycle, eventBusStub()));
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('other-child')],
      }),
    ).resolves.toMatchObject([
      {
        status: 'failed',
        state: 'not_started',
        error: 'Agent instance "other-child" does not belong to this parent agent',
      },
    ]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('keeps resumed children on their own recorded model', async () => {
    agents['agent-existing'] = {
      labels: { parentAgentId: 'main' },
    };
    const child = agentHandle('agent-existing', lifecycle, eventBus, {
      profileName: 'explore',
      modelAlias: 'stale-model',
    });
    handles.set('agent-existing', child);
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('agent-existing')],
      }),
    ).resolves.toMatchObject([{ status: 'completed', agentId: 'agent-existing' }]);

    // No realign: resume must not drag the child back to the parent's model.
    expect(child.accessor.get(IAgentProfileService).data().modelAlias).toBe('stale-model');
    expect(runAgent).toHaveBeenCalledWith(
      'agent-existing',
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('prefers the spawn task binding over the caller model', async () => {
    const service = ix.get(ISessionSwarmService);
    const spawnTask: SessionSwarmSpawnTask = {
      ...spawnSessionTask('src/a.ts'),
      kind: 'spawn',
      binding: { model: 'provider/secondary', thinking: 'low' },
    };

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [spawnTask],
      }),
    ).resolves.toMatchObject([{ status: 'completed', agentId: 'agent-new' }]);

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: {
          profile: 'coder',
          model: 'provider/secondary',
          thinking: 'low',
        },
      }),
    );
  });

  it('points at the secondary model config when a spawn task binding is invalid', async () => {
    const service = ix.get(ISessionSwarmService);
    const spawnTask: SessionSwarmSpawnTask = {
      ...spawnSessionTask('src/a.ts'),
      kind: 'spawn',
      binding: { model: 'provider/bad', thinking: 'low' },
    };

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [spawnTask],
      }),
    ).resolves.toMatchObject([
      {
        status: 'failed',
        error: expect.stringContaining('comes from [secondary_model].model / KIMI_SECONDARY_MODEL'),
      },
    ]);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('does not emit spawned again when a rate-limited child retries', async () => {
    vi.useFakeTimers();
    try {
      agents['agent-retry'] = {
        labels: { parentAgentId: 'main' },
      };
      agents['agent-blocker'] = {
        labels: { parentAgentId: 'main' },
      };
      handles.set('agent-retry', agentHandle('agent-retry', lifecycle, eventBus));
      handles.set('agent-blocker', agentHandle('agent-blocker', lifecycle, eventBus));
      const rateLimited = createControlledPromise<{ summary: string }>();
      const blocker = createControlledPromise<{ summary: string }>();
      const published: DomainEvent[] = [];
      (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: DomainEvent) => {
        published.push(event);
      });
      let retryRuns = 0;
      runAgent.mockImplementation((agentId, request, options) => {
        options?.onReady?.();
        if (agentId === 'agent-retry') {
          retryRuns += 1;
          return {
            agentId,
            turn: {} as never,
            completion:
              retryRuns === 1
                ? rateLimited
                : Promise.resolve({ summary: 'recovered summary' }),
          };
        }
        return { agentId, turn: {} as never, completion: blocker };
      });
      const service = ix.get(ISessionSwarmService);

      const running = service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('agent-retry'), resumeSessionTask('agent-blocker')],
      });
      await vi.advanceTimersByTimeAsync(0);
      rateLimited.reject(new APIProviderRateLimitError('Rate limited'));
      await vi.advanceTimersByTimeAsync(0);
      blocker.resolve({ summary: 'blocker summary' });
      await vi.advanceTimersByTimeAsync(3_000);
      await running;

      expect(
        published
          .filter((event) => event.type === 'subagent.spawned')
          .map((event) => event.subagentId),
      ).toEqual(['agent-retry', 'agent-blocker']);
      expect(
        runAgent.mock.calls
          .filter(([agentId]) => agentId === 'agent-retry')
          .map(([, request]) => request),
      ).toEqual([{ kind: 'prompt', prompt: 'Continue' }, { kind: 'retry' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects resume of an already running child before launching or emitting spawned', async () => {
    agents['agent-existing'] = {
      labels: { parentAgentId: 'main' },
    };
    handles.set(
      'agent-existing',
      agentHandle('agent-existing', lifecycle, eventBus, {}, new Map([
        [
          IAgentLoopService,
          {
            _serviceBrand: undefined,
            status: () => ({ state: 'running', activeTurnId: 1, pendingTurnIds: [], hasPendingRequests: true }),
          },
        ],
      ])),
    );
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('agent-existing')],
      }),
    ).resolves.toMatchObject([
      {
        status: 'failed',
        state: 'not_started',
        error:
          'Agent instance "agent-existing" is already running and cannot run concurrently',
      },
    ]);
    expect(runAgent).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subagent.spawned' }),
    );
  });

  it('routes spawns through the profile route when one resolves', async () => {
    resolveSpawnRoute.mockResolvedValue({
      route: { kind: 'internal', modelAlias: 'provider/routed', thinkingEffort: 'high' },
    });
    const service = ix.get(ISessionSwarmService);
    const spawnTask: SessionSwarmSpawnTask = {
      ...spawnSessionTask('src/a.ts'),
      kind: 'spawn',
      binding: { model: 'provider/secondary', thinking: 'low' },
    };

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [spawnTask],
      }),
    ).resolves.toMatchObject([{ status: 'completed', agentId: 'agent-new' }]);

    expect(resolveSpawnRoute).toHaveBeenCalledWith('coder', expect.anything());
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: {
          profile: 'coder',
          model: 'provider/routed',
          thinking: 'high',
        },
      }),
    );
  });

  it('keeps the binding thinking when the route sets only a model', async () => {
    resolveSpawnRoute.mockResolvedValue({
      route: { kind: 'internal', modelAlias: 'provider/routed', thinkingEffort: undefined },
    });
    const service = ix.get(ISessionSwarmService);
    const spawnTask: SessionSwarmSpawnTask = {
      ...spawnSessionTask('src/a.ts'),
      kind: 'spawn',
      binding: { model: 'provider/secondary', thinking: 'low' },
    };

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [spawnTask],
      }),
    ).resolves.toMatchObject([{ status: 'completed', agentId: 'agent-new' }]);

    // D-B5R-5 per-field override: the route wins the model, the caller
    // binding keeps its thinking.
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: {
          profile: 'coder',
          model: 'provider/routed',
          thinking: 'low',
        },
      }),
    );
  });

  it('releases the pool slot when the spawned run settles', async () => {
    const releasePoolSlot = vi.fn();
    resolveSpawnRoute.mockResolvedValue({
      route: { kind: 'internal', modelAlias: 'provider/routed', thinkingEffort: undefined },
      releasePoolSlot,
    });
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [spawnSessionTask('src/a.ts')],
      }),
    ).resolves.toMatchObject([{ status: 'completed' }]);

    expect(releasePoolSlot).toHaveBeenCalledOnce();
  });

  it('holds the pool slot across a provider-rate-limit retry of the same agent', async () => {
    vi.useFakeTimers();
    try {
      agents['agent-pooled'] = {
        labels: { parentAgentId: 'main' },
      };
      const releasePoolSlot = vi.fn();
      let routeCalls = 0;
      resolveSpawnRoute.mockImplementation(async () => {
        routeCalls += 1;
        return routeCalls === 1
          ? {
              route: { kind: 'internal', modelAlias: 'provider/routed', thinkingEffort: undefined },
              releasePoolSlot,
            }
          : { route: { kind: 'internal', modelAlias: 'provider/routed', thinkingEffort: undefined } };
      });
      let created = 0;
      createAgent.mockImplementation(async (opts: CreateAgentOptions = {}) => {
        created += 1;
        const id = created === 1 ? 'agent-pooled' : 'agent-blocker';
        const handle = agentHandle(id, lifecycle, eventBus, {
          profileName: opts.binding?.profile ?? 'coder',
          modelAlias: opts.binding?.model ?? 'kimi-test',
          thinkingLevel: opts.binding?.thinking ?? 'medium',
        });
        handles.set(id, handle);
        return handle;
      });
      const rateLimited = createControlledPromise<{ summary: string }>();
      const blocker = createControlledPromise<{ summary: string }>();
      let pooledRuns = 0;
      runAgent.mockImplementation((agentId, request, options) => {
        options?.onReady?.();
        if (agentId === 'agent-pooled') {
          pooledRuns += 1;
          return {
            agentId,
            turn: {} as never,
            completion:
              pooledRuns === 1
                ? rateLimited
                : Promise.resolve({ summary: 'recovered summary' }),
          };
        }
        return { agentId, turn: {} as never, completion: blocker };
      });
      const service = ix.get(ISessionSwarmService);

      const running = service.run({
        callerAgentId: 'main',
        tasks: [spawnSessionTask('src/a.ts'), spawnSessionTask('src/b.ts')],
      });
      await vi.advanceTimersByTimeAsync(0);
      rateLimited.reject(new APIProviderRateLimitError('Rate limited'));
      await vi.advanceTimersByTimeAsync(0);
      // The slot stays held while the rate-limited agent is requeued for retry.
      expect(releasePoolSlot).not.toHaveBeenCalled();
      blocker.resolve({ summary: 'blocker summary' });
      await vi.advanceTimersByTimeAsync(3_000);
      await running;

      expect(releasePoolSlot).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules the rate-limit retry while another spawn is queued on the saturated pool', async () => {
    vi.useFakeTimers();
    try {
      agents['agent-pooled'] = {
        labels: { parentAgentId: 'main' },
      };
      // Cross-layer deadlock (D-B5R-8): real pool maxConcurrency=1 — B is
      // stuck in acquireQueued inside the launcher while A's rate-limit
      // retry waits for rateLimitCapacity. Pre-fix B's attempt still counts
      // as `active` (capacity 1), so the retry is never scheduled.
      const pool = new SubagentRoutePool([
        { backend: 'kimi', model: 'provider/routed', maxConcurrency: 1 },
      ]);
      const releases: ReturnType<typeof vi.fn>[] = [];
      resolveSpawnRoute.mockImplementation(async () => {
        const acquired = await pool.acquireQueued();
        const release = vi.fn(acquired.release);
        releases.push(release);
        return {
          route: { kind: 'internal', modelAlias: 'provider/routed', thinkingEffort: undefined },
          releasePoolSlot: release,
        };
      });
      let created = 0;
      createAgent.mockImplementation(async (opts: CreateAgentOptions = {}) => {
        created += 1;
        const id = created === 1 ? 'agent-pooled' : 'agent-queued';
        const handle = agentHandle(id, lifecycle, eventBus, {
          profileName: opts.binding?.profile ?? 'coder',
          modelAlias: opts.binding?.model ?? 'kimi-test',
          thinkingLevel: opts.binding?.thinking ?? 'medium',
        });
        handles.set(id, handle);
        return handle;
      });
      const rateLimited = createControlledPromise<{ summary: string }>();
      runAgent.mockImplementation((agentId: string, request: unknown, options: { onReady?: () => void } | undefined) => {
        options?.onReady?.();
        if (agentId === 'agent-pooled') {
          const kind = (request as { kind?: string }).kind;
          if (kind === 'retry') {
            return { agentId, turn: {} as never, completion: Promise.resolve({ summary: 'recovered' }) };
          }
          return { agentId, turn: {} as never, completion: rateLimited };
        }
        return { agentId, turn: {} as never, completion: Promise.resolve({ summary: 'ok' }) };
      });
      const service = ix.get(ISessionSwarmService);

      const running = service.run({
        callerAgentId: 'main',
        tasks: [spawnSessionTask('src/a.ts'), spawnSessionTask('src/b.ts')],
      });
      await vi.advanceTimersByTimeAsync(0);
      rateLimited.reject(new APIProviderRateLimitError('Rate limited'));
      await vi.advanceTimersByTimeAsync(0);
      // The slot stays held across the requeue…
      expect(releases).toHaveLength(1);
      expect(releases[0]).not.toHaveBeenCalled();
      // …the retry is still scheduled despite B queueing on the pool, A
      // recovers and releases, B follows.
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);
      const results = await running;

      expect(results).toMatchObject([
        { status: 'completed', result: 'recovered' },
        { status: 'completed', result: 'ok' },
      ]);
      expect(resolveSpawnRoute).toHaveBeenCalledTimes(2);
      expect(releases).toHaveLength(2);
      expect(releases[0]).toHaveBeenCalledOnce();
      expect(releases[1]).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the pool slot when subagents.run rejects before the run starts', async () => {
    // Real pool, maxConcurrency 1: the second spawn queues behind the first,
    // so this deadlocks without the observe() early-failure release.
    const pool = new SubagentRoutePool([
      { backend: 'kimi', model: 'provider/routed', maxConcurrency: 1 },
    ]);
    const releases: ReturnType<typeof vi.fn>[] = [];
    resolveSpawnRoute.mockImplementation(async () => {
      const acquired = await pool.acquireQueued();
      const release = vi.fn(acquired.release);
      releases.push(release);
      return {
        route: { kind: 'internal', modelAlias: 'provider/routed', thinkingEffort: undefined },
        releasePoolSlot: release,
      };
    });
    let created = 0;
    createAgent.mockImplementation(async (opts: CreateAgentOptions = {}) => {
      created += 1;
      const id = `agent-${created}`;
      const handle = agentHandle(id, lifecycle, eventBus, {
        profileName: opts.binding?.profile ?? 'coder',
        modelAlias: opts.binding?.model ?? 'kimi-test',
        thinkingLevel: opts.binding?.thinking ?? 'medium',
      });
      handles.set(id, handle);
      return handle;
    });
    runAgent.mockImplementation((agentId: string, _request: unknown, options: { onReady?: () => void } | undefined) => {
      options?.onReady?.();
      if (agentId === 'agent-1') return Promise.reject(new Error('run failed to start'));
      return { agentId, turn: {} as never, completion: Promise.resolve({ summary: 'ok' }) };
    });
    const service = ix.get(ISessionSwarmService);

    const results = await service.run({
      callerAgentId: 'main',
      tasks: [spawnSessionTask('src/a.ts'), spawnSessionTask('src/b.ts')],
    });

    expect(results).toMatchObject([{ status: 'failed' }, { status: 'completed' }]);
    expect(releases).toHaveLength(2);
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).toHaveBeenCalledOnce();
  });

  it('releases the pool slot when the retried subagents.run rejects after a rate-limit requeue', async () => {
    vi.useFakeTimers();
    try {
      agents['agent-pooled'] = {
        labels: { parentAgentId: 'main' },
      };
      const releasePoolSlot = vi.fn();
      resolveSpawnRoute.mockResolvedValue({
        route: { kind: 'internal', modelAlias: 'provider/routed', thinkingEffort: undefined },
        releasePoolSlot,
      });
      createAgent.mockImplementation(async (opts: CreateAgentOptions = {}) => {
        const handle = agentHandle('agent-pooled', lifecycle, eventBus, {
          profileName: opts.binding?.profile ?? 'coder',
          modelAlias: opts.binding?.model ?? 'kimi-test',
          thinkingLevel: opts.binding?.thinking ?? 'medium',
        });
        handles.set('agent-pooled', handle);
        return handle;
      });
      const rateLimited = createControlledPromise<{ summary: string }>();
      let pooledRuns = 0;
      runAgent.mockImplementation((agentId: string, _request: unknown, options: { onReady?: () => void } | undefined) => {
        options?.onReady?.();
        pooledRuns += 1;
        // The retry after the rate-limit requeue fails before the run
        // starts: no completion handler exists, the slot must go here.
        if (pooledRuns === 2) return Promise.reject(new Error('retry run failed to start'));
        return { agentId, turn: {} as never, completion: rateLimited };
      });
      const service = ix.get(ISessionSwarmService);

      const running = service.run({
        callerAgentId: 'main',
        tasks: [spawnSessionTask('src/a.ts')],
      });
      await vi.advanceTimersByTimeAsync(0);
      rateLimited.reject(new APIProviderRateLimitError('Rate limited'));
      // Retry fires, its subagents.run() rejects before the run starts: the
      // observe() catch must release the held slot — exactly once (the
      // per-batch sweep must not double-release).
      await vi.advanceTimersByTimeAsync(5_000);
      const results = await running;

      expect(results).toMatchObject([{ status: 'failed' }]);
      expect(releasePoolSlot).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not arm the per-task timer when the task timeout is 0 (print mode)', async () => {
    vi.useFakeTimers();
    try {
      // Print mode fills `[subagent] timeout_ms = 0` as "effectively
      // unbounded"; arming setTimeout with 0 aborts the attempt before the
      // launcher returns ("Subagent timed out." / not_started). The stub
      // honors the attempt signal so the abort is observable.
      const controlled = createControlledPromise<{ summary: string }>();
      runAgent.mockImplementation(
        (agentId: string, _request: unknown, options: { onReady?: () => void; signal?: AbortSignal } | undefined) => {
          options?.onReady?.();
          const completion = new Promise<{ summary: string }>((resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), {
              once: true,
            });
            controlled.then(resolve, reject);
          });
          return { agentId, turn: {} as never, completion };
        },
      );
      const service = ix.get(ISessionSwarmService);

      const running = service.run({
        callerAgentId: 'main',
        tasks: [{ ...spawnSessionTask('src/a.ts'), timeout: 0 }],
      });
      // A real run always takes at least one macrotask; a wrongly armed 0ms
      // timer fires here and aborts the attempt.
      await vi.advanceTimersByTimeAsync(0);
      controlled.resolve({ summary: 'ok' });
      const results = await running;

      expect(results).toMatchObject([{ status: 'completed' }]);
      expect(results[0]).not.toMatchObject({ error: 'Subagent timed out.' });
    } finally {
      vi.useRealTimers();
    }
  });

  // R-C1 risk gate wiring: an editing-capable batch at/above the concurrency
  // threshold is silently serialized (maxConcurrency forced to 1); below the
  // threshold or read-only, the batch schedule is untouched. v2 tasks carry
  // no dispatch scope yet, so only the threshold signal is live.
  describe('risk gate (R-C1)', () => {
    function stubEditingCapableCatalog(): void {
      ix.stub(ISessionAgentProfileCatalog, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        get: (name: string) =>
          name === 'coder'
            ? normalizeAgentProfile({
                name: 'coder',
                tools: ['Write', 'Edit'],
                systemPrompt: () => '',
              })
            : undefined,
        getDefault: () =>
          normalizeAgentProfile({ name: 'agent', tools: [], systemPrompt: () => '' }),
        list: () => [],
      });
    }

    function controlledRuns(): {
      completions: Array<ReturnType<typeof createControlledPromise<{ summary: string }>>>;
    } {
      const completions: Array<ReturnType<typeof createControlledPromise<{ summary: string }>>> =
        [];
      runAgent.mockImplementation(
        (agentId: string, _request: unknown, options?: { onReady?: () => void }) => {
          options?.onReady?.();
          const completion = createControlledPromise<{ summary: string }>();
          completions.push(completion);
          return { agentId, turn: {} as never, completion };
        },
      );
      return { completions };
    }

    function spawnTasks(count: number): SessionSwarmSpawnTask[] {
      return Array.from({ length: count }, (_, index) => ({
        ...spawnSessionTask(`src/f${String(index)}.ts`),
        swarmIndex: index + 1,
      }));
    }

    it('serializes an editing-capable batch at the concurrency threshold', async () => {
      vi.useFakeTimers();
      try {
        stubEditingCapableCatalog();
        const { completions } = controlledRuns();
        const service = ix.get(ISessionSwarmService);

        const running = service.run({ callerAgentId: 'main', tasks: spawnTasks(4) });
        await vi.advanceTimersByTimeAsync(0);
        expect(runAgent).toHaveBeenCalledTimes(1);

        completions[0]!.resolve({ summary: 'one' });
        await vi.advanceTimersByTimeAsync(0);
        expect(runAgent).toHaveBeenCalledTimes(2);

        completions[1]!.resolve({ summary: 'two' });
        await vi.advanceTimersByTimeAsync(0);
        expect(runAgent).toHaveBeenCalledTimes(3);

        completions[2]!.resolve({ summary: 'three' });
        await vi.advanceTimersByTimeAsync(0);
        expect(runAgent).toHaveBeenCalledTimes(4);

        completions[3]!.resolve({ summary: 'four' });
        await expect(running).resolves.toMatchObject([
          { status: 'completed' },
          { status: 'completed' },
          { status: 'completed' },
          { status: 'completed' },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not serialize an editing-capable batch below the threshold', async () => {
      vi.useFakeTimers();
      try {
        stubEditingCapableCatalog();
        const { completions } = controlledRuns();
        const service = ix.get(ISessionSwarmService);

        const running = service.run({ callerAgentId: 'main', tasks: spawnTasks(3) });
        await vi.advanceTimersByTimeAsync(0);
        expect(runAgent).toHaveBeenCalledTimes(3);

        for (const completion of completions) completion.resolve({ summary: 'done' });
        await expect(running).resolves.toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not serialize a read-only batch even above the threshold', async () => {
      vi.useFakeTimers();
      try {
        // Default catalog stub: coder has `tools: []` — not editing-capable.
        const { completions } = controlledRuns();
        const service = ix.get(ISessionSwarmService);

        const running = service.run({ callerAgentId: 'main', tasks: spawnTasks(5) });
        await vi.advanceTimersByTimeAsync(0);
        expect(runAgent).toHaveBeenCalledTimes(5);

        for (const completion of completions) completion.resolve({ summary: 'done' });
        await expect(running).resolves.toHaveLength(5);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // R-A2 circuit breaker, end to end across services. The unit tests on either
  // side open the circuit by hand with a literal key, so nothing covered the
  // seam: a real spawn failure flowing through `recordCircuitFailure` into the
  // session-scoped circuit, and the *next* spawn resolving to the fallback
  // chain because of it. Both services are real here — only the run fails.
  describe('circuit breaker (R-A2) end to end', () => {
    function realRouting(): void {
      const config = {
        get: ((domain: string) =>
          ({
            [MODELS_SECTION]: {
              fast: { provider: 'local', model: 'fast-model' },
              precise: { provider: 'local', model: 'precise-model' },
            },
            [SUBAGENT_SECTION]: {
              routing: { coder: { model: 'fast' } },
              fallbackChain: [{ backend: 'kimi', model: 'precise' }],
            },
          })[domain]) as IConfigService['get'],
      } as unknown as IConfigService;
      // The swarm records failures against the circuit it gets injected, while
      // routing reads the one it was constructed with. In production the
      // Session scope hands both the same instance; sharing it here is what
      // makes this an integration test rather than two isolated stubs.
      const circuit = new SessionSubagentCircuitService();
      ix.stub(ISessionSubagentCircuitService, circuit);
      ix.stub(
        ISessionSubagentRoutingService,
        new SessionSubagentRoutingService(config, circuit),
      );
    }

    function modelOfCreateCall(index: number): unknown {
      return (createAgent.mock.calls[index]?.[0] as { binding?: { model?: unknown } } | undefined)
        ?.binding?.model;
    }

    it('opens the circuit from a real spawn failure and takes the fallback next time', async () => {
      realRouting();
      const service = ix.get(ISessionSwarmService);

      // First batch: the run rejects with a non-retryable route failure.
      runAgent.mockImplementationOnce(() => {
        throw new Error2(ErrorCodes.PROVIDER_AUTH_ERROR, 'auth rejected');
      });
      const first = await service.run({ callerAgentId: 'main', tasks: [spawnSessionTask()] });

      expect(first).toMatchObject([{ status: 'failed' }]);
      expect(modelOfCreateCall(0)).toBe('fast');

      // Second batch: the circuit opened above must divert this spawn onto the
      // fallback chain. The circuit is session-scoped, so it survives the batch.
      const second = await service.run({ callerAgentId: 'main', tasks: [spawnSessionTask()] });

      expect(second).toMatchObject([{ status: 'completed' }]);
      expect(modelOfCreateCall(1)).toBe('precise');
    });

    it('leaves the route intact when the failure is transient', async () => {
      realRouting();
      const service = ix.get(ISessionSwarmService);

      runAgent.mockImplementationOnce(() => {
        throw new APIProviderRateLimitError('rate limited');
      });
      await service.run({ callerAgentId: 'main', tasks: [spawnSessionTask()] });

      // A rate limit is not a route defect: the next spawn stays on `fast`.
      const second = await service.run({ callerAgentId: 'main', tasks: [spawnSessionTask()] });

      expect(second).toMatchObject([{ status: 'completed' }]);
      expect(modelOfCreateCall(1)).toBe('fast');
    });
  });

  describe('worktree isolation wiring', () => {
    const PARENT_WORKTREE = '/repo/.git/kimi-code-subagent-worktrees/parent';
    let acquiredFrom: string[];
    let acquiredScopes: (readonly string[] | undefined)[];
    let finish: ReturnType<typeof vi.fn>;

    function isolationEnabled(): void {
      ix.stub(IFlagService, {
        _serviceBrand: undefined,
        enabled: () => true,
      } as unknown as IFlagService);
    }

    function catalogWith(tools: readonly string[] | undefined): void {
      ix.stub(ISessionAgentProfileCatalog, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        get: () => normalizeAgentProfile({ name: 'coder', tools, systemPrompt: () => '' }),
        getDefault: () => normalizeAgentProfile({ name: 'agent', tools: [], systemPrompt: () => '' }),
        list: () => [],
      } as unknown as ISessionAgentProfileCatalog);
    }

    beforeEach(() => {
      acquiredFrom = [];
      acquiredScopes = [];
      finish = vi.fn(async () => ({ applied: false, reason: 'discarded' }));
      worktreeMock.acquire = (cwd: string, options?: { readonly scope?: readonly string[] }) => {
        acquiredFrom.push(cwd);
        acquiredScopes.push(options?.scope);
        return { cwd: '/repo/.git/kimi-code-subagent-worktrees/child', finish };
      };
    });

    afterEach(() => {
      worktreeMock.acquire = undefined;
    });

    // AgentSwarm had no scope field at all, so every swarm-spawned editing
    // worker reached the apply path with an empty scope — which that path reads
    // as "unrestricted" and writes back wholesale. The guard is on the spawn
    // path itself, so it holds with the isolation flag off too.
    it.each([true, false])(
      'refuses a swarm-spawned editing worker with no scope (isolation flag: %s)',
      async (flagEnabled: boolean) => {
        if (flagEnabled) isolationEnabled();
        catalogWith(['Write', 'Edit']);
        const service = ix.get(ISessionSwarmService);
        const unscoped: SessionSwarmSpawnTask = {
          ...spawnSessionTask('src/a.ts'),
          kind: 'spawn',
          dispatchScope: undefined,
        };

        const results = await service.run({ callerAgentId: 'main', tasks: [unscoped] });

        expect(JSON.stringify(results)).toContain(
          'An editing-capable dispatch requires at least one scope entry.',
        );
        expect(acquiredFrom).toEqual([]);
      },
    );

    it('carries each item declared scope through to its own worktree', async () => {
      isolationEnabled();
      catalogWith(['Write', 'Edit']);
      const service = ix.get(ISessionSwarmService);
      const scoped: SessionSwarmSpawnTask = {
        ...spawnSessionTask('src/a.ts'),
        kind: 'spawn',
        dispatchScope: ['  src//./a.ts  '],
      };

      await service.run({ callerAgentId: 'main', tasks: [scoped] });

      expect(acquiredScopes).toEqual([['src/a.ts']]);
    });

    it('branches a nested swarm off the caller worktree, not the session workspace', async () => {
      // This service is Session-scoped: reading the cwd off the session
      // context would send an isolated caller's swarm children straight back
      // at the user's workspace, defeating the parent's isolation.
      isolationEnabled();
      catalogWith(['Write', 'Edit']);
      handles.set(
        'main',
        agentHandle('main', lifecycle, eventBus, {}, new Map([
          [
            ISessionContext,
            makeSessionContext({
              sessionId: 's1',
              workspaceId: 'w1',
              sessionDir: '/tmp/kimi/s1',
              sessionScope: 'sessions/w1/s1',
              cwd: PARENT_WORKTREE,
            }),
          ],
        ])),
      );
      const service = ix.get(ISessionSwarmService);

      await service.run({ callerAgentId: 'main', tasks: [spawnSessionTask()] });

      expect(acquiredFrom).toEqual([PARENT_WORKTREE]);
    });

    it('isolates a profile that declares no tool list', async () => {
      // An absent tool list means the profile inherits the full default set,
      // Write/Edit included. Reading it as an empty list would silently skip
      // isolation for every profile that does not spell its tools out.
      isolationEnabled();
      catalogWith(undefined);
      const service = ix.get(ISessionSwarmService);

      await service.run({ callerAgentId: 'main', tasks: [spawnSessionTask()] });

      expect(acquiredFrom).toEqual(['/repo']);
    });

    it('leaves a read-only profile unisolated', async () => {
      isolationEnabled();
      catalogWith(['Read', 'Grep']);
      const service = ix.get(ISessionSwarmService);

      await service.run({ callerAgentId: 'main', tasks: [spawnSessionTask()] });

      expect(acquiredFrom).toEqual([]);
    });

    it('discards the worktree when the spawn fails after acquiring it', async () => {
      // Nothing else ever will: the completion handler that finishes a
      // worktree is only attached once the child's run has started.
      isolationEnabled();
      catalogWith(['Write', 'Edit']);
      createAgent.mockImplementationOnce(() => {
        throw new Error('lifecycle exploded');
      });
      const service = ix.get(ISessionSwarmService);

      await service.run({ callerAgentId: 'main', tasks: [spawnSessionTask()] });

      expect(acquiredFrom).toEqual(['/repo']);
      expect(finish).toHaveBeenCalledTimes(1);
      expect(finish).toHaveBeenCalledWith({
        kind: 'discard',
        reason: 'spawn aborted before the child started',
      });
    });

    it('discards the worktree when the run rejects before it starts', async () => {
      isolationEnabled();
      catalogWith(['Write', 'Edit']);
      runAgent.mockImplementationOnce(() => {
        throw new Error('run rejected');
      });
      const service = ix.get(ISessionSwarmService);

      await service.run({ callerAgentId: 'main', tasks: [spawnSessionTask()] });

      expect(finish).toHaveBeenCalledTimes(1);
      expect(finish).toHaveBeenCalledWith({
        kind: 'discard',
        reason: 'spawn aborted before the child started',
      });
    });
  });
});

function spawnSessionTask(swarmItem?: string): SessionSwarmSpawnTask {
  return {
    kind: 'spawn',
    data: {},
    profileName: 'coder',
    parentToolCallId: 'call_swarm',
    prompt: 'Review the file',
    description: 'Review #1 (coder)',
    swarmIndex: 1,
    swarmItem,
    dispatchScope: ['src'],
    runInBackground: false,
  };
}

function resumeSessionTask(agentId: string): SessionSwarmTask {
  return {
    kind: 'resume',
    data: {},
    profileName: 'subagent',
    parentToolCallId: 'call_swarm',
    prompt: 'Continue',
    description: 'Resume #1 (resume)',
    swarmIndex: 1,
    runInBackground: false,
    resumeAgentId: agentId,
  };
}

function lifecycleStub(
  handles: Map<string, IAgentScopeHandle>,
  eventBus: IEventBus,
): IAgentLifecycleService {
  const lifecycle = {
    _serviceBrand: undefined,
    onDidCreate: Event.None,
    onDidDispose: Event.None,
    create: vi.fn(async (opts: CreateAgentOptions = {}) => {
      if (opts.agentId !== undefined) {
        const existing = handles.get(opts.agentId);
        if (existing !== undefined) return existing;
      }
      const id = opts.agentId ?? 'agent-new';
      const handle = agentHandle(id, lifecycle as IAgentLifecycleService, eventBus, {
        profileName: opts.binding?.profile ?? 'coder',
        modelAlias: opts.binding?.model ?? 'kimi-test',
        thinkingLevel: opts.binding?.thinking ?? 'medium',
      });
      handles.set(id, handle);
      return handle;
    }),
    fork: vi.fn(),
    get: (agentId: string) => handles.get(agentId),
    list: () => [...handles.values()],
    remove: async (agentId: string) => {
      handles.delete(agentId);
    },
    broadcastPermissionMode: () => {},
  };
  return lifecycle as IAgentLifecycleService;
}

function subagentStub(): ISessionSubagentService {
  return {
    _serviceBrand: undefined,
    hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']),
    onDidStopAgentTask: Event.None,
    run: vi.fn(async (agentId: string) => ({
      agentId,
      turn: {} as never,
      completion: Promise.resolve({ summary: 'child summary' }),
    })),
    notifyAgentTaskStopped: () => {},
  } as ISessionSubagentService;
}

function agentHandle(
  id: string,
  lifecycle: IAgentLifecycleService,
  eventBus: IEventBus,
  data: Partial<ProfileData> = {},
  services: ReadonlyMap<unknown, unknown> = new Map(),
): IAgentScopeHandle {
  const profile = profileService({
    modelAlias: 'kimi-test',
    modelCapabilities: {} as never,
    profileName: 'agent',
    thinkingLevel: 'medium',
    systemPrompt: '',
    ...data,
  });
  const permissionMode = {
    _serviceBrand: undefined,
    mode: 'auto',
    setMode: () => {},
    onDidChangeMode: Event.None,
  } as IAgentPermissionModeService;
  return {
    id,
    kind: LifecycleScope.Agent,
    accessor: {
      get: ((serviceId: unknown) => {
        const service = services.get(serviceId);
        if (service !== undefined) return service;
        if (serviceId === IAgentProfileService) return profile;
        if (serviceId === IAgentPermissionModeService) return permissionMode;
        if (serviceId === IAgentLoopService) {
          return {
            _serviceBrand: undefined,
            status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
          } as unknown as IAgentLoopService;
        }
        if (serviceId === IAgentUserToolService) return userToolServiceStub();
        if (serviceId === IEventBus) return eventBus;
        if (serviceId === ITelemetryService) return noopTelemetryService;
        if (serviceId === IAgentLifecycleService) return lifecycle;
        // An isolated subagent's Agent scope overrides this with its worktree
        // cwd; a plain agent inherits the session's. Spawning reads the cwd
        // off the caller's accessor, so the stub has to answer it.
        if (serviceId === ISessionContext) {
          return makeSessionContext({
            sessionId: 's1',
            workspaceId: 'w1',
            sessionDir: '/tmp/kimi/s1',
            sessionScope: 'sessions/w1/s1',
            cwd: '/repo',
          });
        }
        return undefined;
      }) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
  };
}

function profileService(data: ProfileData): IAgentProfileService {
  let current = data;
  return {
    _serviceBrand: undefined,
    data: () => current,
    update: (changed) => {
      current = { ...current, ...changed };
    },
    republishStatus: () => {},
  } as IAgentProfileService;
}

function userToolServiceStub(): IAgentUserToolService {
  return {
    _serviceBrand: undefined,
    list: () => [],
    inheritUserTools: vi.fn<(parent: IAgentUserToolService) => void>(),
    register: () => {},
    unregister: () => {},
  };
}

function eventBusStub(): IEventBus {
  return {
    _serviceBrand: undefined,
    publish: vi.fn((_: DomainEvent) => {}),
    subscribe: vi.fn(() => ({ dispose: () => {} })) as IEventBus['subscribe'],
  };
}

type MockAgentRunAttemptOutcome<T> =
  | AgentRunResult<T>
  | {
      readonly type: 'rate_limited';
      readonly agentId: string;
    };

type MockAgentRunAttemptRecord = {
  readonly task: QueuedAgentRunTask<number>;
  readonly retryAgentId?: string;
  readonly markReady: () => void;
  readonly outcome: ReturnType<typeof createControlledPromise<MockAgentRunAttemptOutcome<number>>>;
};

type MockAgentRunBatchRunnerOptions = {
  readonly onSuspended?: (event: AgentRunSuspendedEvent) => void;
  readonly readyDelay?: (attemptIndex: number) => number | undefined;
  readonly maxConcurrency?: number;
};

function createMockAgentRunBatchRunner(
  options: MockAgentRunBatchRunnerOptions = {},
): {
  readonly runBatch: <T>(
    tasks: readonly QueuedAgentRunTask<T>[],
    options?: { readonly signal?: AbortSignal },
  ) => Promise<Array<AgentRunResult<T>>>;
  readonly attempts: MockAgentRunAttemptRecord[];
} {
  const attempts: MockAgentRunAttemptRecord[] = [];
  let activeTasks: readonly QueuedAgentRunTask<unknown>[] = [];

  const createHandle = <T,>(
    runOptions: AgentRunAttemptOptions,
    agentId: string,
    profileName: string,
    retryAgentId?: string,
  ): AgentRunAttemptHandle => {
    const task = findMockAgentRunTask<T>(activeTasks, runOptions);
    const outcome = createControlledPromise<MockAgentRunAttemptOutcome<T>>();
    const markReady = () => {
      runOptions.onReady?.();
    };
    const attemptIndex = attempts.length;
    attempts.push({
      task: task as unknown as QueuedAgentRunTask<number>,
      retryAgentId,
      markReady,
      outcome: outcome as unknown as MockAgentRunAttemptRecord['outcome'],
    });

    const delay = options.readyDelay?.(attemptIndex);
    if (delay !== undefined) setTimeout(markReady, delay);

    return {
      agentId,
      profileName,
      completion: completionFromMockAgentRunOutcome(outcome, runOptions.signal),
    };
  };

  const launcher: AgentRunBatchLauncher = {
    spawn: async (spawnOptions) => {
      const task = findMockAgentRunTask(activeTasks, spawnOptions);
      return createHandle(
        spawnOptions,
        mockAgentRunId(task, attempts.length),
        spawnOptions.profileName,
      );
    },
    resume: async (agentId, runOptions) => createHandle(runOptions, agentId, 'subagent'),
    retry: async (agentId, runOptions) => createHandle(runOptions, agentId, 'subagent', agentId),
    suspended: (event) => {
      options.onSuspended?.(event);
    },
  };

  return {
    runBatch: <T,>(
      tasks: readonly QueuedAgentRunTask<T>[],
      runOptions?: { readonly signal?: AbortSignal },
    ) => {
      activeTasks = tasks.map((task) => ({
        ...task,
        signal: task.signal ?? runOptions?.signal,
      }));
      return new AgentRunBatch(launcher, activeTasks as readonly QueuedAgentRunTask<T>[], {
        maxConcurrency: options.maxConcurrency,
      }).run();
    },
    attempts,
  };
}

function findMockAgentRunTask<T>(
  tasks: readonly QueuedAgentRunTask<unknown>[],
  options: AgentRunAttemptOptions,
): QueuedAgentRunTask<T> {
  const task = tasks.find(
    (candidate) =>
      candidate.prompt === options.prompt &&
      candidate.parentToolCallId === options.parentToolCallId,
  );
  if (task === undefined) {
    throw new Error(`No mock queued task for prompt "${options.prompt}"`);
  }
  return task as QueuedAgentRunTask<T>;
}

function mockAgentRunId(task: QueuedAgentRunTask<unknown>, attemptIndex: number): string {
  if (typeof task.data === 'number') return `agent-${String(task.data)}`;
  return `agent-${String(attemptIndex + 1)}`;
}

function completionFromMockAgentRunOutcome<T>(
  outcome: ReturnType<typeof createControlledPromise<MockAgentRunAttemptOutcome<T>>>,
  signal: AbortSignal,
): AgentRunAttemptHandle['completion'] {
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(signal.reason ?? new Error('Aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    outcome.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        if (isMockAgentRunRateLimitOutcome(result)) {
          reject(new APIProviderRateLimitError('Rate limited', result.agentId));
          return;
        }
        if (result.status === 'completed') {
          resolve({ result: result.result ?? '', usage: result.usage });
          return;
        }
        reject(new Error(result.error ?? result.status));
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function isMockAgentRunRateLimitOutcome<T>(
  outcome: MockAgentRunAttemptOutcome<T>,
): outcome is Extract<MockAgentRunAttemptOutcome<T>, { readonly type: 'rate_limited' }> {
  return 'type' in outcome && outcome.type === 'rate_limited';
}

function queuedAgentRunTask(index: number): QueuedAgentRunTask<number> {
  return {
    kind: 'spawn',
    data: index,
    profileName: 'coder',
    parentToolCallId: 'call_swarm',
    prompt: `Review item-${String(index)}`,
    description: `Review #${String(index)}`,
    runInBackground: false,
  };
}
