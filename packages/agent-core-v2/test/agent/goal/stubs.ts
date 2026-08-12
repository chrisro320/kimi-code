/**
 * Shared stubs for goal tests.
 */

import type { IAgentSwarmService } from '#/agent/swarm/swarm';
import type { IAgentTaskService } from '#/agent/task/task';
import { TERMINAL_STATUSES, type AgentTaskInfo, type AgentTaskStatus } from '#/agent/task/types';

export function stubAgentSwarm(): IAgentSwarmService {
  return {
    _serviceBrand: undefined,
    isActive: false,
    enter: () => undefined,
    exit: () => undefined,
  };
}

export interface StubAgentTasks extends IAgentTaskService {
  start(taskId: string): void;
  setStatus(taskId: string, status: AgentTaskStatus): void;
  forget(taskId: string): void;
}

export function stubAgentTasks(): StubAgentTasks {
  const statuses = new Map<string, AgentTaskStatus>();
  const info = (taskId: string, status: AgentTaskStatus): AgentTaskInfo =>
    ({
      taskId,
      description: taskId,
      status,
      startedAt: 0,
      endedAt: TERMINAL_STATUSES.has(status) ? 1 : null,
    }) as unknown as AgentTaskInfo;
  return {
    _serviceBrand: undefined,
    list: (activeOnly = true): readonly AgentTaskInfo[] =>
      [...statuses]
        .filter(([, status]) => !activeOnly || !TERMINAL_STATUSES.has(status))
        .map(([taskId, status]) => info(taskId, status)),
    getTask: (taskId: string): AgentTaskInfo | undefined => {
      const status = statuses.get(taskId);
      return status === undefined ? undefined : info(taskId, status);
    },
    start: (taskId: string) => {
      statuses.set(taskId, 'running');
    },
    setStatus: (taskId: string, status: AgentTaskStatus) => {
      statuses.set(taskId, status);
    },
    forget: (taskId: string) => {
      statuses.delete(taskId);
    },
  } as unknown as StubAgentTasks;
}
