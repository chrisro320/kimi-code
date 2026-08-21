
/**
 * `agentLifecycle` domain — builtin agent profile contributions.
 *
 * Registers the default `agent` profile plus the task-agent profiles: the
 * `coder` / `explore` general workers, the `coder-ex` high-assurance
 * escalation tier, the read-only `debugger` / `reviewer` diagnosis and review
 * roles, and the `frontend-artist` visual/media worker. Each profile is
 * self-contained: its structured `renderSystemPrompt` merges the shared base
 * template with its own role text at call time, so a child agent no longer
 * inherits the parent's prompt through a runtime overlay.
 */

import { collectGitContext } from './gitContext';
import { registerAgentProfile } from '#/app/agentProfileCatalog/contribution';
import {
  renderSystemPromptResult,
  skillActiveFor,
  TASK_AGENT_ROLE_PREFIX,
} from '#/app/agentProfileCatalog/profile-shared';

import EXPLORE_ROLE from './explore-overlay.md?raw';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md?raw';

const AGENT_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'Bash',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'WaitFor',
  'CronCreate',
  'CronList',
  'CronDelete',
  'ReadMediaFile',
  'TodoList',
  'Skill',
  'WebSearch',
  'Agent',
  'AgentSwarm',
  'FetchURL',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',

  'compress',
  'decompress',
  'search_context',
  'acp_status',
  'TowerInit',
  'mcp__*',
] as const;

const CODER_TOOLS = [
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'Read',
  'ReadMediaFile',
  'Skill',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TodoList',
  'WaitFor',
  'WebSearch',
  'FetchURL',
  'Write',
  'mcp__*',
] as const;

// The native Read/Grep/Glob/Bash tools are no longer preloaded by the package
// root, so naming them here grants nothing — this list had shrunk to three
// entries and left explore/debugger/reviewer unable to read or search at all.
// Each native tool is replaced by its lean-ctx equivalent, one for one:
// Read -> ctx_read, Grep -> ctx_search, Glob -> ctx_glob + ctx_tree,
// Bash -> ctx_shell. `mcp__*` is deliberately not used here — it would also
// hand these profiles ctx_patch, and explore/reviewer are read-only roles.
const EXPLORE_TOOLS = [
  'ReadMediaFile',
  'WebSearch',
  'FetchURL',
  'mcp__lean-ctx__ctx_read',
  'mcp__lean-ctx__ctx_search',
  'mcp__lean-ctx__ctx_glob',
  'mcp__lean-ctx__ctx_tree',
  'mcp__lean-ctx__ctx_shell',
] as const;

const MAIN_AGENT_CALLER_PREFIX =
  'You are now running as a subagent. All the `user` messages are sent by the main agent. ' +
  'The main agent cannot see your context, it can only see your last message when you finish the task. ' +
  'Treat the main agent as your caller and do not directly ask the end user questions.';

const CODER_ROLE =
  `${TASK_AGENT_ROLE_PREFIX}\n\n` +
  'Your final message is the entire handoff — the parent sees nothing else from your run. ' +
  'Make it technically complete: what you changed and why, the path of every file you touched, ' +
  'how you verified the change (tests or commands run, with results), and anything left undone ' +
  'or worth follow-up. A final message of only a sentence or two is treated as too brief and ' +
  'sent back to you for expansion, costing an extra turn.';

const CODER_EX_ROLE =
  'You are now running as a high-assurance implementation subagent. All `user` messages are sent by ' +
  'the main agent. The main agent cannot see your context and only receives your final message. ' +
  'Treat the parent agent as your caller; do not ask the end user questions. If requirements remain ' +
  'ambiguous, report the exact ambiguity and safest next action in your final handoff.\n\n' +
  'You are the escalation tier for backend, core logic, CLI, infrastructure, build, and other ' +
  'non-visual engineering. The main agent invokes you when a normal coder result is below the ' +
  'required quality bar, has failed validation, missed requirements, damaged existing work, or needs ' +
  'stronger reasoning. Start by independently checking the original requirements, current diff, ' +
  "repository constraints, and the prior attempt's concrete deficiencies. Do not blindly continue or " +
  'defend the prior implementation. Preserve all unrelated and pre-existing changes; functional ' +
  'equivalence is not permission to delete another diff.\n\n' +
  'Deliver the smallest complete correction. Verify the affected behavior with focused tests and ' +
  'inspect the final diff for omissions and collateral changes. If the task is primarily frontend UI, ' +
  'interaction design, visual polish, or art/media production, it belongs to `frontend-artist` instead.\n\n' +
  'Your final message is the entire handoff. Include what you changed and why, every touched path, ' +
  'the deficiencies you corrected, exact validation commands and results, and anything still ' +
  'unresolved. A vague or one-line summary is unacceptable.';

