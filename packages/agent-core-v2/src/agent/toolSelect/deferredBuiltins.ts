/**
 * Builtin tools kept out of the top-level tools[] under progressive disclosure
 * (`tool-select`). Same load-on-demand path as MCP tools: announced via
 * `<tools_added>`, loaded by exact name through `select_tools`.
 *
 * Conservative low-frequency set — core file/shell tools, Agent/AgentSwarm,
 * Task*, AskUserQuestion, and Skill stay top-level. Every name here belongs to
 * a tool this engine registers; a name with no registration behind it is dead
 * weight that reads like a plan.
 */

export const DEFERRED_BUILTIN_TOOL_NAMES = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'CreateGoal',
  'SetGoalBudget',
  'UpdateGoal',
  'GetGoal',
  'EnterPlanMode',
  'ExitPlanMode',
] as const;

export type DeferredBuiltinToolName = (typeof DEFERRED_BUILTIN_TOOL_NAMES)[number];

const DEFERRED_BUILTIN_TOOL_NAME_SET: ReadonlySet<string> = new Set(DEFERRED_BUILTIN_TOOL_NAMES);

export function isDeferredBuiltinToolName(name: string): boolean {
  return DEFERRED_BUILTIN_TOOL_NAME_SET.has(name);
}
