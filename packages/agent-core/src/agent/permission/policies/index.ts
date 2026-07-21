import type { Agent } from '../..';
import type { PermissionPolicy } from '../types';
import { AgentSwarmExclusiveDenyPermissionPolicy } from './agent-swarm-exclusive-deny';
import { AgoraConfirmationAskPermissionPolicy } from './agora-confirmation-ask';
import { AssetPipelineConfirmationAskPermissionPolicy } from './asset-pipeline-confirmation-ask';
import { ReferenceAuditOverrideAskPermissionPolicy } from './reference-audit-override-ask';
import { AutoModeApprovePermissionPolicy } from './auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicy } from './auto-mode-ask-user-question-deny';
import { DispatchModeGuardPermissionPolicy } from './dispatch-mode-guard';
import { DefaultToolApprovePermissionPolicy } from './default-tool-approve';
import { ExitPlanModeReviewAskPermissionPolicy } from './exit-plan-mode-review-ask';
import { FallbackAskPermissionPolicy } from './fallback-ask';
import {
  GitControlPathAccessAskPermissionPolicy,
  SensitiveFileAccessAskPermissionPolicy,
} from './file-access-ask';
import { GitCwdWriteApprovePermissionPolicy } from './git-cwd-write-approve';
import { GoalStartReviewAskPermissionPolicy } from './goal-start-review-ask';
import { PlanModeGuardDenyPermissionPolicy } from './plan-mode-guard-deny';
import { PlanModeToolApprovePermissionPolicy } from './plan-mode-tool-approve';
import { PreToolCallHookPermissionPolicy } from './pre-tool-call-hook';
import { SessionApprovalHistoryPermissionPolicy } from './session-approval-history';
import { SwarmModeAgentSwarmApprovePermissionPolicy } from './swarm-mode-agent-swarm-approve';
import { TaskStopConfirmationAskPermissionPolicy } from './task-stop-confirmation-ask';
import { TaskOutputResolutionAskPermissionPolicy } from './task-output-resolution-ask';
import {
  UserConfiguredAllowPermissionPolicy,
  UserConfiguredAskPermissionPolicy,
  UserConfiguredDenyPermissionPolicy,
} from './user-configured-rules';
import { YoloModeApprovePermissionPolicy } from './yolo-mode-approve';

/** Permission policies run in order; the first non-undefined result wins. */
export function createPermissionDecisionPolicies(agent: Agent): PermissionPolicy[] {
  return [
    // PreToolUse hook returned a block → deny.
    new PreToolCallHookPermissionPolicy(agent),
    // AgentSwarm is batch-exclusive and must run alone, regardless of permission mode.
    new AgentSwarmExclusiveDenyPermissionPolicy(),
    // Agora packet dispatch is a user-confirmed external fan-out; model args cannot authorize it.
    new AgoraConfirmationAskPermissionPolicy(agent),
    new ReferenceAuditOverrideAskPermissionPolicy(agent),
    // Asset side effects require a user-confirmed batch bound to an exact candidate snapshot.
    new AssetPipelineConfirmationAskPermissionPolicy(agent),
    // auto mode + AskUserQuestion → deny.
    new AutoModeAskUserQuestionDenyPermissionPolicy(agent),
    // dispatch mode ask/off: Agent/AgentSwarm needs confirmation (D3); auto mode is a no-op here.
    new DispatchModeGuardPermissionPolicy(agent),
    // plan mode: Write/Edit outside the plan file, or TaskStop → deny.
    new PlanModeGuardDenyPermissionPolicy(agent),
    // User-configured deny rule matches → deny.
    new UserConfiguredDenyPermissionPolicy(agent),
    // A model-issued TaskStop is destructive and must ask even in auto/yolo mode.
    // Internal timeout/shutdown/safety paths call BackgroundManager directly.
    new TaskStopConfirmationAskPermissionPolicy(agent),
    // TaskOutput resolution mutates workspace or durable task state and always asks.
    new TaskOutputResolutionAskPermissionPolicy(agent),
    // auto mode → approve (any auto-mode block must be a deny/ask rule above this).
    new AutoModeApprovePermissionPolicy(agent),
    // Approve-for-session memorized rule matches → approve. Runs before user-configured ask rules so an in-session grant beats a still-matching ask rule on later calls.
    new SessionApprovalHistoryPermissionPolicy(agent),
    // User-configured ask rule matches → ask.
    new UserConfiguredAskPermissionPolicy(agent),
    // User-configured allow rule matches → approve.
    new UserConfiguredAllowPermissionPolicy(agent),
    // ExitPlanMode with active plan_review + non-empty plan + non-auto → ask (tracks plan_submitted/plan_resolved itself). Runs before session history so a stale session approval can't bypass review of a new plan body.
    new ExitPlanModeReviewAskPermissionPolicy(agent),
    // CreateGoal (non-auto) → ask with the same start menu as /goal: choose the
    // permission mode to run the goal under, or decline. Applies the mode, then
    // lets the tool create the goal.
    new GoalStartReviewAskPermissionPolicy(agent),
    // EnterPlanMode, Write/Edit on the plan file, or ExitPlanMode with no actionable plan_review → approve.
    new PlanModeToolApprovePermissionPolicy(agent),
    // Access touches a sensitive file (.env, SSH key, credentials) → ask.
    new SensitiveFileAccessAskPermissionPolicy(),
    // Access touches .git or a git control-dir path → ask.
    new GitControlPathAccessAskPermissionPolicy(agent),
    // yolo mode → approve.
    new YoloModeApprovePermissionPolicy(agent),
    // Swarm mode keeps AgentSwarm available without making it a globally default-approved tool.
    new SwarmModeAgentSwarmApprovePermissionPolicy(agent),
    // Tool is in the default-approve list (read-only / UI helpers) → approve.
    new DefaultToolApprovePermissionPolicy(),
    // Write/Edit on POSIX paths inside cwd inside a git work tree → approve.
    new GitCwdWriteApprovePermissionPolicy(agent),
    // Nothing matched → ask.
    new FallbackAskPermissionPolicy(),
  ];
}