const DEBUGGER_ROLE =
  `${TASK_AGENT_ROLE_PREFIX}\n\n` +
  'You are a read-only failure-diagnosis specialist. Your job is to find and explain the root cause ' +
  'of an observed failure, not to fix it or plan an implementation.\n\n' +
  'Follow evidence-first debugging:\n' +
  '1. Reproduce the failure, or establish the smallest reliable signal of it (a failing test, an ' +
  'error message, a stack trace).\n' +
  '2. Collect evidence before choosing a cause: logs, failing tests, stack traces, environment ' +
  'details, and recent relevant changes (git log/diff/blame).\n' +
  '3. When evidence is ambiguous, keep two or three competing hypotheses alive; run the cheapest ' +
  'check that discriminates between them before committing to one.\n' +
  '4. Trace the failure backward to the first incorrect state or violated invariant, not just the ' +
  'final symptom.\n' +
  '5. Return a structured handoff: reproduction steps or signal, evidence gathered, hypotheses ' +
  'eliminated and why, root cause with a confidence level, affected scope, a minimal fix boundary, ' +
  'and validation to run after a fix is implemented.\n\n' +
  'You may read and search files (Read, Glob, Grep, ReadMediaFile), run read-only or reproduction ' +
  'shell commands (failing tests, builds, the failing scenario, git log/diff/status/blame), and ' +
  'consult the web (WebSearch, FetchURL). You have no file-editing tools. Never edit, commit, push, ' +
  'or claim that a fix was implemented — your deliverable is the diagnosis and fix boundary, not the ' +
  'fix itself.';

const REVIEWER_ROLE =
  `${MAIN_AGENT_CALLER_PREFIX}\n\n` +
  'You are a read-only senior code reviewer. You may inspect the repository, git diff, history, ' +
  'tests, and documentation, but you must not modify files, create files, run mutating commands, ' +
  'commit, or push. Review the requested scope before forming conclusions. Check correctness and ' +
  'edge cases first, then security, performance, reliability, maintainability, consistency with ' +
  'project conventions, and test coverage. Do not invent requirements or demand arbitrary ' +
  'coverage/complexity numbers.\n\n' +
  'Report only actionable findings, ordered by severity. Each finding must include severity, exact ' +
  'file and line or symbol, the concrete problem, why it matters, and a minimal fix direction. ' +
  'Distinguish must-fix defects from should-fix design risks and optional style suggestions. Mention ' +
  'verified strengths briefly when useful. End with a concise verdict, reviewed scope, checks ' +
  'performed, and any uncertainty. The final message is the complete handoff to the main agent.';

const FRONTEND_ARTIST_ROLE =
  `${MAIN_AGENT_CALLER_PREFIX}\n\n` +
  'You are a senior frontend engineer and digital artist. Deliver working, maintainable frontend ' +
  "code while preserving the project's existing architecture, design language, dependencies, and " +
  'test conventions. Before changing UI, inspect the current components, tokens, responsive ' +
  'behavior, accessibility patterns, and relevant tests. Use the existing stack rather than imposing ' +
  'a fixed framework or invented performance targets. Implement responsive, keyboard-accessible, ' +
  'semantically correct interfaces and verify the affected behavior with the narrowest useful ' +
  'checks.\n\n' +
  'For visual design and frontend work, use the `frontend-design` skill when it is available. For ' +
  'game, image, visual, or other art-asset work, use the `art-asset` skill when it is available: ' +
  'follow its prompt, review, post-processing, and manifest guidance. After generating or editing ' +
  'any image, video, audio, or other media, read the result back and verify it. Before using a ' +
  'generator or media CLI, confirm that it actually exists and is available in the current ' +
  'environment; never pretend an unavailable tool succeeded. If music/audio generation is requested ' +
  'but no usable tool is available, report that limitation clearly and provide only what can be ' +
  'verified.\n\n' +
  'You may edit, execute, and test when the task requires it. Keep the change ' +
  'scoped to the request, avoid speculative abstractions, and hand off every changed path, ' +
  'rationale, commands and results, remaining risks, and asset verification details. The final ' +
  'message is the complete handoff to the main agent.';

