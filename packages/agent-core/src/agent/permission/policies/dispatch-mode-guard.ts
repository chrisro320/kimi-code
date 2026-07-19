import type { Agent } from '../..';
import { isEditingCapableProfile } from '../../dispatch/profile';
import { DEFAULT_AGENT_PROFILES } from '../../../profile';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Fail-safe D3 gate for `ask`/`off` dispatch mode (see `DispatchModeState`).
 *
 * The runtime cannot reliably distinguish a model-initiated Agent/AgentSwarm
 * call from one the user explicitly asked for — that would require a
 * natural-language classifier, which D1 rules out. So instead of guessing:
 *   - `off` asks for confirmation on every Agent/AgentSwarm call (explicit or
 *     not) rather than silently approving or silently blocking it.
 *   - `ask` lets a single read-only `Agent` worker follow normal rules, and
 *     asks for confirmation for AgentSwarm or an editing-capable `Agent`
 *     dispatch, or when more than one `Agent` call appears in the same
 *     response.
 * `Agent(resume=...)` continues an already-approved worker, not a new
 * dispatch decision, so it is left out of this gate in both modes.
 */
export class DispatchModeGuardPermissionPolicy implements PermissionPolicy {
  readonly name = 'dispatch-mode-guard';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const toolName = context.toolCall.name;
    if (toolName !== 'Agent' && toolName !== 'AgentSwarm') return;

    // Real Agent instances always own DispatchModeState. Lightweight policy
    // harnesses and third-party Agent-shaped adapters may predate it; preserve
    // their historical auto behavior rather than crashing permission checks.
    const mode = this.agent.dispatchMode?.mode ?? 'auto';
    if (mode === 'auto') return;

    if (toolName === 'AgentSwarm') {
      return { kind: 'ask', reason: { dispatch_mode: mode, dispatch_gate: 'agent_swarm' } };
    }

    const args = context.args as Record<string, unknown> | undefined;
    const resumeId = typeof args?.['resume'] === 'string' ? args['resume'].trim() : '';
    if (resumeId.length > 0) return;

    if (mode === 'off') {
      return { kind: 'ask', reason: { dispatch_mode: 'off', dispatch_gate: 'agent' } };
    }

    const subagentType =
      typeof args?.['subagent_type'] === 'string' && args['subagent_type'].length > 0
        ? args['subagent_type']
        : 'coder';
    const agentCallCount = context.toolCalls.filter((call) => call.name === 'Agent').length;
    if (agentCallCount === 1 && !this.resolveIsEditingCapable(subagentType)) return;

    return {
      kind: 'ask',
      reason: { dispatch_mode: mode, dispatch_gate: 'agent', subagent_type: subagentType },
    };
  }

  private resolveIsEditingCapable(subagentType: string): boolean {
    const profile =
      DEFAULT_AGENT_PROFILES[this.agent.config.profileName ?? 'agent']?.subagents?.[subagentType] ??
      DEFAULT_AGENT_PROFILES['agent']?.subagents?.[subagentType];
    // Unknown profile: fail safe and require confirmation rather than assume read-only.
    if (profile === undefined) return true;
    return isEditingCapableProfile(profile);
  }
}
