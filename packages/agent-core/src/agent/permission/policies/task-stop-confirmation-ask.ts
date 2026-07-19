import type { Agent } from '../..';
import { isBackgroundTaskTerminal } from '../../background';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * A model-issued TaskStop is always destructive enough to require confirmation,
 * even in auto or yolo permission mode. Internal timeout, shutdown, and safety
 * paths call BackgroundManager directly and do not pass through this policy.
 */
export class TaskStopConfirmationAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'task-stop-confirmation-ask';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'TaskStop') return;

    const args = context.args as Record<string, unknown> | undefined;
    const taskId = typeof args?.['task_id'] === 'string' ? args['task_id'].trim() : '';
    const task = taskId.length > 0 ? this.agent.background.getTask(taskId) : undefined;
    if (task !== undefined && isBackgroundTaskTerminal(task.status)) return;

    return {
      kind: 'ask',
      reason: {
        destructive_cancellation: true,
        task_id: taskId.length > 0 ? taskId : null,
        task_status: task?.status ?? null,
        task_timeout_ms: task?.timeoutMs ?? null,
        task_elapsed_ms: task === undefined ? null : Math.max(0, Date.now() - task.startedAt),
      },
    };
  }
}