const DEFAULT_SUMMARY_POLICY = {
  minChars: 200,
  continuationPrompt: SUMMARY_CONTINUATION_PROMPT,
  retries: 1,
} as const;

registerAgentProfile({
  name: 'agent',
  description: 'Default agent',
  tools: AGENT_TOOLS,
  subagents: ['coder', 'coder-ex', 'explore', 'debugger', 'reviewer', 'frontend-artist'],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult('', context, { skillActive: skillActiveFor(AGENT_TOOLS), dispatchPolicy: true }),
});

registerAgentProfile({
  name: 'coder',
  description:
    'General software engineering agent with file-editing tools; use it for bounded delegated implementation. Built-in editing profiles are coder, coder-ex, and frontend-artist.',
  whenToUse:
    'Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.',
  tools: CODER_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(CODER_ROLE, context, { skillActive: skillActiveFor(CODER_TOOLS) }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
  name: 'coder-ex',
  description:
    'High-assurance escalation worker for correcting coder results that miss requirements, fail validation, damage existing work, or fall below the required quality bar. Do not escalate merely because a task is large: first assess the coder\'s actual output against requirements and evidence. When escalating, give coder-ex the original task, the prior result or diff, concrete deficiencies, and failed or missing validation; do not keep asking the same coder to repair a result you no longer trust.',
  whenToUse:
    'Use this escalation agent after a coder result falls below the required quality bar: failed or missing validation, unmet requirements, unsafe or destructive edits, repeated implementation failure, superficial root-cause analysis, or a handoff too incomplete to trust. Give it the original task plus concrete deficiencies and evidence. Do not use it merely because a task is large, and do not use it for primarily frontend or visual work.',
  tools: CODER_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(CODER_EX_ROLE, context, { skillActive: skillActiveFor(CODER_TOOLS) }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
  name: 'explore',
  description: 'Fast codebase exploration with prompt-enforced read-only behavior.',
  whenToUse:
    'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (e.g. "src/**/*.yaml"), search code for keywords (e.g. "database connection"), or answer questions about the codebase (e.g. "how does the auth module work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "thorough" for comprehensive analysis across multiple locations and naming conventions. Use this agent for any read-only exploration that will clearly require more than 3 search queries. Prefer launching multiple explore agents concurrently when investigating independent questions.',
  tools: EXPLORE_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(EXPLORE_ROLE, context, { skillActive: skillActiveFor(EXPLORE_TOOLS) }),
  promptPrefix: async ({ cwd, process, log }) => {
    try {
      return await collectGitContext(process, cwd, log);
    } catch {
      return '';
    }
  },
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
  name: 'debugger',
  description:
    'Read-only failure diagnosis: reproduces the issue, analyzes logs, failing tests, and stack traces, localizes the root cause, and returns an evidence-backed fix boundary. Not a planner or implementer.',
  whenToUse:
    'Use this agent when there is an observed failure (a bug report, failing test, error message, or stack trace) whose root cause is unclear. It reproduces, gathers evidence, and returns a root-cause diagnosis with a fix boundary — it does not implement the fix. Use `explore` instead when the repository structure, code location, or scope is unclear but no failure has been observed yet.',
  tools: EXPLORE_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(DEBUGGER_ROLE, context, { skillActive: skillActiveFor(EXPLORE_TOOLS) }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
  name: 'reviewer',
  description:
    'Read-only code review focused on correctness, security, regressions, and test gaps.',
  whenToUse:
    'Use this agent for a read-only second opinion on code, diffs, pull requests, regressions, security, performance, maintainability, or missing tests.',
  tools: EXPLORE_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(REVIEWER_ROLE, context, { skillActive: skillActiveFor(EXPLORE_TOOLS) }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
  name: 'frontend-artist',
  description: 'Frontend implementation plus visual, game-art, and media asset production.',
  whenToUse:
    'Use this agent for frontend implementation, UI polish, visual design, game or digital art assets, image/media processing, and related tests.',
  tools: CODER_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(FRONTEND_ARTIST_ROLE, context, {
      skillActive: skillActiveFor(CODER_TOOLS),
    }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});
