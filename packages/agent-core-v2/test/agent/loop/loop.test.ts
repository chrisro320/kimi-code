import { type ToolCall } from '#/kosong/contract/message';
import { emptyUsage } from '#/kosong/contract/usage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import { IAgentProfileService } from '#/index';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import type { ModelRequestTiming } from '#/kosong/model/modelRequester';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { ContinuationStepRequest, MessageStepRequest } from '#/agent/loop/stepRequest';
import { RetryStepRequest } from '#/agent/prompt/promptStepRequests';
import type { ExecutableTool } from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IEventBus } from '#/app/event/eventBus';
import { userCancellationReason } from '#/_base/utils/abort';

import {
  agentService,
  createTestAgent,
  permissionModeServices,
  type TestAgentContext,
  type TestAgentOptions,
} from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

type GenerateFn = NonNullable<TestAgentOptions['generate']>;

describe('Agent loop', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;
  let profile: IAgentProfileService;

  beforeEach(() => {
    ctx = createTestAgent();
    loop = ctx.get(IAgentLoopService);
    profile = ctx.get(IAgentProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('resolves the loop service from the agent scope by interface', () => {
    expect(loop).toBeDefined();
  });

  it('runs a text-only agent turn from prompt to completion', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse({ type: 'think', think: '<think-1>' }, { type: 'text', text: '<text-1>' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] tools.set_active_tools      { "names": [], "time": "<time>" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" }, "prompt": "Hello" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.spliced             { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" } ] }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot          { "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] thinking.delta              { "turnId": 0, "delta": "<think-1>" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "thinking", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] assistant.delta             { "turnId": 0, "delta": "<text-1>" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] agent.status.updated        { "contextTokens": 11 }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "think", "think": "<think-1>" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "<text-1>" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
      [wire] turn.ended                  { "turnId": 0, "reason": "completed", "time": "<time>" }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: []
    messages:
      user: text "Hello"
  `);
  });

  it('persists a turn.ended wire record with the end reason and duration', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    const record = (await ctx.persistedWireRecords()).find((entry) => entry.type === 'turn.ended');
    expect(record).toMatchObject({ turnId: 0, reason: 'completed' });
    expect(record?.['durationMs']).toEqual(expect.any(Number));
    expect(record?.['time']).toEqual(expect.any(Number));
  });

  it('fails the turn after a filtered step completes', async () => {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'blocked' }],
      finishReason: 'filtered',
    });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" }, "prompt": "Hello" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.spliced             { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" } ] }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot          { "hash": "cb20f27a3d963106c385d7602a67f0ea5f6ccdb686d06459206d591755c5838d", "tools": [ { "name": "Agent", "description": "Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file. Delegating keeps the bulk of intermediate file contents out of your own context — you get a conclusion back, not a pile of dumps.\\n\\nWriting the prompt:\\n- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked in: state the goal, list what you know, hand over specifics.\\n- Lookups (read this file, run that test): put the exact path or command in the prompt; don't make the subagent search for what you already know.\\n- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.\\n- Do not delegate understanding: if the task hinges on a file path or line number, find it yourself first and write it into the prompt.\\n\\nUsage notes:\\n- To continue a subagent's earlier work, resume it (pass its \`resume\` id) rather than spawning fresh — the resumed agent keeps its prior context.\\n- A subagent's result is only visible to you, not the user; summarize the relevant parts in your own reply.\\n- Subagents have a fixed 2-hour timeout; on timeout, resume the same agent.\\n\\nWhen NOT to use Agent: skip delegation for trivial work — reading a known path, searching a small known set, or one- to two-step tasks. Delegation has a context-handoff cost; it pays off only on substantial tasks.\\n\\nOnce a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway to finish manually — both undo the context savings.\\n\\n\\nWhen \`run_in_background=true\`, the subagent runs detached from this turn; completion arrives in a later turn as a synthetic user-role message with its result — no polling, sleeping, or progress checks needed. Continue with other work or respond to the user. Never fabricate or predict the result.\\n\\nDefault to a foreground subagent (omit \`run_in_background\`) when your next step needs its result. Use \`run_in_background=true\` only when you have other work meanwhile and don't need the result to proceed. Never launch in the background and then immediately wait on it (\`TaskOutput block=true\`, sleeping, or otherwise) — that blocks the turn for no benefit; run it in the foreground instead.\\n\\n\\nAvailable agent types (pass via subagent_type):\\n- plan: Read-only implementation planning and architecture design. Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.\\n  Tools: Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL\\n- agent: Default Kimi Code agent\\n  Tools: Read, Write, Edit, Grep, Glob, Bash, TaskList, TaskOutput, TaskStop, CronCreate, CronList, CronDelete, ReadMediaFile, TodoList, Skill, WebSearch, Agent, AgentSwarm, FetchURL, AskUserQuestion, EnterPlanMode, ExitPlanMode, CreateGoal, GetGoal, SetGoalBudget, UpdateGoal, mcp__*\\n- coder: General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code. Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.\\n  Tools: Agent, AgentSwarm, Bash, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, Glob, Grep, Read, ReadMediaFile, Skill, TaskList, TaskOutput, TaskStop, TodoList, WebSearch, FetchURL, Write, mcp__*\\n- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (e.g. \\"src/**/*.yaml\\"), search code for keywords (e.g. \\"database connection\\"), or answer questions about the codebase (e.g. \\"how does the auth module work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"thorough\\" for comprehensive analysis across multiple locations and naming conventions. Use this agent for any read-only exploration that will clearly require more than 3 search queries. Prefer launching multiple explore agents concurrently when investigating independent questions.\\n  Tools: Bash, Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "subagent_type": { "description": "One of the available agent types (see \\"Available agent types\\" in this tool description). Defaults to \\"coder\\" when omitted.", "type": "string" }, "resume": { "description": "Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.", "type": "string" }, "run_in_background": { "description": "If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.", "type": "boolean" } }, "required": [ "prompt", "description" ], "additionalProperties": false } }, { "name": "AgentSwarm", "description": "Launch multiple subagents from one prompt template, existing agent resumes, or both.\\n\\nUse AgentSwarm when many subagents run the same kind of task over different inputs. The placeholder is exactly \`{{item}}\`: \`prompt_template\` \`Review {{item}} for likely regressions.\` with \`items\` \`[\\"src/a.ts\\", \\"src/b.ts\\"]\` launches two subagents with those concrete prompts. For a few differently-shaped tasks, make separate \`Agent\` calls in one message instead.\\n\\n\`resume_agent_ids\` continues existing subagents (e.g. failed or timed out): map each agent id to its resume prompt (usually \`continue\`). You may combine \`resume_agent_ids\` with \`items\`; do not duplicate resumed work in \`items\`.\\n\\nEnforced — violations are rejected before any subagent starts: at least 2 \`items\` unless \`resume_agent_ids\` is passed; \`items\` requires \`prompt_template\` containing \`{{item}}\`; the filled-in prompts must be distinct.\\n\\nUse enough subagents to keep work focused and parallel — up to 128 subagents, queued automatically; safe to split large tasks into many clear, independent items.\\n\\nIf \`AgentSwarm\` is called, that call must be the only tool call in the response.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "description": { "type": "string", "minLength": 1, "description": "Short description for the whole swarm." }, "subagent_type": { "description": "Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.", "type": "string", "minLength": 1 }, "prompt_template": { "description": "Prompt template for each subagent. The {{item}} placeholder is replaced with each item value.", "type": "string", "minLength": 1 }, "items": { "description": "Values used to fill {{item}}. Each item launches one new subagent.", "maxItems": 128, "type": "array", "items": { "type": "string", "minLength": 1 } }, "resume_agent_ids": { "description": "Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.", "type": "object", "propertyNames": { "type": "string", "minLength": 1 }, "additionalProperties": { "type": "string", "minLength": 1 } } }, "required": [ "description" ], "additionalProperties": false } }, { "name": "AskUserQuestion", "description": "Use this tool to ask the user questions with structured options during execution: collect preferences or requirements, resolve ambiguous or underspecified instructions, let the user decide between implementation approaches, or present concrete options when multiple valid directions exist.\\n\\n**When NOT to use:**\\n- When you can infer the answer from context — be decisive and proceed\\n- Trivial decisions that don't materially affect the outcome\\n\\nOverusing this tool interrupts the user's flow — use it only when the user's input genuinely changes your next action.\\n\\n**Usage notes:**\\n- Users always have an \\"Other\\" option for custom input — don't create one yourself\\n- Use multi_select to allow multiple answers to be selected for a question\\n- Keep option labels concise (1-5 words); use descriptions for trade-offs and details\\n- Each question gets 2-4 meaningful, distinct options\\n- Question texts must be unique across the call, and option labels unique within each question\\n- Ask 1-4 questions at a time; group related questions to minimize interruptions\\n- If you recommend an option, list it first and append \\"(Recommended)\\" to its label\\n- The result is JSON: an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated for multi_select, or the user's own words for \\"Other\\"). If \`answers\` is empty and a \`note\` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question\\n- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately. The answer arrives automatically in a later turn — you do not need to poll, sleep, or check on it. Continue with other work; never fabricate or predict the answer.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "default": false, "description": "Whether the user can select multiple options.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." }, "background": { "default": false, "description": "Set true to ask in the background and return immediately with a background task_id; you are notified automatically when the user answers — do not poll with TaskOutput while the question is pending.", "type": "boolean" } }, "required": [ "questions" ], "additionalProperties": false } }, { "name": "Bash", "description": "Execute a \`bash\` command. Use for shell semantics — pipes, env, processes, git, package managers, build/test runners, interactive or multi-step work.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine)\\n- \`grep\` / \`rg\` (file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → output text directly\\n\\nDedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation — prefer them whenever one fits.\\n\\n**Output:**\\nstdout and stderr are combined and returned as a string; may be truncated if long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nIf \`run_in_background=true\`, the command is started as a background task and this tool returns a task ID instead of waiting for completion; you must provide a short \`description\`. Background commands default to a 600s timeout and \`timeout\` is capped at 86400s; set \`disable_timeout=true\` only when the task should run without a timeout. You will be automatically notified when the task completes — default to returning control to the user instead of immediately waiting on it. Use \`TaskOutput\` only for a non-blocking status/output snapshot — do not set \`block=true\` to wait for a task you just launched, since its completion arrives automatically; reserve \`block=true\` for when the user explicitly asked you to wait. Use \`TaskStop\` only if the task must be cancelled. If a human user wants to inspect background tasks themselves, point them to the \`/tasks\` command, which opens an interactive panel; it has no subcommands.\\n\\n**Guidelines for safety and security:**\\n- Fresh shell each call — vars, cwd, and history are not preserved. Use the \`cwd\` arg or absolute paths; do not rely on a prior \`cd\`.\\n- The tool call returns when the command finishes. Do not run interactive or forever-running commands. For possibly long-running foreground commands, set the \`timeout\` argument in seconds. Foreground commands default to 60s and allow up to 300s. When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.\\n- Avoid \`..\` to reach outside the working directory.\\n- Avoid modifying files outside the working directory unless explicitly instructed.\\n- Never run superuser commands unless explicitly instructed.\\n\\n**Guidelines for efficiency:**\\n- \`&&\` only for genuinely dependent chains (e.g. \`npm install && npm test\`). Independent read-only commands → separate parallel Bash calls in one response, not one chained call (serializes execution and mixes output). Do not stitch outputs with \`echo\` separators.\\n- \`;\` — sequential regardless of success/failure\\n- \`||\` — run second only if first fails\\n- \`|\` and \`>\` / \`>>\` — pipe and redirect between commands\\n- Always quote paths with spaces in double quotes (e.g. \`cd \\"/path with spaces/\\"\`)\\n- Multi-step logic in one call: \`if\` / \`case\` / \`for\` / \`while\`.\\n- Prefer \`run_in_background=true\` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.\\n\\n**Commands available:**\\nUsually available (host-dependent — \`which <command>\` when unsure):\\n- Nav/inspect: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- Files: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Net: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- VCS: \`git\`; GitHub PRs/issues/CI/API → prefer \`gh\` when installed (user auth + structured JSON)\\n- Process: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use what the project relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } }, { "name": "CreateGoal", "description": "Create a durable, structured goal that the runtime will pursue across multiple turns.\\n\\nCall \`CreateGoal\` only when the user explicitly asks you to start a goal or work autonomously toward an outcome, or a host goal-intake prompt asks you to create one.\\n\\nDo NOT create a goal for greetings, ordinary questions, or vague requests that lack a verifiable completion condition — a goal needs a checkable end state. When the request is vague, ask the user for the missing completion criterion first; if the user clearly insists after you warn that the wording is vague or risky, respect that and create the goal.\\n\\nInclude a \`completionCriterion\` when the user provides one, or when it can be stated without inventing new requirements. Keep \`objective\` concise; reference long task descriptions by file path rather than pasting them.\\n\\nCreating a goal fails if one already exists — use \`replace: true\` only when the user explicitly wants to abandon the current goal and start a new one.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" } }, "required": [ "objective" ], "additionalProperties": false } }, { "name": "Edit", "description": "Perform exact replacements in existing files.\\n\\n- Edit is mandatory for every incremental change, even small ones — DO NOT use Write or Bash \`sed\`.\\n- Read the target file before every Edit. DO NOT call Edit from memory, stale context, or a guessed \`old_string\`.\\n- Take \`old_string\` and \`new_string\` from the Read output view: drop the line-number prefix and tab; match only file content.\\n- \`old_string\` must be unique unless \`replace_all\` is set. If ambiguous, add surrounding context. Use \`replace_all\` only when every occurrence should change — for example, renaming a symbol throughout the file.\\n- Multiple Edit calls in one response only when they do not target the same file. DO NOT issue consecutive Edit calls on the same file — a previous Edit can invalidate a later \`old_string\` (\`old_string not found\`); Read the file again first. A write lock serializes same-file edits in response order, but serialization does not make stale \`old_string\` valid.\\n- Pure CRLF files: Read shows LF — use LF in \`old_string\` and \`new_string\`; Edit writes CRLF back. Mixed endings or lone carriage returns: Read shows \`\\\\r\` — include actual \`\\\\r\` escapes in those positions.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false } }, { "name": "EnterPlanMode", "description": "Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off via ExitPlanMode before writing code prevents wasted effort.\\n\\nUse it when ANY of these conditions apply:\\n\\n1. New Feature Implementation - e.g. \\"Add a caching layer to the API\\"\\n2. Multiple Valid Approaches - e.g. \\"Optimize database queries\\" (indexing vs rewrite vs caching)\\n3. Code Modifications - e.g. \\"Refactor auth module to support OAuth\\"\\n4. Architectural Decisions - e.g. \\"Add WebSocket support\\"\\n5. Multi-File Changes - more than 2-3 files\\n6. Unclear Requirements - need exploration to understand scope\\n7. User Preferences Matter - user input would materially change the implementation approach\\n\\nPermission mode notes:\\n- EnterPlanMode enters plan mode automatically without an approval prompt in all permission modes.\\n- Use it only when planning itself adds value (see ExitPlanMode's description for the full approval-flow-by-mode rules).\\n\\nWhen NOT to use:\\n- Single-line or few-line fixes (typos, obvious bugs, small tweaks)\\n- User gave very specific, detailed instructions\\n- Pure research/exploration tasks\\n\\nOnce in plan mode, a reminder walks you through the workflow (explore → design → write the plan file → \`ExitPlanMode\`) and enforces read-only access. For non-trivial tasks with unclear codebase structure or code paths, use \`Agent(subagent_type=\\"explore\\")\` to investigate first when the \`Agent\` tool is available.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "_unused": { "type": "string" } }, "additionalProperties": false } }, { "name": "ExitPlanMode", "description": "Use this tool when you are in plan mode, have finished writing your plan to the plan file, and are ready for user approval.\\n\\n## How This Tool Works\\n- The plan must already be written to the plan file specified in the plan mode reminder.\\n- This tool does NOT take the plan content as a parameter — it reads the plan from the file.\\n- The user sees the plan file contents when reviewing. In auto permission mode, the tool reads the file and exits plan mode without asking.\\n\\n## When to Use\\nOnly for tasks that require planning implementation steps. For research tasks (searching files, reading code, understanding the codebase), do NOT use this tool.\\n\\n## What a good plan contains\\nSpecific, verifiable steps grounded in the actual codebase — real files, functions, and commands, in a sensible order; each concrete enough to act on and to check. Avoid vague filler like \\"improve performance\\" or \\"add tests\\" — say what to change and where.\\n\\n## Multiple Approaches\\nIf your plan offers alternatives, pass them via the \`options\` parameter so the user can choose which to execute — see the \`options\` parameter for format, count, and reserved labels. In yolo and manual modes the user sees all options alongside the host's Reject and Revise controls.\\n\\n## Before Using\\n- Auto permission mode: do NOT use AskUserQuestion — make the best decision from available context; this tool then exits plan mode without asking. In yolo and manual modes it still presents the plan for approval.\\n- Non-auto mode with unresolved questions, or multiple approaches not yet narrowed down: use AskUserQuestion first, then write the plan (for the chosen approach only).\\n- Do NOT use AskUserQuestion to ask \\"Is this plan OK?\\" or \\"Should I proceed?\\" — that is exactly what this tool does.\\n- If rejected, revise based on feedback and call ExitPlanMode again.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "FetchURL", "description": "Fetch content from a URL. The content is returned either as the main text extracted from the page, or as the full response body verbatim; a note at the top of the result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.\\n\\nOnly fully-formed public \`http\`/\`https\` URLs are supported; other schemes and private or loopback addresses are not fetched. Very large pages may be truncated or refused. The fetch carries no login or session for the target site, so pages behind authentication (private repositories, internal dashboards) return a login page or an error instead of the real content — if the text you get back looks like a generic landing or sign-in page, treat that as the login wall, not the answer, and reach the content through a credentialed route (an authenticated CLI or MCP tool) instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "url": { "type": "string", "description": "The URL to fetch content from." } }, "required": [ "url" ], "additionalProperties": false } }, { "name": "GetGoal", "description": "Read the current goal: its objective, completion criterion, status, and budgets (turns, tokens,\\ntime, and how much of each remains). When the goal has stopped, it also reports the terminal reason.\\n\\nUse \`GetGoal\` before deciding whether to continue working, report completion, report a blocker,\\nor respect a pause. It returns \`{ \\"goal\\": null }\` when there is no current goal.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "_unused": { "type": "string" } }, "additionalProperties": false } }, { "name": "Glob", "description": "Find files by glob pattern, sorted by modification time (most recent first).\\n\\nPowered by ripgrep. Respects \`.gitignore\`, \`.ignore\`, and \`.rgignore\` by default — set \`include_ignored\` to also match ignored files (e.g. build outputs, \`node_modules\`). Sensitive files (such as \`.env\`) are always filtered out. Matches are files only — directories are never listed; to find a directory, glob for a file inside it (e.g. \`**/fixtures/**\`).\\n\\nGood patterns:\\n- \`*.ts\` — extension match at any depth below the search root (a bare pattern without \`/\` matches recursively)\\n- \`src/*.ts\` — files directly inside \`src/\` (one level, not recursive)\\n- \`src/**/*.ts\` — recursive walk with a subdirectory anchor and extension\\n- \`**/*.py\` — recursive walk from the search root for an extension\\n- \`*.{ts,tsx}\` / \`{src,test}/**/*.ts\` — brace expansion (cartesian supported)\\n\\nResults are capped at the first 100 matching paths, with a truncation marker. Refine the pattern (extension, subdirectory) or call again with a narrower anchor when 100 is not enough.\\n\\nLarge-directory caveat — avoid recursing into dependency / build output even with an anchor, especially with \`include_ignored\`: \`node_modules/**/*.js\`, \`.venv/**/*.py\`, \`__pycache__/**\`, \`target/**\` can produce thousands of results that truncate at the cap and waste context. Prefer specific subpaths like \`node_modules/react/src/**/*.js\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Grep", "description": "Search file contents using regular expressions (powered by ripgrep).\\n\\nUse Grep when the task is to find unknown content or unknown file locations. Do not use shell \`grep\` or \`rg\` directly; ALWAYS use Grep tool instead of running \`grep\` or \`rg\` from a shell — direct shell calls bypass workspace path policy, output limits, and sensitive-file filtering. If you already know a concrete file path and need its contents, use Read directly.\\n\\nPatterns use ripgrep regex syntax, which differs from POSIX \`grep\` — for example, braces are special, so escape them as \`\\\\{\` to match a literal \`{\`.\\n\\nHidden files (dotfiles such as \`.gitlab-ci.yml\` or \`.eslintrc.json\`) are searched by default. Set \`include_ignored\` to \`true\` to also search \`.gitignore\`-excluded files (such as \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) are always skipped for safety, even when \`include_ignored\` is \`true\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Read", "description": "Read a text file from the local filesystem.\\n\\nIf the user provides a concrete file path, call Read directly — do not \`Glob\`, \`ls\`, or otherwise pre-check known paths; missing or invalid paths return errors you can handle. Do not use Read for directories: use \`ls\` via Bash for a known directory, or Glob for name patterns (Glob lists files only, never directories). Use \`Grep\` only to search unknown content or locations.\\n\\nRead several files in parallel: emit multiple \`Read\` calls in a single response instead of one file per turn.\\n\\n- Relative paths resolve against the working directory; a path outside it must be absolute.\\n- Returns up to 1000 lines or 100 KB per call, whichever comes first; lines longer than 2000 chars are truncated mid-line.\\n- Page with \`line_offset\` (1-based) and \`n_lines\`; omit \`n_lines\` for the 1000-line cap. A negative line_offset reads from the end (-100 reads the last 100 lines); absolute value cannot exceed 1000.\\n- Sensitive files (\`.env\` files, credential stores, SSH private keys, similar secrets) are refused; templates (\`.env.example\` / \`.env.sample\` / \`.env.template\`) and public SSH keys (\`id_rsa.pub\`) read normally.\\n- UTF-8 text only — non-UTF-8 encodings, binary files, and files with NUL bytes are refused; use \`ReadMediaFile\` for images/video, Bash or an MCP tool for other binary formats.\\n- Output format: \`<line-number>\\\\t<content>\` per line. A \`<system>...</system>\` status block is appended after the file content; it summarizes line/byte counts, truncation, and line-ending notes, and is not part of the file.\\n- Pure CRLF files are displayed with LF; \`Edit\` matches this output and writes CRLF back. Mixed or lone carriage returns show as \`\\\\r\` and require exact \`Edit.old_string\` escapes.\\n- After a successful \`Edit\`/\`Write\`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a text file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed 1000.", "anyOf": [ { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }, { "type": "integer", "minimum": -1000, "maximum": -1 } ] }, "n_lines": { "description": "The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of 1000 lines.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false } }, { "name": "SetGoalBudget", "description": "Set a hard budget limit for the current goal.\\n\\nUse this only when the user clearly gives a runtime limit, such as \\"stop after 20 turns\\", \\"use no more than 500k tokens\\", or \\"finish within 30 minutes\\". Do not invent limits, and do not call this for vague wording such as \\"spend some time\\" or \\"try to be quick\\".\\n\\nConvert a compound time to one supported unit before calling — for example, \\"2 hours and 3 minutes\\" → \`value: 123, unit: \\"minutes\\"\`.\\n\\nA time budget must be between 1 second and 24 hours — the tool rejects anything shorter or longer as unreasonable. Turn and token budgets are not bounded this way; they must be positive and are rounded to the nearest whole number (minimum 1).\\n\\nSupported units: \`turns\`, \`tokens\`, \`milliseconds\`, \`seconds\`, \`minutes\`, \`hours\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] } }, "required": [ "value", "unit" ], "additionalProperties": false } }, { "name": "Skill", "description": "Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<kimi-skill-loaded>\` block for it with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "type": "string", "description": "The exact name of the skill to invoke, spelled as it appears in the current skill listing (e.g. \\"commit\\", \\"pdf\\")." }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "required": [ "skill" ], "additionalProperties": false } }, { "name": "TaskList", "description": "List background tasks and their current status.\\n\\nDiscovers which background tasks exist and where each one stands: task ID, status, and description, plus the command, PID, and (once finished) exit code for shell tasks, and a stop reason for any task that ended early.\\n\\nGuidelines:\\n\\n- After a context compaction, or whenever unsure which tasks are running or what their IDs are, re-enumerate with this tool instead of guessing a task ID.\\n- Default \`active_only=true\` lists non-terminal tasks — including \`input_required\` tasks awaiting an explicit scope decision (actionable, not still executing). Pass \`active_only=false\` only to see finished tasks; the result may then include \`lost\` tasks (left over from a previous process, no longer inspectable or controllable — treat them as already terminated).\\n- \`limit\` caps how many tasks are returned: 1-100, default 20.\\n- Lists tasks only, not their output — locate the task ID here, then call \`TaskOutput\` for output and details.\\n- Read-only and changes no state — always safe to call, including in plan mode.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false } }, { "name": "TaskOutput", "description": "Retrieve a snapshot of a running or completed background task.\\n\\nUse this after \`Bash(run_in_background=true)\`, \`Agent(run_in_background=true)\`, or \`AskUserQuestion(background=true)\` to check progress, or to read the output of a task that has already completed.\\n\\nGuidelines:\\n- Prefer relying on automatic completion notifications. Use this tool only when you need task output before the automatic notification arrives.\\n- This tool is always non-blocking: it returns the current status/output snapshot immediately and never waits for the task to finish.\\n- Do not use TaskOutput to wait for a result you need before continuing — if your next step depends on the task's result, run that task in the foreground instead. TaskOutput is for a deliberate progress check you will act on without blocking, not a way to sit and wait for a background task you just launched.\\n- This tool returns structured task metadata, a fixed-size output preview, and an output_path for the full log.\\n- For a terminal task, the metadata also explains why it ended. A shell command that runs to completion reports \`status: completed\` on a zero exit, or \`status: failed\` with its non-zero \`exit_code\` — judge that failure from the \`exit_code\`, because a plain command failure carries no \`stop_reason\` and no \`terminal_reason\`. \`terminal_reason\` is a categorical label emitted only when the end is not an ordinary exit: \`timed_out\` when the deadline aborted it, \`stopped\` when it was explicitly stopped, or \`failed\` when it errored without producing an exit code; the \`stopped\` and \`failed\` cases also carry a human-readable \`stop_reason\`. A task that finished on its own with a clean exit carries neither \`stop_reason\` nor \`terminal_reason\`.\\n- The full, never-truncated log is always available at output_path; use the \`Read\` tool with that path to page through it, whether or not the preview was truncated.\\n- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TaskStop", "description": "Stop a running background task.\\n\\nOnly use this when a task must genuinely be cancelled — for a task that is\\nfinishing normally, wait for its completion notification or inspect it with\\n\`TaskOutput\` instead of stopping it.\\n\\nGuidelines:\\n- This is a general-purpose stop capability for any background task. It is not\\n  a bash-specific kill.\\n- Stopping a task is destructive: it may leave partial side effects behind.\\n  Use it with care.\\n- If the task has already finished, this tool simply returns its current\\n  status.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TodoList", "description": "Use this tool to maintain a structured TODO list through a multi-step task. Use it proactively and often when progress tracking helps — long-running investigations and implementations with several tool calls. In plan mode, write the plan to the plan file rather than tracking it here.\\n\\n**When to use:**\\n- Multi-step tasks that span several tool calls\\n- Tracking investigation progress across a large codebase search\\n- Planning a sequence of edits before making them\\n- Capturing new multi-step instructions as todos\\n- Mark exactly one item \`in_progress\` before starting it; mark it \`done\` immediately after finishing — do not batch completions at the end\\n\\n**When NOT to use:**\\n- Single-shot answers that complete in one or two tool calls\\n- Trivial requests where tracking adds no clarity\\n- Purely conversational or informational replies\\n\\n**Avoid churn:**\\n- Update only after real progress — do not re-call when nothing meaningful has changed.\\n- Unsure of the current state? Call query mode (omit \`todos\`) to check before deciding what to update.\\n- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.\\n\\n**How to use:**\\n- \`todos: [...]\` replaces the full list; statuses: pending / in_progress / done. Call with no \`todos\` argument to retrieve the current list without changing it; \`todos: []\` clears it.\\n- Keep titles short and actionable (e.g. \\"Read session-control.ts\\", \\"Add planMode flag to TurnManager\\").\\n- Keep exactly one task \`in_progress\` while work is underway.\\n- Mark \`done\` only when fully accomplished. Never mark a task \`done\` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.\\n- On a blocker, keep the blocked task \`in_progress\` or add a new pending task describing what must be resolved.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." } }, "required": [ "title", "status" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "UpdateGoal", "description": "Set the status of the current goal — how you resume, complete, or block an autonomous goal.\\n\\n- \`active\` — resume a paused or blocked goal when the user explicitly asks you to work on that goal.\\n- \`complete\` — the objective is satisfied and any stated validation has passed; the goal ends and a completion summary is recorded. Verify current state against the actual objective and every explicit requirement first, and treat weak or indirect evidence as not complete. Never use \`complete\` merely because a budget is nearly exhausted or you want to stop.\\n- \`blocked\` — a genuine impasse prevents useful progress: an external condition, required user input, missing credentials or permissions, a persistent technical failure, or an impossible, unsafe, or contradictory objective. For non-terminal blockers, the same condition must repeat for at least 3 consecutive goal turns (counting the original/user-triggered turn and automatic continuations) before you call \`blocked\`; a resumed goal starts a fresh blocked audit. If the objective itself is impossible, unsafe, or contradictory, call \`blocked\` in the same turn instead of running more goal turns. Never use \`blocked\` because work is large, hard, slow, uncertain, incomplete, still needs validation, would benefit from clarification, or needs more goal turns. Once the 3-turn threshold is met and you cannot make meaningful progress without user input or an external-state change, call \`blocked\` rather than leaving the goal active.\\n\\nMost active goal turns should not call this tool: after one useful slice of work with material work remaining, end the turn normally without calling UpdateGoal; the runtime will prompt you to continue next turn. Call \`complete\` only when all required work is done, stated validation has passed, and no useful next action exists — not after only a plan, summary, first pass, or partial result. If you call \`blocked\`, explain the blocker in your next message. Setting the status is the machine-readable signal; the completion summary or blocker explanation is yours to write.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." } }, "required": [ "status" ], "additionalProperties": false } }, { "name": "Write", "description": "Create, append to, or replace a file entirely.\\n\\n- Missing parent directories are created automatically (like \`mkdir(parents=True, exist_ok=True)\`).\\n- Mode defaults to overwrite; append adds content at EOF without adding a newline.\\n- Write is NOT ALLOWED for incremental changes to existing files, including trivial, one-line, quick, or cosmetic edits. Use Edit instead. Use Write only when the file does not exist, you intend a complete replacement, or the new contents have little continuity with the old.\\n- Do not create unsolicited documentation files (\`*.md\` write-ups, \`README\`s, summaries) just because a task finished — only when the user asks, or a task/project instruction requires it (e.g. the plan-mode plan file, or a changeset the repo mandates).\\n- Read before overwriting an existing file.\\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\\n- Outputs content literally, including supplied line endings: \\\\n stays LF, \\\\r\\\\n stays CRLF.\\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "cb20f27a3d963106c385d7602a67f0ea5f6ccdb686d06459206d591755c5838d", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "blocked" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] agent.status.updated        { "contextTokens": 8 }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "filtered", "providerFinishReason": "filtered", "rawFinishReason": "filtered" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "blocked" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "filtered", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "filtered", "rawFinishReason": "filtered" }, "time": "<time>" }
      [wire] turn.ended                  { "turnId": 0, "reason": "failed", "error": { "code": "provider.filtered", "message": "Provider safety policy blocked the response.", "name": "ProviderFilteredError", "details": { "finishReason": "filtered" }, "retryable": false }, "time": "<time>" }
      [emit] turn.ended                  { "turnId": 0, "reason": "failed", "error": { "code": "provider.filtered", "message": "Provider safety policy blocked the response.", "name": "ProviderFilteredError", "details": { "finishReason": "filtered" }, "retryable": false }, "interruptReason": "filtered" }
    `);

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );

    expect(stepCompleted?.args).toMatchObject({
      finishReason: 'filtered',
    });
  });

  it('marks a completed turn as truncated when the provider stops at max tokens', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'partial answer' }],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    const turn = (loop as unknown as { activeTurnJob?: { turn: Turn } }).activeTurnJob?.turn;
    expect(turn).toBeDefined();

    await ctx.untilTurnEnd();
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: true,
    });

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );
    expect(stepCompleted?.args).toMatchObject({
      finishReason: 'max_tokens',
      providerFinishReason: 'truncated',
      rawFinishReason: 'length',
    });
    const turnEnded = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({ reason: 'completed' });
  });

  it('stops the turn when provider reports tool_calls without any tool call structure', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'done' }],
      finishReason: 'tool_calls',
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    const turn = (loop as unknown as { activeTurnJob?: { turn: Turn } }).activeTurnJob?.turn;
    expect(turn).toBeDefined();

    await ctx.untilTurnEnd();
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
    });

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );
    expect(stepCompleted?.args).toMatchObject({
      finishReason: 'other',
      providerFinishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    });
  });

  it('lets a loop error handler recover a non-context loop error by retrying', async () => {
    profile.update({ activeToolNames: [] });
    const seenErrors: Array<{ readonly step: number | undefined; readonly message: string }> = [];

    loop.registerLoopErrorHandler({
      id: 'test-recover-generate-error',
      match: () => true,
      handle: async (hookCtx) => {
        seenErrors.push({
          step: hookCtx.step,
          message: hookCtx.error instanceof Error ? hookCtx.error.message : String(hookCtx.error),
        });
        if (seenErrors.length === 1) {
          ctx.mockNextResponse({ type: 'text', text: 'Recovered.' });
          if (hookCtx.failedDriver !== undefined) {
            loop.enqueue(hookCtx.failedDriver, { at: 'head' });
            return true;
          }
        }
        return undefined;
      },
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(seenErrors).toEqual([
      { step: 1, message: 'Unexpected generate call #1' },
    ]);
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('reports an untyped LLM error message without an internal-code prefix', async () => {
    profile.update({ activeToolNames: [] });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.step.interrupted',
        args: expect.objectContaining({
          reason: 'error',
          message: 'Unexpected generate call #1',
        }),
      }),
    );
  });

  it('does not run loop error handlers for aborted turns', async () => {
    let called = false;
    loop.registerLoopErrorHandler({
      id: 'test-abort-not-recoverable',
      match: () => {
        called = true;
        return true;
      },
      handle: async () => undefined,
    });
    const controller = new AbortController();
    controller.abort(new Error('stop'));

    const result = await loop.run({ turnId: 0, signal: controller.signal });

    expect(result.type).toBe('cancelled');
    expect(called).toBe(false);
  });

  it('fails with the error handler error when recovery throws', async () => {
    const recoveryError = new Error('recovery failed');
    loop.registerLoopErrorHandler({
      id: 'test-throw-recovery-error',
      match: () => true,
      handle: async () => {
        throw recoveryError;
      },
    });

    loop.enqueue(new ContinuationStepRequest());
    const result = await loop.run({ turnId: 0 });

    expect(result.type).toBe('failed');
    if (result.type === 'failed') {
      expect(result.error).toBe(recoveryError);
    }
  });

  it('runs an agent turn through registered tool approval and execution', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };

    profile.update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Look up moon' }],
    });
    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is lookup-result.' });
    expect(await ctx.untilApproval(true)).toMatchInlineSnapshot(`
      [wire] tools.set_active_tools          { "names": [ "Lookup" ], "time": "<time>" }
      [wire] turn.prompt                     { "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                    { "turnId": 0, "origin": { "kind": "user" }, "prompt": "Look up moon" }
      [emit] agent.activity.updated          { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.spliced                 { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" } ] }
      [wire] context.append_message          { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "time": "<time>" }
      [emit] turn.step.started               { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] agent.activity.updated          { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event       { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot              { "hash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "tools": [ { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                     { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta                 { "turnId": 0, "delta": "I will look it up." }
      [emit] agent.activity.updated          { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] tool.call.delta                 { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
      [emit] agent.activity.updated          { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                    { "model": "mock-model", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated            { "usage": { "byModel": { "mock-model": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] agent.status.updated            { "contextTokens": 20 }
      [wire] context.append_loop_event       { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will look it up." } }, "time": "<time>" }
      [emit] permission.approval.requested   { "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } }, "toolInput": { "query": "moon" } }
      [emit] agent.activity.updated          { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [ { "approvalId": "call_lookup", "toolCallId": "call_lookup", "since": "<time>" } ], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] requestApproval                 { "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: Lookup
    messages:
      user: text "Look up moon"
  `);

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [emit] permission.approval.resolved        { "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } }, "toolInput": { "query": "moon" }, "decision": "approved", "selectedLabel": "approve" }
      [emit] agent.activity.updated              { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "result": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
      [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
      [emit] agent.activity.updated              { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [ { "toolCallId": "call_lookup", "name": "Lookup", "since": "<time>" } ], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }, "time": "<time>" }
      [emit] tool.result                         { "turnId": 0, "toolCallId": "call_lookup", "output": "lookup-result" }
      [emit] agent.activity.updated              { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event           { "event": { "type": "tool.result", "parentUuid": "<uuid-3>", "toolCallId": "call_lookup", "result": { "output": "lookup-result" } }, "time": "<time>" }
      [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
      [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-4>" }
      [emit] agent.activity.updated              { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "<uuid-4>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [wire] llm.request                         { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "messageCount": 3, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta                     { "turnId": 0, "delta": "The lookup result is lookup-result." }
      [emit] agent.activity.updated              { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "usage": { "byModel": { "mock-model": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] agent.status.updated                { "contextTokens": 37 }
      [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-4>", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [emit] agent.activity.updated              { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event           { "event": { "type": "content.part", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "stepUuid": "<uuid-4>", "part": { "type": "text", "text": "The lookup result is lookup-result." } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
      [wire] turn.ended                          { "turnId": 0, "reason": "completed", "time": "<time>" }
      [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    messages:
      <last>
      assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "moon" }
      tool[call_lookup]: text "lookup-result"
  `);
  });

  it('lets non-external stop hooks continue a turn more than once', async () => {
    profile.update({ activeToolNames: [] });
    let continuations = 0;
    loop.hooks.onDidFinishStep.register('test-repeat-stop-continuation', async (hookCtx, next) => {
      if (continuations < 2) {
        continuations += 1;
        loop.enqueue(
          new MessageStepRequest(
            {
              role: 'user',
              content: [{ type: 'text', text: `continue ${continuations}` }],
              toolCalls: [],
              origin: { kind: 'system_trigger', name: 'stop_hook' },
            },
            { kind: 'stop_hook', mergeable: true },
          ),
        );
        return;
      }
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Second answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Third answer.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    expect(continuations).toBe(2);
    expect(ctx.llmCalls).toHaveLength(3);
    expect(ctx.contextData().history).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'continue 1' }],
        origin: { kind: 'system_trigger', name: 'stop_hook' },
      }),
    );
    expect(ctx.contextData().history).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'continue 2' }],
        origin: { kind: 'system_trigger', name: 'stop_hook' },
      }),
    );
  });

  it('ends the turn when an afterStep hook sets stopTurn even though the model requested tool calls', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };
    profile.update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);

    loop.hooks.onDidFinishStep.register('test-stop-turn', async (hookCtx, next) => {
      hookCtx.stopTurn = true;
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    ctx.mockNextResponse({ type: 'text', text: 'This step should not run.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
    const turn = (loop as unknown as { activeTurnJob?: { turn: Turn } }).activeTurnJob?.turn;
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
    });
  });

  it('lets stopTurn take precedence over a queued continuation request', async () => {
    profile.update({ activeToolNames: [] });

    loop.hooks.onDidFinishStep.register('test-continue-like-stop-hook', async (hookCtx, next) => {
      loop.enqueue(new ContinuationStepRequest());
      await next();
    });
    loop.hooks.onDidFinishStep.register('test-hard-stop', async (hookCtx, next) => {
      hookCtx.stopTurn = true;
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'This continuation should not run.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const turn = (loop as unknown as { activeTurnJob?: { turn: Turn } }).activeTurnJob?.turn;
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
    });
  });

  it('queues consecutive nextTurn requests in FIFO order without overlapping turns', async () => {
    const events: string[] = [];
    const subscription = ctx.get(IEventBus).subscribe((event) => {
      if (event.type === 'turn.started' || event.type === 'turn.ended') {
        events.push(`${event.type}:${event.turnId}`);
      }
    });
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    ctx.mockNextResponse({ type: 'text', text: 'three' });

    const first = (await loop.enqueue(nextTurnMessage('first')).assigned).turn;
    const second = (await loop.enqueue(nextTurnMessage('second')).assigned).turn;
    const third = (await loop.enqueue(nextTurnMessage('third')).assigned).turn;

    expect([first.state, second.state, third.state]).toEqual(['running', 'queued', 'queued']);
    await Promise.all([first.result, second.result, third.result]);
    subscription.dispose();

    expect(events).toEqual([
      'turn.started:0',
      'turn.ended:0',
      'turn.started:1',
      'turn.ended:1',
      'turn.started:2',
      'turn.ended:2',
    ]);
    expect(ctx.llmCalls).toHaveLength(3);
  });

  it('refuses a quiescence lease while a turn is active without cancelling it', async () => {
    let started!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const canFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hook = loop.hooks.onWillBeginStep.register('test-quiescence', async (_hookCtx, next) => {
      started();
      await canFinish;
      await next();
    });

    const active = (await loop.enqueue(nextTurnMessage('active')).assigned).turn;
    await activeStarted;

    expect(loop.tryAcquireQuiescence()).toBeUndefined();
    expect(active.signal.aborted).toBe(false);

    hook.dispose();
    ctx.mockNextResponse({ type: 'text', text: 'completed normally' });
    release();
    await expect(active.result).resolves.toMatchObject({ type: 'completed' });
  });

  it('holds new admissions until an idle quiescence lease is released', async () => {
    const lease = loop.tryAcquireQuiescence();
    expect(lease).toBeDefined();
    const held = loop.enqueue(nextTurnMessage('held'));
    let assigned = false;
    void held.assigned.then(() => {
      assigned = true;
    });

    await Promise.resolve();
    expect(assigned).toBe(false);
    expect(loop.status()).toMatchObject({ state: 'idle', hasPendingRequests: true });

    ctx.mockNextResponse({ type: 'text', text: 'after undo' });
    lease?.dispose();
    const resumed = (await held.assigned).turn;
    await expect(resumed.result).resolves.toMatchObject({ type: 'completed' });
  });

  it('can abort an admission while quiescence holds it', async () => {
    const lease = loop.tryAcquireQuiescence();
    expect(lease).toBeDefined();
    const held = loop.enqueue(nextTurnMessage('held'));

    expect(held.abort()).toBe(true);
    await expect(held.assigned).rejects.toBeDefined();
    expect(loop.hasPendingRequests()).toBe(false);

    lease?.dispose();
    expect(loop.status().state).toBe('idle');
  });

  it('cancels a running step without cancelling its turn and continues the next step', async () => {
    let releaseRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    let stepStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stepStarted = resolve;
    });
    loop.hooks.onWillBeginStep.register('test-running-step-cancel', async (hookCtx, next) => {
      if (hookCtx.step === 2) {
        stepStarted();
        await Promise.race([
          running,
          new Promise<void>((_, reject) => {
            hookCtx.signal.addEventListener('abort', () => reject(hookCtx.signal.reason), { once: true });
          }),
        ]);
      }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'initial' });
    ctx.mockNextResponse({ type: 'text', text: 'after cancellation' });

    const turn = (await loop.enqueue(nextTurnMessage('start')).assigned).turn;
    const cancelledStep = (await loop.enqueue(new ContinuationStepRequest()).assigned).step;
    loop.enqueue(new ContinuationStepRequest());
    await started;

    expect(cancelledStep.state).toBe('running');
    expect(cancelledStep.cancel(new Error('skip this step'))).toBe(true);
    await expect(cancelledStep.result).resolves.toMatchObject({ type: 'cancelled' });
    await expect(turn.result).resolves.toMatchObject({ type: 'completed', steps: 3 });
    releaseRunning();

    expect(turn.state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(2);
  });

  it('disposes active and queued turns with all steps settled and never pumps again', async () => {
    let stepStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stepStarted = resolve;
    });
    loop.hooks.onWillBeginStep.register('test-dispose-loop', async (hookCtx, next) => {
      stepStarted();
      await new Promise<void>((_, reject) => {
        hookCtx.signal.addEventListener('abort', () => reject(hookCtx.signal.reason), { once: true });
      });
      await next();
    });

    const active = (await loop.enqueue(nextTurnMessage('active')).assigned).turn;
    const activeQueuedStep = (await loop.enqueue(new ContinuationStepRequest()).assigned).step;
    const queued = (await loop.enqueue(nextTurnMessage('queued')).assigned).turn;
    const queuedExtraStep = (await loop.enqueue(nextTurnMessage('queued-extra')).assigned).step;
    await started;

    (loop as IAgentLoopService & { dispose(): void }).dispose();

    await expect(active.result).resolves.toMatchObject({ type: 'cancelled' });
    await expect(queued.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    await expect(activeQueuedStep.result).resolves.toMatchObject({ type: 'cancelled' });
    await expect(queuedExtraStep.result).resolves.toMatchObject({ type: 'cancelled' });
    expect(active.state).toBe('cancelled');
    expect(queued.state).toBe('cancelled');
    expect(ctx.llmCalls).toHaveLength(0);
    expect(() => loop.enqueue(nextTurnMessage('rejected'))).toThrow();
  });

  it('cancels a queued turn without starting or materializing its initial request', async () => {
    const started: number[] = [];
    const subscription = ctx.get(IEventBus).subscribe('turn.started', (event) => {
      started.push(event.turnId);
    });
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    ctx.mockNextResponse({ type: 'text', text: 'three' });

    const first = (await loop.enqueue(nextTurnMessage('first')).assigned).turn;
    const cancelledReceipt = loop.enqueue(nextTurnMessage('cancelled'));
    const cancelledTurn = (await cancelledReceipt.assigned).turn;
    const third = (await loop.enqueue(nextTurnMessage('third')).assigned).turn;

    expect(cancelledReceipt.abort()).toBe(true);
    await expect(cancelledTurn.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    await Promise.all([first.result, third.result]);
    subscription.dispose();

    expect(started).toEqual([0, 2]);
    expect(ctx.contextData().history).not.toContainEqual(
      expect.objectContaining({ content: [{ type: 'text', text: 'cancelled' }] }),
    );
  });

  it('omits the turn.started prompt for system-triggered turns', async () => {
    const prompts: Array<string | undefined> = [];
    const subscription = ctx.get(IEventBus).subscribe('turn.started', (event) => {
      prompts.push(event.prompt);
    });
    ctx.mockNextResponse({ type: 'text', text: 'continued' });
    ctx.mockNextResponse({ type: 'text', text: 'hi there' });

    // A goal-continuation turn carries internal steering text as its input —
    // the turn boundary must land without a prompt.
    const system = (
      await loop.enqueue(
        new MessageStepRequest(
          {
            role: 'user',
            content: [{ type: 'text', text: 'continue the goal' }],
            toolCalls: [],
            origin: { kind: 'system_trigger', name: 'goal_continuation' },
          },
          { admission: 'newTurn' },
        ),
      ).assigned
    ).turn;
    await system.result;
    const user = (await loop.enqueue(nextTurnMessage('hi')).assigned).turn;
    await user.result;
    subscription.dispose();

    expect(prompts).toEqual([undefined, 'hi']);
  });
});

describe('turn telemetry', () => {
  it('emits turn_started and turn_ended with mode and protocol on completion', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      local.mockNextResponse({ type: 'text', text: 'hi' });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_started',
        properties: {
          turn_id: 0,
          agent_id: 'main',
          mode: 'agent',
          provider_type: 'kimi',
          protocol: 'openai',
          thinking_effort: 'off',
        },
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'completed',
          duration_ms: expect.any(Number),
          mode: 'agent',
          provider_type: 'kimi',
          protocol: 'openai',
          thinking_effort: 'off',
        }),
      });
      expect(records.some((record) => record.event === 'turn_interrupted')).toBe(false);
    } finally {
      await local.dispose();
    }
  });

  it('keeps turn telemetry aligned with the request config across pre-step changes', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      const localLoop = local.get(IAgentLoopService);
      const localProfile = local.get(IAgentProfileService);
      local.configure({
        modelCapabilities: {
          image_in: false,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
          max_context_tokens: 1_000_000,
        },
      });
      localProfile.update({ activeToolNames: [] });
      localProfile.setThinking('on');
      localLoop.hooks.onWillBeginStep.register('test-change-thinking', async (_ctx, next) => {
        localProfile.setThinking('off');
        await next();
      });
      local.mockNextResponse({ type: 'text', text: 'hi' });

      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      const request = local.allEvents.find(
        (event) => event.type === '[wire]' && event.event === 'llm.request',
      );
      expect(request?.args).toMatchObject({ thinkingEffort: 'on' });
      expect(records).toContainEqual({
        event: 'turn_started',
        properties: expect.objectContaining({ turn_id: 0, thinking_effort: 'on' }),
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({ turn_id: 0, thinking_effort: 'on' }),
      });
    } finally {
      await local.dispose();
    }
  });

  it('attaches the latest request trace id to turn_ended', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'hi' }],
        traceId: 'trace-turn-1',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'completed',
          trace_id: 'trace-turn-1',
        }),
      });
    } finally {
      await local.dispose();
    }
  });

  it('does not reuse the previous step trace when a step hook fails before a request', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      const localLoop = local.get(IAgentLoopService);
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      localLoop.hooks.onDidFinishStep.register('test-continue-after-first-step', async (hookCtx, next) => {
        if (hookCtx.step === 1) {
          localLoop.enqueue(new ContinuationStepRequest());
          return;
        }
        await next();
      });
      localLoop.hooks.onWillBeginStep.register('test-fail-before-second-request', async (hookCtx, next) => {
        if (hookCtx.step === 2) throw new Error('before step failed');
        await next();
      });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'first' }],
        traceId: 'trace-step-1',
      });

      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(local.llmCalls).toHaveLength(1);
      expect(records.find((record) => record.event === 'turn_interrupted')?.properties?.['trace_id']).toBeUndefined();
      expect(records.find((record) => record.event === 'turn_ended')?.properties?.['trace_id']).toBeUndefined();
    } finally {
      await local.dispose();
    }
  });

  it('emits turn_interrupted with interrupt_reason filtered and turn_ended failed', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'blocked' }],
        finishReason: 'filtered',
        traceId: 'trace-turn-2',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_interrupted',
        properties: expect.objectContaining({
          turn_id: 0,
          at_step: 1,
          mode: 'agent',
          interrupt_reason: 'filtered',
          provider_type: 'kimi',
          protocol: 'openai',
          trace_id: 'trace-turn-2',
        }),
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'failed',
          mode: 'agent',
          trace_id: 'trace-turn-2',
        }),
      });
    } finally {
      await local.dispose();
    }
  });

  it.each([
    ['user_cancelled', () => userCancellationReason()],
    ['aborted', () => new Error('stop')],
  ] as const)(
    'emits turn_interrupted with interrupt_reason %s on cancellation',
    async (expected, makeReason) => {
      const records: TelemetryRecord[] = [];
      const local = createTestAgent({ telemetry: recordingTelemetry(records) });
      try {
        const localLoop = local.get(IAgentLoopService);
        let stepStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          stepStarted = resolve;
        });
        localLoop.hooks.onWillBeginStep.register('test-hang', async (hookCtx, next) => {
          stepStarted();
          await new Promise<void>((_, reject) => {
            hookCtx.signal.addEventListener('abort', () => reject(hookCtx.signal.reason), {
              once: true,
            });
          });
          await next();
        });

        const turn = (await localLoop.enqueue(nextTurnMessage('hang')).assigned).turn;
        await started;
        localLoop.cancel(turn.id, makeReason());
        await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

        expect(records).toContainEqual({
          event: 'turn_interrupted',
          properties: expect.objectContaining({ turn_id: 0, interrupt_reason: expected, mode: 'agent' }),
        });
        expect(records).toContainEqual({
          event: 'turn_ended',
          properties: expect.objectContaining({ reason: 'cancelled' }),
        });
      } finally {
        await local.dispose();
      }
    },
  );
});

describe('interruption reminder', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;

  beforeEach(() => {
    ctx = createTestAgent();
    loop = ctx.get(IAgentLoopService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function cancelOnFirstDelta(): IDisposable {
    return ctx.get(IEventBus).subscribe('assistant.delta', () => {
      loop.cancel();
    });
  }

  function remindersIn(target: TestAgentContext): ContextMessage[] {
    return target.contextData().history.filter(
      (message) =>
        message.origin?.kind === 'injection' && message.origin.variant === 'interruption',
    );
  }

  function interruptionReminders(): ContextMessage[] {
    return remindersIn(ctx);
  }

  function contentPartRecordsIn(target: TestAgentContext): number {
    return target.allEvents.filter(
      (entry) =>
        entry.type === '[wire]' &&
        entry.event === 'context.append_loop_event' &&
        (entry.args as { event?: { type?: string } }).event?.type === 'content.part',
    ).length;
  }

  it('preserves the partial stream and appends one reminder on user cancel', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const subscription = cancelOnFirstDelta();
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(ctx.contextData().history).toEqual([
      expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Hello' }] }),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial answer' }],
        toolCalls: [],
        partial: true,
      },
      expect.objectContaining({
        role: 'user',
        origin: { kind: 'injection', variant: 'interruption' },
      }),
    ]);
    expect(interruptionReminders()).toHaveLength(1);
    expect(interruptionReminders()[0]!.content).toEqual([
      {
        type: 'text',
        text: '<system-reminder>\nThe previous turn was interrupted by the user before completion; any partial output shown above is incomplete. The user\'s next message continues the conversation.\n</system-reminder>',
      },
    ]);

    const cancelRecord = ctx.allEvents.find(
      (entry) => entry.type === '[wire]' && entry.event === 'turn.cancel',
    );
    expect(cancelRecord?.args).toMatchObject({
      turnId: 0,
      target: 'active',
      reason: 'user_cancelled',
    });
    const turnEnded = ctx.allEvents.find(
      (entry) => entry.type === '[rpc]' && entry.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({
      reason: 'cancelled',
      interruptReason: 'user_cancelled',
    });
    expect(contentPartRecordsIn(ctx)).toBe(1);
  });

  it('writes one active cancellation when cancel repeats before the turn settles', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const results: boolean[] = [];
    let cancelled = false;
    const subscription = ctx.get(IEventBus).subscribe('assistant.delta', () => {
      if (cancelled) return;
      cancelled = true;
      results.push(loop.cancel(), loop.cancel());
    });
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();
    await ctx.wire.flush();

    expect(results).toEqual([true, true]);
    expect(
      ctx.allEvents.filter(
        (entry) => entry.type === '[wire]' && entry.event === 'turn.cancel',
      ),
    ).toHaveLength(1);
    expect(interruptionReminders()).toHaveLength(1);
    expect(
      ctx.allEvents.filter(
        (entry) => entry.type === '[wire]' && entry.event === 'interruptionReminder.recorded',
      ),
    ).toHaveLength(1);
  });

  it('preserves the partial stream but appends no reminder on programmatic abort', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const subscription = ctx.get(IEventBus).subscribe('assistant.delta', () => {
      loop.cancel(undefined, new Error('stop'));
    });
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(ctx.contextData().history).toContainEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial answer' }],
      toolCalls: [],
      partial: true,
    });
    expect(interruptionReminders()).toHaveLength(0);

    const cancelRecord = ctx.allEvents.find(
      (entry) => entry.type === '[wire]' && entry.event === 'turn.cancel',
    );
    expect(cancelRecord?.args).toMatchObject({ target: 'active', reason: 'aborted' });
    const turnEnded = ctx.allEvents.find(
      (entry) => entry.type === '[rpc]' && entry.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({ reason: 'cancelled', interruptReason: 'aborted' });
  });

  it('does not stack a second reminder without an intervening message', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const subscription = cancelOnFirstDelta();
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    ctx.get(IEventBus).publish({
      type: 'turn.ended',
      turnId: 99,
      reason: 'cancelled',
      interruptReason: 'user_cancelled',
    });

    expect(interruptionReminders()).toHaveLength(1);
  });

  it('appends no reminder when a queued turn is user-cancelled before starting', async () => {
    let release!: () => void;
    loop.hooks.onWillBeginStep.register('test-hang-queued-cancel', async (hookCtx, next) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'unreached' });

    const active = (await loop.enqueue(nextTurnMessage('active')).assigned).turn;
    const queued = (await loop.enqueue(nextTurnMessage('queued')).assigned).turn;
    expect(loop.cancel(queued.id)).toBe(true);
    await expect(queued.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    release();
    loop.cancel(active.id);
    await expect(active.result).resolves.toMatchObject({ type: 'cancelled' });

    expect(interruptionReminders()).toHaveLength(1);
    const queuedCancel = ctx.allEvents.find(
      (entry) =>
        entry.type === '[wire]' &&
        entry.event === 'turn.cancel' &&
        (entry.args as { target?: string }).target === 'queued',
    );
    expect(queuedCancel?.args).toMatchObject({ target: 'queued', reason: 'user_cancelled' });
  });

  it('sends the partial output and reminder ahead of the next user message', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const subscription = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();
    subscription.dispose();
    ctx.llmInputs(); // drain the interrupted turn's request

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();

    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "partial answer"
        user: text "<system-reminder>\\nThe previous turn was interrupted by the user before completion; any partial output shown above is incomplete. The user's next message continues the conversation.\\n</system-reminder>"
        user: text "Next"
    `);
  });

  it('removes the reminder together with the undone turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const subscription = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();
    subscription.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    await ctx.undoHistory(1);

    expect(ctx.contextData().history).toEqual([]);
  });

  it('preserves partial thinking on user cancel', async () => {
    ctx.mockNextResponse({ type: 'think', think: 'pondering' }, { type: 'text', text: 'answer' });
    const subscription = ctx.get(IEventBus).subscribe('thinking.delta', () => {
      loop.cancel();
    });
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(ctx.contextData().history).toContainEqual({
      role: 'assistant',
      content: [{ type: 'think', think: 'pondering' }],
      toolCalls: [],
      partial: true,
    });
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('records no partial content when the stream only produced whitespace', async () => {
    ctx.mockNextResponse({ type: 'text', text: '  ' }, { type: 'text', text: 'answer' });
    const subscription = cancelOnFirstDelta();
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(contentPartRecordsIn(ctx)).toBe(0);
    expect(ctx.contextData().history).toEqual([
      expect.objectContaining({ role: 'user' }),
      { role: 'assistant', content: [], toolCalls: [], partial: true },
      expect.objectContaining({ origin: { kind: 'injection', variant: 'interruption' } }),
    ]);
  });

  it('does not stack a second reminder around a vacuous retry turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const first = cancelOnFirstDelta();
    const firstTurn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(firstTurn.result).resolves.toMatchObject({ type: 'cancelled' });
    first.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'retried answer' });
    const onStepStarted = ctx.get(IEventBus).subscribe('turn.step.started', () => {
      loop.cancel();
    });
    const retryTurn = (await loop.enqueue(new RetryStepRequest()).assigned).turn;
    await expect(retryTurn.result).resolves.toMatchObject({ type: 'cancelled' });
    onStepStarted.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'third answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('does not duplicate recorded content when cancelled during tool execution', async () => {
    const local = createTestAgent(permissionModeServices('yolo'));
    try {
      const slowToolStarted = registerAbortableWorkTool(local);
      const localLoop = local.get(IAgentLoopService);
      local.mockNextResponse(
        { type: 'text', text: 'working' },
        { type: 'function', id: 'call-work-1', name: 'Work', arguments: '{}' },
      );
      local.mockNextResponse(
        { type: 'text', text: 'still working' },
        { type: 'function', id: 'call-work-2', name: 'Work', arguments: '{}' },
      );
      const turn = (await localLoop.enqueue(nextTurnMessage('do work')).assigned).turn;
      await slowToolStarted.promise;
      localLoop.cancel(turn.id);
      await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

      expect(contentPartRecordsIn(local)).toBe(2);

      const history = local.contextData().history;
      expect(remindersIn(local)).toHaveLength(1);
      expect(history.at(-1)?.origin).toEqual({ kind: 'injection', variant: 'interruption' });
      expect(history.at(-2)?.role).toBe('tool');

      await local.expectResumeMatches();
    } finally {
      await local.dispose();
    }
  });
});

describe('step timing split propagation', () => {
  it('carries the split from the llmRequester timing event to the turn.step.completed protocol event', async () => {
    const ctx = createTestAgent(agentService(IAgentLLMRequesterService, createTimingRequester()));
    try {
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
      await ctx.untilTurnEnd();

      const stepCompleted = ctx.allEvents.find(
        (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
      );
      expect(stepCompleted?.args).toMatchObject({
        llmFirstTokenLatencyMs: 100,
        llmStreamDurationMs: 200,
        llmRequestBuildMs: 30,
        llmServerFirstTokenMs: 70,
        llmServerDecodeMs: 150,
        llmClientConsumeMs: 50,
      });
    } finally {
      await ctx.dispose();
    }
  });
});

describe('aborted step tool execution', () => {
  it('accounts model usage when the step is aborted during tool execution', async () => {
    const ctx = createTestAgent(
      { generate: createAbortedStepGenerate() },
      permissionModeServices('yolo'),
    );
    try {
      const slowToolStarted = registerAbortableWorkTool(ctx);
      const goals = ctx.get(IAgentGoalService);
      await goals.createGoal({ objective: 'finish the task' });
      await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 60 } });
      ctx.get(IEventBus).publish({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } });

      const loopService = ctx.get(IAgentLoopService);
      loopService.enqueue(new ContinuationStepRequest());
      const controller = new AbortController();
      const resultPromise = loopService.run({
        turnId: 1,
        signal: controller.signal,
      });
      await slowToolStarted.promise;
      controller.abort(new Error('cancelled by test'));

      await expect(resultPromise).resolves.toMatchObject({ type: 'cancelled', steps: 2 });
      expect(ctx.get(IAgentUsageService).status()).toMatchObject({
        total: {
          inputOther: 107,
          output: 61,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
        currentTurn: {
          inputOther: 107,
          output: 61,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      });
      expect(goals.getGoal().goal).toMatchObject({
        status: 'blocked',
        tokensUsed: 61,
        budget: { tokenBudgetReached: true },
      });
    } finally {
      await ctx.dispose();
    }
  });

  it('includes the programmatic abort reason when a tool execution is interrupted', async () => {
    const ctx = createTestAgent(
      { generate: createAbortedStepGenerate() },
      permissionModeServices('yolo'),
    );
    let interrupted: { readonly reason: string; readonly message?: string } | undefined;
    const subscription = ctx
      .get(IEventBus)
      .subscribe('turn.step.interrupted', (event) => {
        interrupted = event;
      });

    try {
      const slowToolStarted = registerAbortableWorkTool(ctx);
      const loopService = ctx.get(IAgentLoopService);
      loopService.enqueue(new ContinuationStepRequest());
      const controller = new AbortController();
      const result = loopService.run({
        turnId: 1,
        signal: controller.signal,
      });
      await slowToolStarted.promise;
      controller.abort(new Error('Tool execution timed out'));

      await expect(result).resolves.toMatchObject({ type: 'cancelled', steps: 2 });
      expect(interrupted).toMatchObject({
        reason: 'aborted',
        message: 'Tool execution timed out',
      });
    } finally {
      subscription.dispose();
      await ctx.dispose();
    }
  });
});

function nextTurnMessage(text: string): MessageStepRequest {
  return new MessageStepRequest(
    {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
    { admission: 'newTurn' },
  );
}

function createTimingRequester(): IAgentLLMRequesterService {
  const timing: ModelRequestTiming = {
    firstTokenLatencyMs: 100,
    streamDurationMs: 200,
    requestBuildMs: 30,
    serverFirstTokenMs: 70,
    serverDecodeMs: 150,
    clientConsumeMs: 50,
  };

  const requester: IAgentLLMRequesterService = {
    _serviceBrand: undefined,
    prepareTurnConfig: () => ({ thinkingEffort: 'off' }),
    async request(_overrides, onPart = () => {}) {
      await onPart({ type: 'text', text: 'answer' });
      return {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          toolCalls: [],
        },
        usage: emptyUsage(),
        model: 'mock-model',
        timing,
      };
    },
    start(overrides, onPart, signal) {
      return { trace: { traceId: undefined }, result: this.request(overrides, onPart, signal) };
    },
  };
  return requester;
}

function createAbortedStepGenerate(): GenerateFn {
  const usages = [
    { inputOther: 100, output: 50, inputCacheRead: 0, inputCacheCreation: 0 },
    { inputOther: 7, output: 11, inputCacheRead: 0, inputCacheCreation: 0 },
  ];
  let requestIndex = 0;

  return async () => {
    const usage = usages[requestIndex];
    if (usage === undefined) throw new Error('Unexpected model request');
    requestIndex += 1;
    return {
      id: `response-${String(requestIndex)}`,
      message: {
        role: 'assistant',
        content: [],
        toolCalls: [
          {
            type: 'function',
            id: `call-work-${String(requestIndex)}`,
            name: 'Work',
            arguments: '{}',
          },
        ],
      },
      usage,
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    };
  };
}

function registerAbortableWorkTool(ctx: TestAgentContext): ReturnType<typeof deferred> {
  const slowToolStarted = deferred();
  let executions = 0;
  const tool: ExecutableTool = {
    name: 'Work',
    description: 'Run one fast operation and one cancellable operation.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    resolveExecution: () => ({
      approvalRule: 'Work',
      accesses: [],
      execute: async ({ signal }) => {
        executions += 1;
        if (executions === 1) return { output: 'first step complete' };
        slowToolStarted.resolve();
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          });
        }
        return { output: 'second step cancelled' };
      },
    }),
  };
  ctx.get(IAgentProfileService).update({ activeToolNames: ['Work'] });
  ctx.get(IAgentToolRegistryService).register(tool);
  return slowToolStarted;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
