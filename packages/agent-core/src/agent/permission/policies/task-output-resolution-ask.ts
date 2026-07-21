import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

const RESOLUTION_ACTIONS = new Set([
  'approve_scope_expansion',
  'deny_scope_expansion',
]);

/**
 * Scope-expansion resolution mutates either the workspace or durable task
 * state, so a model-issued action always requires explicit confirmation.
 * The manager revalidates the hash and exact scope after approval.
 */
export class TaskOutputResolutionAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'task-output-resolution-ask';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'TaskOutput') return;

    const args = context.args as Record<string, unknown> | undefined;
    const action = typeof args?.['action'] === 'string' ? args['action'] : '';
    if (!RESOLUTION_ACTIONS.has(action)) return;

    const taskId = typeof args?.['task_id'] === 'string' ? args['task_id'].trim() : '';
    const candidateHash =
      typeof args?.['candidate_hash'] === 'string' ? args['candidate_hash'].trim() : '';
    const requestedScope = Array.isArray(args?.['requested_scope'])
      ? args['requested_scope'].filter((entry): entry is string => typeof entry === 'string')
      : [];
    const task = taskId.length > 0 ? this.agent.background.getTask(taskId) : undefined;

    return {
      kind: 'ask',
      reason: {
        scope_expansion_resolution: true,
        action,
        task_id: taskId.length > 0 ? taskId : null,
        task_status: task?.status ?? null,
        candidate_hash: candidateHash.length > 0 ? candidateHash : null,
        requested_scope: requestedScope.length > 0 ? requestedScope.join(',') : null,
      },
    };
  }
}
