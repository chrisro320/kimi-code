import { IAgentDispatchModeService } from '#/agent/dispatch/dispatch';
import { isEditingCapableCatalogProfile } from '#/agent/dispatch/profile';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { DEFAULT_PROFILE_NAME } from '#/agent/tools/agent/agent';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

export class DispatchModeGuardPermissionPolicyService implements PermissionPolicy {
  readonly name = 'dispatch-mode-guard';

  constructor(
    @IAgentDispatchModeService private readonly dispatchMode: IAgentDispatchModeService,
    @ISessionAgentProfileCatalog private readonly profiles: ISessionAgentProfileCatalog,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const toolName = context.toolCall.name;
    if (toolName !== 'Agent' && toolName !== 'AgentSwarm') return undefined;

    const mode = this.dispatchMode.mode;
    if (mode === 'auto') return undefined;

    const args = context.args as Record<string, unknown>;
    if (toolName === 'AgentSwarm') {
      const items = args['items'];
      const resumed = args['resume_agent_ids'];
      const hasNewItems = Array.isArray(items) && items.length > 0;
      const hasResumes =
        typeof resumed === 'object' &&
        resumed !== null &&
        !Array.isArray(resumed) &&
        Object.keys(resumed).length > 0;
      if (!hasNewItems && hasResumes) return undefined;
      return { kind: 'ask', reason: { dispatch_mode: mode, dispatch_gate: 'agent_swarm' } };
    }

    const resumeId = typeof args['resume'] === 'string' ? args['resume'].trim() : '';
    if (resumeId.length > 0) return undefined;

    if (mode === 'off') {
      return { kind: 'ask', reason: { dispatch_mode: mode, dispatch_gate: 'agent' } };
    }

    const subagentType =
      typeof args['subagent_type'] === 'string' && args['subagent_type'].length > 0
        ? args['subagent_type']
        : DEFAULT_PROFILE_NAME;
    const profile = this.profiles.get(subagentType);
    const agentCallCount = context.toolCalls.filter((call) => call.name === 'Agent').length;
    if (
      agentCallCount === 1 &&
      profile !== undefined &&
      !isEditingCapableCatalogProfile(profile)
    ) {
      return undefined;
    }

    return {
      kind: 'ask',
      reason: { dispatch_mode: mode, dispatch_gate: 'agent', subagent_type: subagentType },
    };
  }
}
