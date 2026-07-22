import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { testKaos } from '../fixtures/test-kaos';
import { APIStatusError, type Message, type ToolCall } from '@moonshot-ai/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent, AgentOptions } from '../../src/agent';
import { AGENT_WIRE_PROTOCOL_VERSION } from '../../src/agent/records';
import type { KimiConfig } from '../../src/config';
import { FlagResolver } from '../../src/flags';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { ErrorCodes, KimiError } from '../../src/errors';
import { Session } from '../../src/session';
import { collectGitContext } from '../../src/session/git-context';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  SessionSubagentHost,
  formatSubagentTimeoutDescription,
  resolveSubagentTimeoutMs,
  type QueuedSubagentTask,
} from '../../src/session/subagent-host';
import {
  acquireSubagentWorktree,
  type EditingCandidateDraft,
} from '../../src/session/subagent-worktree';
import { resolveSwarmMaxConcurrency } from '../../src/session/subagent-batch';
import { abortError, userCancellationReason } from '../../src/utils/abort';
import { testAgent, type AgentTestContext } from '../agent/harness/agent';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { executeTool } from '../tools/fixtures/execute-tool';

// Git context collection is exercised in git-context.test.ts; here it is
// mocked so subagent-host tests stay deterministic and assert only the
// wiring (explore subagents get the block prepended, others do not).
vi.mock('../../src/session/git-context', () => ({
  collectGitContext: vi.fn(async () => ''),
}));

// Worktree isolation service is exercised in subagent-worktree.test.ts; here
// it is mocked (default: no isolation) so subagent-host tests stay
// deterministic and assert only the wiring in `SessionSubagentHost worktree
// isolation` below.
vi.mock('../../src/session/subagent-worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/session/subagent-worktree')>();
  return {
    ...actual,
    acquireSubagentWorktree: vi.fn(async () => null),
  };
});

// R-C1 wiring check (`SessionSubagentHost circuit breaker` describe block
// below): records the `maxConcurrency` every `SubagentBatch` construction
// received, without changing any behavior (the spy subclass just forwards to
// the real implementation via `super(...)`). Lets the test assert what
// `runQueued()` actually computed and passed through, instead of re-testing
// `SubagentBatch`'s own concurrency enforcement (already covered in
// subagent-batch.test.ts).
const capturedBatchMaxConcurrency: Array<number | undefined> = [];
vi.mock('../../src/session/subagent-batch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/session/subagent-batch')>();
  class SpySubagentBatch<T> extends actual.SubagentBatch<T> {
    constructor(...args: ConstructorParameters<typeof actual.SubagentBatch<T>>) {
      super(...args);
      capturedBatchMaxConcurrency.push(args[2]?.maxConcurrency);
    }
  }
  return { ...actual, SubagentBatch: SpySubagentBatch };
});

const signal = new AbortController().signal;
const tempDirs: string[] = [];
type GenerateFn = NonNullable<AgentOptions['generate']>;

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';

describe('resolveSubagentTimeoutMs', () => {
  const saved: { value: string | undefined } = { value: process.env[SUBAGENT_TIMEOUT_ENV] };
  afterEach(() => {
    if (saved.value === undefined) {
      delete process.env[SUBAGENT_TIMEOUT_ENV];
    } else {
      process.env[SUBAGENT_TIMEOUT_ENV] = saved.value;
    }
  });

  it('returns the default when nothing is set', () => {
    delete process.env[SUBAGENT_TIMEOUT_ENV];
    expect(resolveSubagentTimeoutMs()).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS);
  });

  it('uses the config value when set', () => {
    delete process.env[SUBAGENT_TIMEOUT_ENV];
    expect(resolveSubagentTimeoutMs(600000)).toBe(600000);
  });

  it('lets the env override the config value', () => {
    process.env[SUBAGENT_TIMEOUT_ENV] = '120000';
    expect(resolveSubagentTimeoutMs(600000)).toBe(120000);
  });

  it('ignores an invalid env and falls back to config/default', () => {
    process.env[SUBAGENT_TIMEOUT_ENV] = 'not-a-number';
    expect(resolveSubagentTimeoutMs(600000)).toBe(600000);
    process.env[SUBAGENT_TIMEOUT_ENV] = '-5';
    expect(resolveSubagentTimeoutMs()).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS);
  });

  it('treats 0 as no timeout from both config and env', () => {
    delete process.env[SUBAGENT_TIMEOUT_ENV];
    expect(resolveSubagentTimeoutMs(0)).toBe(0);
    process.env[SUBAGENT_TIMEOUT_ENV] = '0';
    expect(resolveSubagentTimeoutMs(600000)).toBe(0);
  });
});

describe('formatSubagentTimeoutDescription', () => {
  it('formats hours, minutes, seconds and milliseconds', () => {
    expect(formatSubagentTimeoutDescription(30 * 60 * 1000)).toBe('30 minutes');
    expect(formatSubagentTimeoutDescription(2 * 60 * 60 * 1000)).toBe('2 hours');
    expect(formatSubagentTimeoutDescription(45 * 1000)).toBe('45 seconds');
    expect(formatSubagentTimeoutDescription(1500)).toBe('1500 ms');
  });
});

describe('SessionSubagentHost', () => {
  it('emits a suspended event for a requeued child', () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();
    const child = testAgent();
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    host.suspended({
      task: queuedTask(1),
      agentId: 'agent-0',
      reason: 'Provider rate limit; subagent requeued for retry.',
    });

    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.suspended',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          reason: 'Provider rate limit; subagent requeued for retry.',
        }),
      }),
    );
  });

  it('runQueued suppresses raw live Aborted failures from queued attempts', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const running = host.runQueued([{ ...queuedTask(1), signal: controller.signal }]);
    void running.catch(() => {});

    await child.untilApprovalRequest();
    controller.abort(abortError());
    await expect(running).rejects.toThrow('Aborted');
    await child.untilTurnEnd();

    expect(parent.allEvents).not.toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.failed',
        args: expect.objectContaining({
          error: 'Aborted',
        }),
      }),
    );
  });

  it('fires subagent lifecycle hooks around the child turn', async () => {
    const child = testAgent();
    const calls: Array<{ readonly event: string; readonly childLlmCallCount: number }> = [];
    const trigger = vi.fn(async (event: string, _args?: unknown) => {
      calls.push({ event, childLlmCallCount: child.llmCalls.length });
      return [];
    });
    const fireAndForgetTrigger = vi.fn((event: string) => {
      calls.push({ event, childLlmCallCount: child.llmCalls.length });
      return Promise.resolve([]);
    });
    const parent = testAgent({
      hookEngine: { trigger, fireAndForgetTrigger } as unknown as NonNullable<Agent['hooks']>,
    });
    parent.configure();
    parent.newEvents();

    const summary =
      'Implemented the subagent task completely and returned a detailed enough summary for the parent agent to continue confidently without repeating the child agent work. '.repeat(
        2,
      );
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    const startArgs = trigger.mock.calls[0]?.[1];
    expect(trigger.mock.calls[0]?.[0]).toBe('SubagentStart');
    expect(startArgs).toMatchObject({
      matcherValue: 'coder',
      inputData: {
        agentName: 'coder',
        prompt: 'Implement the fix',
      },
    });
    expect((startArgs as { readonly signal?: unknown } | undefined)?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('SubagentStop', {
      matcherValue: 'coder',
      inputData: {
        agentName: 'coder',
        response: summary.trim(),
      },
    });
    expect(calls).toEqual([
      { event: 'SubagentStart', childLlmCallCount: 0 },
      { event: 'SubagentStop', childLlmCallCount: 1 },
    ]);
  });

  it('ignores blocking results from subagent lifecycle hooks', async () => {
    const trigger = vi.fn(async () => [{ action: 'block', reason: 'observer only' }]);
    const fireAndForgetTrigger = vi.fn(() => Promise.resolve([{ action: 'block' }]));
    const parent = testAgent({
      hookEngine: { trigger, fireAndForgetTrigger } as unknown as NonNullable<Agent['hooks']>,
    });
    parent.configure();
    parent.newEvents();

    const summary =
      'Completed the subagent task with enough implementation detail and verification context for the parent agent to continue without repeating the work. '.repeat(
        2,
      );
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({ result: summary.trim() });
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.completed',
        args: expect.objectContaining({ subagentId: 'agent-0' }),
      }),
    );
    expect(parent.allEvents).not.toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.failed',
      }),
    );
  });

  it('marks a queued child ready when the model emits thinking output', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent();
    const summary =
      'Completed the delegated subagent task with enough concrete detail for the parent agent to continue without repeating the work. '.repeat(
        2,
      );
    child.mockNextResponse({ type: 'think', think: 'I can start.' }, { type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');
    const onReady = vi.fn();

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
      onReady,
    });

    await vi.waitFor(() => {
      expect(onReady).toHaveBeenCalledTimes(1);
    });
    await expect(handle.completion).resolves.toMatchObject({ result: summary.trim() });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('runs a child agent turn and returns the last assistant text', async () => {
    const telemetryTrack = vi.fn();
    const parent = testAgent({ telemetry: { track: telemetryTrack } });
    parent.configure();
    await parent.rpc.setPermission({ mode: 'yolo' });
    parent.agent.permission.rules.splice(0, parent.agent.permission.rules.length, {
      decision: 'allow',
      scope: 'session-runtime',
      pattern: 'Read',
    });
    parent.newEvents();

    const child = testAgent({
      type: 'sub',
      permission: { parent: parent.agent.permission },
    });
    child.mockNextResponse({ type: 'text', text: 'Investigated the request and completed the child task end to end. The relevant module was located, its behavior traced through every call site, and the requested change applied and verified against the existing test suite.' });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Find the cause',
      description: 'Find cause',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({
      result: 'Investigated the request and completed the child task end to end. The relevant module was located, its behavior traced through every call site, and the requested change applied and verified against the existing test suite.',
    });
    expect(handle.agentId).toBe('agent-0');
    expect(handle.profileName).toBe('explore');

    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.spawned',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          subagentName: 'explore',
          parentAgentId: 'main',
          parentToolCallId: 'call_agent',
        }),
      }),
    );
    expect(telemetryTrack).toHaveBeenCalledWith('subagent_created', {
      subagent_name: 'explore',
      run_in_background: false,
      agent_id: 'agent-0',
      parent_agent_id: 'main',
      parent_tool_call_id: 'call_agent',
    });
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.completed',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          resultSummary: 'Investigated the request and completed the child task end to end. The relevant module was located, its behavior traced through every call site, and the requested change applied and verified against the existing test suite.',
        }),
      }),
    );
    expect(child.agent.config.data()).toMatchObject({
      cwd: parent.agent.config.cwd,
      provider: parent.agent.config.data().provider,
      profileName: 'explore',
      thinkingEffort: parent.agent.config.thinkingEffort,
    });
    expect(child.agent.config.systemPrompt).toContain('codebase exploration specialist');
    expect(child.agent.permission.mode).toBe('yolo');
    expect(child.agent.permission.rules).toEqual([]);
    expect(child.agent.permission.data().rules).toEqual(parent.agent.permission.rules);
    expect(child.llmCalls[0]?.systemPrompt).toContain('codebase exploration specialist');
    expect(child.llmCalls[0]?.tools.map((tool) => tool.name).toSorted()).toEqual([
      'Bash',
      'Glob',
      'Grep',
      'Read',
    ]);
    expect(child.llmCalls[0]?.history).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Find the cause' }],
      },
    ]);
  });

  it('inherits active parent user tools when spawning a subagent', async () => {
    const parent = testAgent();
    parent.configure();
    await parent.rpc.registerTool(lookupToolRegistration());
    parent.newEvents();

    const summary =
      'Investigated the delegated task thoroughly, used the inherited custom lookup surface where appropriate, and returned a detailed summary that lets the parent agent continue without repeating the work. '.repeat(
        2,
      );
    const child = testAgent();
    child.mockNextResponse({
      type: 'text',
      text: summary,
    });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Use the available lookup tool',
      description: 'Use lookup',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({
      result: summary.trim(),
    });
    expect(child.llmCalls[0]?.tools.map((tool) => tool.name)).toContain('Lookup');
    expect(child.agent.tools.data()).toContainEqual({
      name: 'Lookup',
      description: 'Look up a short test value.',
      active: true,
      source: 'user',
    });

    const lookupTool = child.agent.tools.loopTools.find((tool) => tool.name === 'Lookup');
    expect(lookupTool).toBeDefined();

    const execution = executeTool(lookupTool!, {
      turnId: '0',
      toolCallId: 'call_lookup',
      args: { query: 'moon' },
      signal,
    });
    const routedTo = await Promise.race([
      child.untilToolCall({ output: 'moon-result' }).then(() => 'child'),
      parent.untilToolCall({ output: 'moon-result' }).then(() => 'parent'),
      new Promise<'timeout'>((resolve) => setTimeout(() => {
        resolve('timeout');
      }, 50)),
    ]);

    expect(routedTo).toBe('child');
    await expect(execution).resolves.toMatchObject({ output: 'moon-result' });
  });

  it('falls back to bundled subagent profiles when the parent profile is missing', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'Implemented the requested fix in the target module, updated all affected call sites, and confirmed the change compiles cleanly and passes the existing test suite. No unrelated code paths were touched while making this change.' });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({
      result:
        'Implemented the requested fix in the target module, updated all affected call sites, and confirmed the change compiles cleanly and passes the existing test suite. No unrelated code paths were touched while making this change.',
    });
    expect(child.agent.config.profileName).toBe('coder');
    expect(child.llmCalls[0]?.systemPrompt).toContain('You are now running as a subagent.');
    expect(child.llmCalls[0]?.tools.map((tool) => tool.name).toSorted()).toEqual([
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
      'TaskList',
      'TaskOutput',
      'TaskStop',
      'TodoList',
      'Write',
    ]);
    expect(child.llmCalls[0]?.history).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Implement the fix' }],
      },
    ]);
  });

  it('rejects unknown subagent types before creating a child agent', async () => {
    const parent = testAgent();
    parent.configure();
    const createAgent = vi.fn();
    const host = new SessionSubagentHost(
      {
        agents: new Map([['main', parent.agent]]),
        ensureAgentResumed: vi.fn(async () => parent.agent),
        createAgent,
      } as never,
      'main',
    );

    await expect(
      host.spawn({
        profileName: 'missing',
        parentToolCallId: 'call_agent',
        prompt: 'Find the cause',
        description: 'Find cause',
        runInBackground: false,
        signal,
      }),
    ).rejects.toThrow('Subagent profile "missing" was not found');
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('rejects unavailable subagent profiles even when a same-named fork label exists', async () => {
    const parent = testAgent();
    parent.configure();
    const createAgent = vi.fn();
    const host = new SessionSubagentHost(
      {
        agents: new Map([['main', parent.agent]]),
        ensureAgentResumed: vi.fn(async () => parent.agent),
        createAgent,
      } as never,
      'main',
    );

    await expect(
      host.spawn({
        profileName: 'btw',
        parentToolCallId: 'call_agent',
        prompt: 'Answer a side question',
        description: 'Side question',
        runInBackground: false,
        signal,
      }),
    ).rejects.toThrow('Subagent profile "btw" was not found');
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('cancels the child turn when the caller signal aborts', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: false,
      signal: controller.signal,
    });

    await child.untilApprovalRequest();
    controller.abort();

    await expect(handle.completion).rejects.toThrow('Aborted');
    expect(child.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'turn.cancel',
        args: expect.objectContaining({ turnId: 0 }),
      }),
    );
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.failed',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          error: 'Aborted',
        }),
      }),
    );
  });

  it('cancelAll aborts foreground children', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: false,
      signal,
    });

    await child.untilApprovalRequest();
    host.cancelAll();

    await expect(handle.completion).rejects.toThrow('Aborted');
    expect(child.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'turn.cancel',
        args: expect.objectContaining({ turnId: 0 }),
      }),
    );
  });

  it("tells a cancelled subagent's in-flight tools the user interrupted them", async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: false,
      signal: controller.signal,
    });

    await child.untilApprovalRequest();
    // The parent turn signal aborts with a user-cancellation reason; linkAbortSignal
    // forwards it to the child exactly as Turn.cancel does on a real ESC.
    controller.abort(userCancellationReason());
    await expect(handle.completion).rejects.toThrow();
    await child.untilTurnEnd();

    const output = childBashToolResultOutput(child);
    expect(output).toContain('manually interrupted');
    expect(output).toContain('not a system error');
  });

  it('does not mislabel a non-user subagent abort (e.g. a deadline) as a user interruption', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: false,
      signal: controller.signal,
    });

    await child.untilApprovalRequest();
    // A generic (non-user) abort — e.g. a foreground subagent's deadline timeout
    // propagating through waitForCurrentTurn — must NOT be reported to the
    // child's tools as a deliberate user interruption.
    controller.abort(abortError());
    await expect(handle.completion).rejects.toThrow();
    await child.untilTurnEnd();

    const output = childBashToolResultOutput(child);
    expect(output).toBe('Tool "Bash" was aborted');
    expect(output).not.toContain('manually interrupted');
  });

  it('cancelAll leaves background children running until their task signal aborts', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const backgroundController = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: true,
      signal: backgroundController.signal,
    });

    await child.untilApprovalRequest();
    host.cancelAll();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(child.agent.turn.hasActiveTurn).toBe(true);
    expect(child.allEvents).not.toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'turn.cancel',
        args: expect.objectContaining({ turnId: 0 }),
      }),
    );

    backgroundController.abort();

    await expect(handle.completion).rejects.toThrow('Aborted');
    expect(child.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'turn.cancel',
        args: expect.objectContaining({ turnId: 0 }),
      }),
    );
  });

  it('re-prompts the child when the first summary is too short', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const longSummary = 'Detailed findings: '.repeat(20);
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'done' });
    child.mockNextResponse({ type: 'text', text: longSummary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Investigate',
      description: 'Investigate',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({ result: longSummary.trim() });
    expect(child.llmCalls).toHaveLength(2);
    expect(child.llmCalls[1]?.history.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('too brief') }],
    });
  });

  it('fails the child instead of re-prompting when the response is truncated', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent();
    child.mockNextProviderResponse({
      parts: [
        { type: 'think', think: 'The child used its output budget before writing a summary.' },
      ],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Investigate',
      description: 'Investigate',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).rejects.toThrow(
      'Subagent turn failed before completing its final summary: reason=max_tokens',
    );
    expect(child.llmCalls).toHaveLength(1);
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.failed',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          error: expect.stringContaining(
            'Subagent turn failed before completing its final summary: reason=max_tokens',
          ),
        }),
      }),
    );
    expect(parent.allEvents).not.toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.completed',
      }),
    );
  });

  it('does not re-prompt when the first summary is long enough', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const longSummary = 'Comprehensive technical summary. '.repeat(10);
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: longSummary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Investigate',
      description: 'Investigate',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({ result: longSummary.trim() });
    expect(child.llmCalls).toHaveLength(1);
  });

  it('prepends git context to the prompt for explore subagents', async () => {
    vi.mocked(collectGitContext).mockResolvedValueOnce(
      '<git-context>\nWorking directory: /repo\nBranch: main\n</git-context>',
    );
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const summary =
      'Explored the repository thoroughly and reported the findings in a complete and detailed summary that gives the parent agent everything it needs to continue the work without redoing the investigation all over again.';
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Find the cause',
      description: 'Find cause',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    expect(child.llmCalls[0]?.history[0]).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<git-context>\nWorking directory: /repo\nBranch: main\n</git-context>\n\nFind the cause',
        },
      ],
    });
  });

  it('does not prepend git context for non-explore subagents', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const summary =
      'Implemented the requested change in full and verified it against the existing test suite, leaving a thorough and complete summary so the parent agent can proceed without repeating any of the finished investigation work.';
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    expect(child.llmCalls[0]?.history[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'Implement the fix' }],
    });
  });

  it('resumes an idle child agent by id', async () => {
    const parent = testAgent();
    parent.configure();
    parent.agent.permission.setMode('yolo');

    const child = testAgent({
      type: 'sub',
      permission: { parent: parent.agent.permission },
    });
    child.configure({ tools: ['Read'] });
    child.agent.useProfile(
      profile({ name: 'explore', tools: ['Read'], systemPrompt: 'explore prompt' }),
    );
    child.agent.context.appendUserMessage([{ type: 'text', text: 'Earlier context' }]);
    child.mockNextResponse({
      type: 'text',
      text: 'Resumed the subagent from its earlier context and carried the task through to completion, then reported a full and detailed technical summary so the parent agent can continue without repeating prior work.',
    });
    vi.mocked(collectGitContext).mockReset().mockResolvedValue('');

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': {
        homedir: '/tmp/kimi-session/agents/agent-0',
        type: 'sub',
        parentAgentId: 'main',
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.resume('agent-0', {
      parentToolCallId: 'call_agent',
      prompt: 'Continue from context',
      description: 'Continue work',
      runInBackground: false,
      signal,
    });

    expect(handle).toMatchObject({
      agentId: 'agent-0',
      profileName: 'explore',
      resumed: true,
    });
    await expect(handle.completion).resolves.toMatchObject({
      result:
        'Resumed the subagent from its earlier context and carried the task through to completion, then reported a full and detailed technical summary so the parent agent can continue without repeating prior work.',
    });
    expect(session.createAgent).not.toHaveBeenCalled();
    expect(child.agent.permission.mode).toBe('yolo');
    expect(child.lastLlmInput()).toMatchInlineSnapshot(`
      system: "explore prompt"
      tools: Read
      messages:
        user: text "Earlier context"
        user: text "Continue from context"
    `);
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.spawned',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          subagentName: 'explore',
          parentToolCallId: 'call_agent',
        }),
      }),
    );
  });

  it('runQueued resumes tasks that carry an existing agent id', async () => {
    const parent = testAgent();
    parent.configure();

    const child = testAgent({ type: 'sub' });
    child.configure();
    child.agent.useProfile(
      profile({ name: 'coder', tools: [], systemPrompt: 'coder prompt' }),
    );
    child.agent.context.appendUserMessage([{ type: 'text', text: 'Earlier swarm context' }]);
    const summary =
      'Resumed the queued swarm subagent from its prior context, completed the missing work, and returned a detailed enough handoff for the parent to proceed without starting over. '.repeat(
        2,
      );
    child.mockNextResponse({ type: 'text', text: summary });

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': {
        homedir: '/tmp/kimi-session/agents/agent-0',
        type: 'sub',
        parentAgentId: 'main',
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    await expect(
      host.runQueued(
        [
          {
            ...queuedTask(1),
            kind: 'resume',
            prompt: 'Continue the previous swarm task',
            resumeAgentId: 'agent-0',
            signal,
          },
        ],
      ),
    ).resolves.toMatchObject([
      {
        agentId: 'agent-0',
        status: 'completed',
        result: summary.trim(),
      },
    ]);

    expect(session.createAgent).not.toHaveBeenCalled();
    expect(userTextMessages(child.llmCalls[0]?.history ?? [])).toEqual([
      'Earlier swarm context',
      'Continue the previous swarm task',
    ]);
  });

  it('runQueued persists swarm item metadata for spawned tasks', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent({ type: 'sub' });
    child.configure();
    const summary =
      'Completed the queued swarm item and returned a detailed technical handoff so the parent can map the result back to the original swarm input. '.repeat(
        2,
      );
    child.mockNextResponse({ type: 'text', text: summary });

    const metadataAgents: Session['metadata']['agents'] = {};
    const session = fakeSession(parent.agent, child.agent, metadataAgents);
    const host = new SessionSubagentHost(session, 'main');

    await expect(
      host.runQueued([{ ...queuedTask(1), swarmItem: 'src/a.ts', signal }]),
    ).resolves.toMatchObject([
      {
        agentId: 'agent-0',
        status: 'completed',
        result: summary.trim(),
      },
    ]);

    expect(session.createAgent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        parentAgentId: 'main',
        swarmItem: 'src/a.ts',
      }),
    );
    expect(metadataAgents['agent-0']).toMatchObject({
      type: 'sub',
      parentAgentId: 'main',
      swarmItem: 'src/a.ts',
    });
    expect(host.getSwarmItem('agent-0')).toBe('src/a.ts');
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.spawned',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          parentToolCallId: 'call_swarm',
          swarmIndex: 1,
        }),
      }),
    );
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.started',
        args: expect.objectContaining({
          subagentId: 'agent-0',
        }),
      }),
    );
  });

  it('retries a rate-limited child turn without appending the original prompt again', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const summary =
      'Recovered from a provider rate limit by retrying the latest subagent step with the original context intact, then completed the delegated work with a detailed enough summary for the parent to continue confidently. '.repeat(
        2,
      );
    const histories: Message[][] = [];
    let generateCalls = 0;
    const generate: GenerateFn = async (
      _provider,
      _systemPrompt,
      _tools,
      history,
      callbacks,
    ) => {
      histories.push(structuredClone(history));
      generateCalls += 1;
      if (generateCalls === 1) {
        throw new APIStatusError(429, 'Rate limited', 'req-429');
      }
      await callbacks?.onMessagePart?.({ type: 'text', text: summary });
      return textResult(summary);
    };
    const child = testAgent({
      generate,
      initialConfig: {
        providers: {},
        loopControl: { maxRetriesPerStep: 1 },
      },
    });
    child.configure();

    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the retry-safe change',
      description: 'Fix rate-limit retry',
      runInBackground: false,
      signal,
    });
    await expect(handle.completion).rejects.toThrow('Rate limited');

    const retryHandle = await host.retry(handle.agentId, {
      parentToolCallId: 'call_agent',
      prompt: 'Implement the retry-safe change',
      description: 'Fix rate-limit retry',
      runInBackground: false,
      signal,
    });

    await expect(retryHandle.completion).resolves.toMatchObject({ result: summary.trim() });
    expect(generateCalls).toBe(2);
    expect(userTextMessages(histories[1] ?? [])).toEqual(['Implement the retry-safe change']);
  });

  it('realigns a resumed subagent to the parent agent current model', async () => {
    const parent = testAgent();
    parent.configure();
    parent.agent.permission.setMode('yolo');

    const child = testAgent();
    child.configure({ tools: ['Read'] });
    // The child was originally spawned with a model that no longer matches the
    // parent agent's current model (as if the parent ran setModel afterwards).
    child.agent.config.update({ modelAlias: 'stale-model-from-initial-spawn' });
    child.agent.useProfile(
      profile({ name: 'explore', tools: ['Read'], systemPrompt: 'explore prompt' }),
    );
    child.agent.context.appendUserMessage([{ type: 'text', text: 'Earlier context' }]);
    child.mockNextResponse({
      type: 'text',
      text: 'Resumed the subagent from its earlier context and carried the task through to completion, then reported a full and detailed technical summary so the parent agent can continue without repeating prior work.',
    });

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': {
        homedir: '/tmp/kimi-session/agents/agent-0',
        type: 'sub',
        parentAgentId: 'main',
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.resume('agent-0', {
      parentToolCallId: 'call_agent',
      prompt: 'Continue from context',
      description: 'Continue work',
      runInBackground: false,
      signal,
    });

    await handle.completion;
    // resume must realign the child to the parent agent's current model rather
    // than leave it on the stale model from its initial spawn.
    expect(child.agent.config.modelAlias).toBe(parent.agent.config.modelAlias);
    expect(child.agent.config.modelAlias).not.toBe('stale-model-from-initial-spawn');
  });
});

describe('SessionSubagentHost worktree isolation', () => {
  afterEach(() => {
    vi.mocked(acquireSubagentWorktree).mockReset().mockResolvedValue(null);
  });

  it('does not attempt isolation when the experimental flag is disabled (default)', async () => {
    const parent = testAgent();
    parent.configure();

    const child = testAgent();
    child.configure();
    const summary =
      'Implemented the requested change in full and verified it against the existing test suite, leaving a thorough and complete summary so the parent agent can proceed without repeating any of the finished investigation work.';
    child.mockNextResponse({ type: 'text', text: summary });

    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    expect(acquireSubagentWorktree).not.toHaveBeenCalled();
    expect(child.agent.config.cwd).toBe(parent.agent.config.cwd);
  });

  it('does not attempt isolation for a non-editing-capable profile even when the flag is enabled', async () => {
    const parent = testAgent({
      experimentalFlags: new FlagResolver({
        KIMI_CODE_EXPERIMENTAL_SUBAGENT_WORKTREE_ISOLATION: 'true',
      }),
    });
    parent.configure();

    const child = testAgent();
    child.configure({ tools: ['Read'] });
    child.mockNextResponse({
      type: 'text',
      text: 'Explored the codebase thoroughly and reported back a detailed enough summary of the relevant files and structure for the parent agent to proceed with confidence, covering every directory that mattered for this investigation and calling out the pieces most relevant to the follow-up work.',
    });

    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Look around',
      description: 'Explore',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    expect(acquireSubagentWorktree).not.toHaveBeenCalled();
  });

  it('runs an editing-capable internal subagent in the isolated worktree cwd and finishes it on success', async () => {
    const parent = testAgent({
      experimentalFlags: new FlagResolver({
        KIMI_CODE_EXPERIMENTAL_SUBAGENT_WORKTREE_ISOLATION: 'true',
      }),
    });
    parent.configure();

    const child = testAgent();
    child.configure();
    const summary =
      'Implemented the requested change inside the isolated worktree and verified it against the existing test suite, leaving a thorough and complete summary so the parent agent can proceed without repeating any of the finished investigation work.';
    child.mockNextResponse({ type: 'text', text: summary });

    const finish = vi.fn(async () => ({ applied: true }));
    const isolatedCwd = '/tmp/kimi-subagent-worktree/isolated-cwd';
    vi.mocked(acquireSubagentWorktree).mockResolvedValue({ cwd: isolatedCwd, finish });

    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    expect(acquireSubagentWorktree).toHaveBeenCalledWith(
      parent.agent.kaos,
      parent.agent.config.cwd,
      expect.objectContaining({ scope: undefined }),
    );
    expect(child.agent.config.cwd).toBe(isolatedCwd);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({ kind: 'success' });
  });

  it('returns an internal scope-expansion candidate without cleaning up or reporting failure', async () => {
    const parent = testAgent({
      experimentalFlags: new FlagResolver({
        KIMI_CODE_EXPERIMENTAL_SUBAGENT_WORKTREE_ISOLATION: 'true',
      }),
    });
    parent.configure();
    parent.newEvents();

    const child = testAgent();
    child.configure();
    const summary =
      'Implemented the requested source change and its necessary companion test inside the isolated worktree, preserving a detailed handoff while waiting for explicit approval of the expanded file scope. The candidate remains intact with its original baseline, final payloads, and verification details so the background task can persist it without asking the provider to run again.';
    child.mockNextResponse({ type: 'text', text: summary });

    const candidate = editingCandidateDraft();
    const acknowledgePersisted = vi.fn(async () => {});
    const finish = vi.fn(async () => ({
      applied: false,
      reason: 'scope-expansion-required',
      outsideScope: ['test/widget.test.ts'],
      candidate,
      acknowledgePersisted,
    }));
    vi.mocked(acquireSubagentWorktree).mockResolvedValue({
      cwd: '/tmp/kimi-subagent-worktree/internal-candidate',
      finish,
    });
    const host = new SessionSubagentHost(fakeSession(parent.agent, child.agent), 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      parentToolCallUuid: 'logical-run-internal',
      prompt: 'Implement the source and test change',
      description: 'Implement widget',
      runInBackground: true,
      signal,
      dispatch: { scope: ['src/widget.ts'] },
    });

    await expect(handle.completion).resolves.toMatchObject({
      result: summary,
      editingCandidate: {
        draft: candidate,
        agentId: handle.agentId,
        logicalRunId: 'logical-run-internal',
        originalScope: ['src/widget.ts'],
        requestedScope: ['src/widget.ts', 'test/widget.test.ts'],
        outsideScope: ['test/widget.test.ts'],
      },
    });
    expect(acknowledgePersisted).not.toHaveBeenCalled();
    expect(parent.allEvents).not.toContainEqual(
      expect.objectContaining({ type: '[rpc]', event: 'subagent.failed' }),
    );
    expect(parent.allEvents).not.toContainEqual(
      expect.objectContaining({ type: '[rpc]', event: 'subagent.completed' }),
    );
  });

  it('finishes the isolated worktree as incomplete when the child turn is aborted', async () => {
    const parent = testAgent({
      experimentalFlags: new FlagResolver({
        KIMI_CODE_EXPERIMENTAL_SUBAGENT_WORKTREE_ISOLATION: 'true',
      }),
    });
    parent.configure();
    parent.newEvents();

    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());

    const finish = vi.fn(async () => ({ applied: false, reason: 'incomplete' }));
    vi.mocked(acquireSubagentWorktree).mockResolvedValue({ cwd: '/tmp/kimi-subagent-worktree/isolated', finish });

    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: false,
      signal: controller.signal,
    });

    await child.untilApprovalRequest();
    controller.abort(userCancellationReason());
    await expect(handle.completion).rejects.toThrow();

    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({ kind: 'incomplete' });
  });

  it('discards an analysis-only internal worktree when the child turn is aborted', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();
    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will inspect a file.' }, bashCall());

    const finish = vi.fn(async () => ({ applied: false, reason: 'discarded' }));
    vi.mocked(acquireSubagentWorktree).mockResolvedValue({
      cwd: '/tmp/kimi-subagent-worktree/analysis-only',
      finish,
    });
    const host = new SessionSubagentHost(fakeSession(parent.agent, child.agent), 'main');
    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_analysis',
      prompt: 'Analyze only',
      description: 'Analysis',
      runInBackground: false,
      signal: controller.signal,
      dispatch: { discardChanges: true },
    });

    await child.untilApprovalRequest();
    controller.abort(userCancellationReason());
    await expect(handle.completion).rejects.toThrow();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({
      kind: 'discard',
      reason: 'analysis-only subagent delta discarded after failure',
    });
  });

  it('fails closed before spawning a read-only external backend without an enforced launcher', async () => {
    const parent = testAgent();
    parent.configure();
    const session = fakeSession(parent.agent, parent.agent, {}, {
      providers: {},
      subagent: {
        backends: {
          external: { command: process.execPath, args: ['-e', "process.stdout.write('UNSAFE')"] },
        },
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    await expect(host.spawn({
      profileName: 'agora-peer',
      parentToolCallId: 'call_agora',
      prompt: 'Review only',
      description: 'Agora peer review',
      runInBackground: false,
      signal,
      dispatch: {
        readOnly: true,
        discardChanges: true,
        workCard: {
          id: 'agora-external',
          title: 'External peer',
          goal: 'Review without side effects',
          acceptance: 'Return review',
          routeOverride: { backend: 'external', model: 'Opus 4.8' },
        },
      },
      enforceDispatch: true,
    })).rejects.toThrow('read_only_launcher');
    expect(acquireSubagentWorktree).not.toHaveBeenCalled();
  });

  it('redacts external backend stderr before writing the session log', async () => {
    const secret = 'SUPERSECRET_LOG_STDERR_666666';
    const parent = testAgent();
    parent.configure();
    const session = fakeSession(parent.agent, parent.agent, {}, {
      providers: {},
      subagent: {
        backends: {
          external: {
            command: process.execPath,
            args: ['-e', `process.stderr.write('api_key=${secret}');process.stdout.write('done')`],
          },
        },
      },
    });
    const warn = vi.fn();
    Object.assign(session, { log: { warn } });
    const host = new SessionSubagentHost(session, 'main');
    const handle = await host.spawn({
      profileName: 'explore',
      modelAlias: 'external-model',
      parentToolCallId: 'call_external_log',
      prompt: 'Inspect',
      description: 'External inspect',
      runInBackground: false,
      signal,
      dispatch: {
        workCard: {
          id: 'external-log',
          title: 'External log',
          goal: 'Inspect',
          acceptance: 'Return output',
          routeOverride: { backend: 'external', model: 'external-model' },
        },
      },
    });

    await expect(handle.completion).resolves.toMatchObject({ result: 'done' });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('[REDACTED_SECRET]');
    expect(logged).not.toContain(secret);
  });

  it('returns an external scope-expansion candidate without retrying or cleaning up', async () => {
    const parent = testAgent({
      experimentalFlags: new FlagResolver({
        KIMI_CODE_EXPERIMENTAL_SUBAGENT_WORKTREE_ISOLATION: 'true',
      }),
    });
    parent.configure();
    parent.newEvents();
    const candidate = editingCandidateDraft();
    const acknowledgePersisted = vi.fn(async () => {});
    const finish = vi.fn(async () => ({
      applied: false,
      reason: 'scope-expansion-required',
      outsideScope: ['test/widget.test.ts'],
      candidate,
      acknowledgePersisted,
    }));
    vi.mocked(acquireSubagentWorktree).mockResolvedValue({ cwd: process.cwd(), finish });
    const session = fakeSession(parent.agent, parent.agent, {}, {
      providers: {},
      subagent: {
        backends: {
          external: {
            command: process.execPath,
            args: ['-e', "process.stdout.write('external handoff preserved')"],
            resumeArgs: ['-e', "process.stdout.write('unexpected resume')", '{session_id}'],
          },
        },
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_external_candidate',
      parentToolCallUuid: 'logical-run-external',
      prompt: 'Implement the source and test change',
      description: 'External widget implementation',
      runInBackground: true,
      signal,
      dispatch: {
        scope: ['src/widget.ts'],
        workCard: {
          id: 'external-candidate',
          title: 'External candidate',
          goal: 'Implement source and test',
          acceptance: 'Return a complete handoff',
          routeOverride: { backend: 'external' },
        },
      },
      enforceDispatch: true,
    });

    const externalSessionId = session.metadata.agents[handle.agentId]?.externalSessionId;
    await expect(handle.completion).resolves.toMatchObject({
      result: 'external handoff preserved',
      editingCandidate: {
        draft: candidate,
        agentId: handle.agentId,
        logicalRunId: 'logical-run-external',
        externalSessionId,
        originalScope: ['src/widget.ts'],
        requestedScope: ['src/widget.ts', 'test/widget.test.ts'],
        outsideScope: ['test/widget.test.ts'],
      },
    });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(acknowledgePersisted).not.toHaveBeenCalled();
    expect(parent.allEvents).not.toContainEqual(
      expect.objectContaining({ type: '[rpc]', event: 'subagent.failed' }),
    );
    expect(parent.allEvents).not.toContainEqual(
      expect.objectContaining({ type: '[rpc]', event: 'subagent.completed' }),
    );
  });

  it('uses dedicated read-only args for spawn, resume, and restart with one external session', async () => {
    const echoArgsScript =
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(process.argv.slice(1).join('|')))";
    const parent = testAgent();
    parent.configure();
    const finish = vi.fn(async () => ({
      applied: false,
      reason: 'analysis-only subagent delta discarded',
    }));
    vi.mocked(acquireSubagentWorktree).mockResolvedValue({ cwd: process.cwd(), finish });
    const session = fakeSession(parent.agent, parent.agent, {}, {
      providers: {},
      subagent: {
        backends: {
          external: {
            command: process.execPath,
            args: ['-e', echoArgsScript, 'GENERAL'],
            resumeArgs: ['-e', echoArgsScript, 'GENERAL_RESUMED', '{session_id}'],
            readOnlyLauncher: {
              command: process.execPath,
              args: [
                '-e',
                echoArgsScript,
                'READ_ONLY_SPAWN',
                'CLAUDE_TOOLS_DISABLED',
                'GROK_SANDBOX_READ_ONLY',
                '{session_id}',
              ],
              resumeArgs: [
                '-e',
                echoArgsScript,
                'READ_ONLY_RESUME',
                'CLAUDE_TOOLS_DISABLED',
                'GROK_SANDBOX_READ_ONLY',
                '{session_id}',
              ],
              sandbox: { filesystem: 'read_only', network: 'none' },
            },
          },
        },
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'agora-peer',
      parentToolCallId: 'call_agora',
      prompt: 'Review only',
      description: 'Agora peer review',
      runInBackground: false,
      signal,
      dispatch: {
        readOnly: true,
        discardChanges: true,
        scope: ['**/*'],
        workCard: {
          id: 'agora-external',
          title: 'External peer',
          goal: 'Review without side effects',
          acceptance: 'Return review',
          routeOverride: { backend: 'external', model: 'Opus 4.8' },
        },
      },
      enforceDispatch: true,
    });

    const externalSessionId = session.metadata.agents[handle.agentId]?.externalSessionId;
    expect(externalSessionId).toEqual(expect.any(String));
    expect(handle.resumable).toBe(true);
    await expect(handle.completion).resolves.toEqual({
      result: `READ_ONLY_SPAWN|CLAUDE_TOOLS_DISABLED|GROK_SANDBOX_READ_ONLY|${externalSessionId}`,
    });

    const resumed = await host.resume(handle.agentId, {
      parentToolCallId: 'call_agora_resume',
      prompt: 'Repair the response contract',
      description: 'Agora peer repair',
      runInBackground: false,
      signal,
    });
    await expect(resumed.completion).resolves.toEqual({
      result: `READ_ONLY_RESUME|CLAUDE_TOOLS_DISABLED|GROK_SANDBOX_READ_ONLY|${externalSessionId}`,
    });

    const restarted = await host.retry(handle.agentId, {
      parentToolCallId: 'call_agora_restart',
      prompt: 'Restart after a transient failure',
      description: 'Agora peer restart',
      runInBackground: false,
      signal,
    });
    await expect(restarted.completion).resolves.toEqual({
      result: `READ_ONLY_RESUME|CLAUDE_TOOLS_DISABLED|GROK_SANDBOX_READ_ONLY|${externalSessionId}`,
    });
    expect(session.metadata.agents[handle.agentId]).toMatchObject({
      externalReadOnly: true,
      externalSessionId,
    });
    expect(acquireSubagentWorktree).toHaveBeenCalledWith(
      parent.agent.kaos,
      parent.agent.config.cwd,
      { scope: ['**/*'] },
    );
    expect(finish).toHaveBeenCalledTimes(3);
    expect(finish).toHaveBeenLastCalledWith({
      kind: 'discard',
      reason: 'analysis-only subagent delta discarded',
    });
  });

  it('marks read-only handles without dedicated resume args non-resumable and fails closed', async () => {
    const readStdinScript =
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('READ_ONLY'))";
    const parent = testAgent();
    parent.configure();
    const finish = vi.fn(async () => ({
      applied: false,
      reason: 'analysis-only subagent delta discarded',
    }));
    vi.mocked(acquireSubagentWorktree).mockResolvedValue({ cwd: process.cwd(), finish });
    const session = fakeSession(parent.agent, parent.agent, {}, {
      providers: {},
      subagent: {
        backends: {
          external: {
            command: process.execPath,
            resumeArgs: ['-e', readStdinScript],
            readOnlyLauncher: {
              command: process.execPath,
              args: ['-e', readStdinScript, 'CLAUDE_TOOLS_DISABLED'],
              sandbox: { filesystem: 'read_only' },
            },
          },
        },
      },
    });
    const host = new SessionSubagentHost(session, 'main');
    const handle = await host.spawn({
      profileName: 'agora-peer',
      parentToolCallId: 'call_agora',
      prompt: 'Review only',
      description: 'Agora peer review',
      runInBackground: false,
      signal,
      dispatch: {
        readOnly: true,
        discardChanges: true,
        workCard: {
          id: 'agora-external',
          title: 'External peer',
          goal: 'Review without side effects',
          acceptance: 'Return review',
          routeOverride: { backend: 'external' },
        },
      },
      enforceDispatch: true,
    });
    await expect(handle.completion).resolves.toEqual({ result: 'READ_ONLY' });
    expect(handle.resumable).toBe(false);

    const resumeOptions = {
      parentToolCallId: 'call_agora_resume',
      prompt: 'Continue the review',
      description: 'Agora peer resume',
      runInBackground: false,
      signal,
    };
    await expect(host.resume(handle.agentId, resumeOptions)).rejects.toThrow(
      'read_only_launcher.resume_args; this handle is non-resumable',
    );
    await expect(host.retry(handle.agentId, resumeOptions)).rejects.toThrow(
      'read_only_launcher.resume_args; this handle is non-resumable',
    );
  });
});

describe('SessionSubagentHost external retry', () => {
  async function makeCounterFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-subagent-retry-'));
    tempDirs.push(dir);
    return join(dir, 'attempts');
  }

  // Fails the first `failCount` spawns (non-zero exit), then succeeds and
  // echoes its own argv (minus the node binary) so tests can see which arg
  // set / session id the surviving attempt actually used.
  // Note: no curly braces allowed anywhere in this script string —
  // `validateBackendTemplate` scans every backend arg for `{...}` and
  // rejects anything that is not one of its known placeholders.
  function retryScript(counterFile: string, failCount: number): string {
    const file = JSON.stringify(counterFile);
    return (
      `const fs=require('fs');` +
      `const n=fs.existsSync(${file})?(parseInt(fs.readFileSync(${file},'utf8'),10)||0):0;` +
      `fs.writeFileSync(${file},String(n+1));` +
      `n<${failCount}?(process.stderr.write('boom-'+n),process.exit(1)):process.stdout.write('OK:'+process.argv.slice(1).join('|'))`
    );
  }

  function failedEventArgs(
    events: readonly unknown[],
  ): Array<{ attempt?: number; exhausted?: boolean }> {
    return events
      .filter(
        (entry): entry is { type: string; event: string; args: { attempt?: number; exhausted?: boolean } } =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as { event?: string }).event === 'subagent.failed',
      )
      .map((entry) => ({ attempt: entry.args.attempt, exhausted: entry.args.exhausted }));
  }

  it('retries a transient external exit and resumes the same session once the launcher supports resume', async () => {
    const counterFile = await makeCounterFile();
    const script = retryScript(counterFile, 2);
    const parent = testAgent();
    parent.configure();
    parent.newEvents();
    const session = fakeSession(parent.agent, parent.agent, {}, {
      providers: {},
      subagent: {
        backends: {
          external: {
            command: process.execPath,
            args: ['-e', script, 'FRESH'],
            resumeArgs: ['-e', script, 'RESUMED', '{session_id}'],
          },
        },
      },
    });
    Object.assign(session, { log: { warn: vi.fn() } });
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_retry_resume',
      prompt: 'Review only',
      description: 'External retry with resume',
      runInBackground: false,
      signal,
      dispatch: {
        workCard: {
          id: 'external-retry-resume',
          title: 'External retry',
          goal: 'Retry then resume',
          acceptance: 'Return output',
          routeOverride: { backend: 'external' },
        },
      },
    });

    const externalSessionId = session.metadata.agents[handle.agentId]?.externalSessionId;
    await expect(handle.completion).resolves.toEqual({
      result: `OK:RESUMED|${externalSessionId}`,
    });

    const failed = failedEventArgs(parent.allEvents);
    expect(failed).toEqual([
      { attempt: 1, exhausted: false },
      { attempt: 2, exhausted: false },
    ]);
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({ type: '[rpc]', event: 'subagent.completed' }),
    );
  }, 10_000);

  it('falls back to a fresh spawn under a new session id when the launcher has no resume args', async () => {
    const counterFile = await makeCounterFile();
    const script = retryScript(counterFile, 1);
    const parent = testAgent();
    parent.configure();
    parent.newEvents();
    const session = fakeSession(parent.agent, parent.agent, {}, {
      providers: {},
      subagent: {
        backends: {
          external: {
            command: process.execPath,
            args: ['-e', script, 'FRESH', '{session_id}'],
          },
        },
      },
    });
    Object.assign(session, { log: { warn: vi.fn() } });
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_retry_fresh',
      prompt: 'Review only',
      description: 'External retry without resume',
      runInBackground: false,
      signal,
      dispatch: {
        workCard: {
          id: 'external-retry-fresh',
          title: 'External retry',
          goal: 'Retry with a fresh spawn',
          acceptance: 'Return output',
          routeOverride: { backend: 'external' },
        },
      },
    });

    const originalSessionId = session.metadata.agents[handle.agentId]?.externalSessionId;
    const result = await handle.completion;
    expect(result.result.startsWith('OK:FRESH|')).toBe(true);
    const finalSessionId = result.result.slice('OK:FRESH|'.length);
    expect(finalSessionId).not.toBe(originalSessionId);

    expect(failedEventArgs(parent.allEvents)).toEqual([{ attempt: 1, exhausted: false }]);
  }, 10_000);

  it('throws a structured agent.not_resumable error once the retry budget is exhausted, preserving worktree state', async () => {
    const counterFile = await makeCounterFile();
    const script = retryScript(counterFile, 999);
    const parent = testAgent();
    parent.configure();
    parent.newEvents();
    const finish = vi.fn(async () => ({ applied: false, reason: 'incomplete' }));
    vi.mocked(acquireSubagentWorktree).mockResolvedValue({ cwd: process.cwd(), finish });
    const session = fakeSession(parent.agent, parent.agent, {}, {
      providers: {},
      subagent: {
        backends: {
          external: { command: process.execPath, args: ['-e', script, 'FRESH'] },
        },
      },
    });
    Object.assign(session, { log: { warn: vi.fn() } });
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_retry_exhausted',
      prompt: 'Implement the fix',
      description: 'External retry exhausted',
      runInBackground: false,
      signal,
      dispatch: {
        discardChanges: true,
        workCard: {
          id: 'external-retry-exhausted',
          title: 'External retry',
          goal: 'Exhaust the retry budget',
          acceptance: 'Return output',
          routeOverride: { backend: 'external' },
        },
      },
    });

    await expect(handle.completion).rejects.toMatchObject({
      code: ErrorCodes.AGENT_NOT_RESUMABLE,
    });

    const failed = failedEventArgs(parent.allEvents);
    expect(failed).toEqual([
      { attempt: 1, exhausted: false },
      { attempt: 2, exhausted: false },
      { attempt: 3, exhausted: false },
      { attempt: 4, exhausted: true },
    ]);
    // Cleanup runs once for the whole retry sequence, not once per attempt.
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({
      kind: 'discard',
      reason: 'analysis-only subagent delta discarded after failure',
    });
  }, 15_000);

  it('does not retry when the caller aborts, and reports the failure exactly once', async () => {
    const counterFile = await makeCounterFile();
    const script = retryScript(counterFile, 999);
    const parent = testAgent();
    parent.configure();
    parent.newEvents();
    const controller = new AbortController();
    const session = fakeSession(parent.agent, parent.agent, {}, {
      providers: {},
      subagent: {
        backends: {
          external: { command: process.execPath, args: ['-e', script, 'FRESH'] },
        },
      },
    });
    Object.assign(session, { log: { warn: vi.fn() } });
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_retry_abort',
      prompt: 'Review only',
      description: 'External retry aborted mid-backoff',
      runInBackground: false,
      signal: controller.signal,
      dispatch: {
        workCard: {
          id: 'external-retry-abort',
          title: 'External retry',
          goal: 'Abort mid-backoff',
          acceptance: 'Return output',
          routeOverride: { backend: 'external' },
        },
      },
    });

    // Let the first attempt fail and enter the backoff delay, then abort
    // before the second attempt would fire.
    await vi.waitFor(async () => {
      const fs = await import('node:fs/promises');
      const contents = await fs.readFile(counterFile, 'utf8').catch(() => '0');
      expect(Number(contents)).toBeGreaterThanOrEqual(1);
    });
    controller.abort(userCancellationReason());

    await expect(handle.completion).rejects.toThrow();

    const fs = await import('node:fs/promises');
    const attemptsMade = Number(await fs.readFile(counterFile, 'utf8').catch(() => '0'));
    expect(attemptsMade).toBe(1);
    expect(failedEventArgs(parent.allEvents)).toHaveLength(1);
  }, 10_000);
});

describe('SessionSubagentHost route pools', () => {
  const CONTINUATION_SAFE_SUMMARY_SUFFIX =
    ' The summary stays long enough to skip the automatic continuation retry that pads overly short subagent handoffs before returning them to the parent, since anything under two hundred characters triggers one extra follow-up turn asking for more detail.';

  it('rotates coder spawns across a weighted pool of routes and releases slots on completion', async () => {
    const config: KimiConfig = {
      providers: {},
      models: {
        fast: { provider: 'local', model: 'fast-model', maxContextSize: 128000 },
        precise: { provider: 'local', model: 'precise-model', maxContextSize: 128000 },
      },
      subagent: {
        pools: {
          coder: [
            { backend: 'kimi', model: 'fast', thinkingEffort: 'low', weight: 3 },
            { backend: 'kimi', model: 'precise', thinkingEffort: 'high', weight: 1 },
          ],
        },
      },
    };

    const parent = testAgent();
    parent.configure();
    const child = testAgent({
      initialConfig: {
        providers: { local: { type: 'openai', apiKey: 'test-key' } },
        models: {
          fast: { provider: 'local', model: 'fast-model', maxContextSize: 128000 },
          precise: { provider: 'local', model: 'precise-model', maxContextSize: 128000 },
        },
      },
    });
    child.configure();

    const session = fakeSession(parent.agent, child.agent, {}, config);
    const host = new SessionSubagentHost(session, 'main');

    const pickedModels: (string | undefined)[] = [];
    const pickedEfforts: (string | undefined)[] = [];
    for (let i = 0; i < 4; i += 1) {
      child.mockNextResponse({
        type: 'text',
        text: `Completed pooled spawn number ${String(i)}.${CONTINUATION_SAFE_SUMMARY_SUFFIX}`,
      });
      const handle = await host.spawn({
        profileName: 'coder',
        parentToolCallId: `call_${String(i)}`,
        prompt: 'do pooled work',
        description: 'do pooled work',
        runInBackground: false,
        signal,
      });
      await handle.completion;
      pickedModels.push(child.agent.config.modelAlias);
      pickedEfforts.push(child.agent.config.thinkingEffort);
    }

    // Deterministic smooth weighted round-robin (nginx-style) over a 3:1
    // weight split resolves to A,A,B,A.
    expect(pickedModels).toEqual(['fast', 'fast', 'precise', 'fast']);
    expect(pickedEfforts).toEqual(['low', 'low', 'high', 'low']);
  });

  it('ignores the pool for non-coder profiles and profiles without a configured pool', async () => {
    const config: KimiConfig = {
      providers: {},
      models: {
        fast: { provider: 'local', model: 'fast-model', maxContextSize: 128000 },
      },
      subagent: {
        pools: {
          // Only `coder` pooling is wired; an `explore` pool must be ignored.
          explore: [{ backend: 'kimi', model: 'fast' }],
        },
      },
    };

    const parent = testAgent();
    parent.configure();
    const child = testAgent();
    child.configure();
    child.mockNextResponse({
      type: 'text',
      text: `Explored the codebase.${CONTINUATION_SAFE_SUMMARY_SUFFIX}`,
    });

    const session = fakeSession(parent.agent, child.agent, {}, config);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_explore',
      prompt: 'look around',
      description: 'look around',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    // No `subagent.routing.explore`, and the pool is gated to `coder` only,
    // so the child inherits the parent's model exactly as before route
    // pools existed.
    expect(child.agent.config.modelAlias).toBe(parent.agent.config.modelAlias);
  });

  it('serializes coder spawns through a single-route pool and releases the slot on completion', async () => {
    const config: KimiConfig = {
      providers: {},
      models: {
        fast: { provider: 'local', model: 'fast-model', maxContextSize: 128000 },
      },
      subagent: {
        pools: {
          coder: [{ backend: 'kimi', model: 'fast', maxConcurrency: 1 }],
        },
      },
    };

    const parent = testAgent();
    parent.configure();
    const child = testAgent({
      initialConfig: {
        providers: { local: { type: 'openai', apiKey: 'test-key' } },
        models: {
          fast: { provider: 'local', model: 'fast-model', maxContextSize: 128000 },
        },
      },
    });
    child.configure();

    const session = fakeSession(parent.agent, child.agent, {}, config);
    const host = new SessionSubagentHost(session, 'main');

    child.mockNextResponse({
      type: 'text',
      text: `First pooled spawn.${CONTINUATION_SAFE_SUMMARY_SUFFIX}`,
    });
    const first = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_first',
      prompt: 'first',
      description: 'first',
      runInBackground: false,
      signal,
    });

    // The route slot is still held: the first spawn's turn has not settled
    // yet, so a second spawn attempt against the same maxConcurrency=1 route
    // must be rejected as exhausted rather than silently double-booking it.
    await expect(
      host.spawn({
        profileName: 'coder',
        parentToolCallId: 'call_second_too_soon',
        prompt: 'second',
        description: 'second',
        runInBackground: false,
        signal,
      }),
    ).rejects.toThrow('exhausted');

    await first.completion;

    // Completion releases the slot, so a later spawn can reuse the same
    // single-entry pool.
    child.mockNextResponse({
      type: 'text',
      text: `Second pooled spawn.${CONTINUATION_SAFE_SUMMARY_SUFFIX}`,
    });
    const second = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_second',
      prompt: 'second',
      description: 'second',
      runInBackground: false,
      signal,
    });
    await expect(second.completion).resolves.toMatchObject({});
  });

  it('applies a one-shot work-card routeOverride without persisting it to config', async () => {
    const config: KimiConfig = {
      providers: {},
      models: {
        fast: { provider: 'local', model: 'fast-model', maxContextSize: 128000 },
        precise: { provider: 'local', model: 'precise-model', maxContextSize: 128000 },
      },
      subagent: {
        routing: { coder: { model: 'fast', thinkingEffort: 'low' } },
      },
    };

    const parent = testAgent();
    parent.configure({
      modelCapabilities: {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 128000,
      },
    });
    parent.agent.config.update({ thinkingEffort: 'high' });
    expect(parent.agent.config.thinkingEffort).toBe('on');
    const child = testAgent({
      initialConfig: {
        providers: { local: { type: 'openai', apiKey: 'test-key' } },
        models: {
          fast: { provider: 'local', model: 'fast-model', maxContextSize: 128000 },
          precise: { provider: 'local', model: 'precise-model', maxContextSize: 128000 },
        },
      },
    });
    child.configure();

    const session = fakeSession(parent.agent, child.agent, {}, config);
    const host = new SessionSubagentHost(session, 'main');

    child.mockNextResponse({
      type: 'text',
      text: `Completed the overridden-route spawn.${CONTINUATION_SAFE_SUMMARY_SUFFIX}`,
    });
    const overridden = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_override',
      prompt: 'use the override',
      description: 'use the override',
      runInBackground: false,
      signal,
      dispatch: {
        workCard: {
          id: 'card-1',
          title: 'Override card',
          goal: 'Use a one-shot route override',
          acceptance: 'Runs on the overridden model',
          routeOverride: { backend: 'kimi', model: 'precise' },
        },
      },
    });
    await overridden.completion;
    expect(child.agent.config.modelAlias).toBe('precise');
    expect(child.agent.config.thinkingEffort).toBe('on');

    child.mockNextResponse({
      type: 'text',
      text: `Completed the internal-only spawn.${CONTINUATION_SAFE_SUMMARY_SUFFIX}`,
    });
    const internalOnly = await host.spawn({
      profileName: 'coder',
      modelAlias: 'precise',
      parentToolCallId: 'call_internal_only',
      prompt: 'use the parent effort',
      description: 'use the parent effort',
      runInBackground: false,
      signal,
      dispatch: { internalOnly: true },
    });
    await internalOnly.completion;
    expect(child.agent.config.modelAlias).toBe('precise');
    expect(child.agent.config.thinkingEffort).toBe('on');

    child.mockNextResponse({
      type: 'text',
      text: `Completed the default-route spawn.${CONTINUATION_SAFE_SUMMARY_SUFFIX}`,
    });
    const normal = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_normal',
      prompt: 'no override this time',
      description: 'no override this time',
      runInBackground: false,
      signal,
    });
    await normal.completion;
    // The override was one-shot: config.subagent.routing.coder wins again.
    expect(child.agent.config.modelAlias).toBe('fast');
    expect(child.agent.config.thinkingEffort).toBe('low');
  });

  it('resumes and retries an external coder through its recorded agent, session, backend, and model', async () => {
    const echoArgsScript =
      "process.stdout.write(process.argv.slice(1).join('|'));process.exit(0)";
    const config: KimiConfig = {
      providers: {},
      subagent: {
        pools: {
          // The pool would deterministically pick echo-a; the routeOverride
          // below sends the initial spawn to echo-b instead, so a continuation
          // that incorrectly re-derived its route from the pool would fail.
          coder: [{ backend: 'echo-a', model: 'pool-model' }],
        },
        backends: {
          'echo-a': { command: process.execPath, args: ['-e', echoArgsScript, 'FROM_A'] },
          'echo-b': {
            command: process.execPath,
            args: ['-e', echoArgsScript, 'FROM_B', '{model}', '{session_id}'],
            resumeArgs: ['-e', echoArgsScript, 'FROM_B_RESUMED', '{model}', '{session_id}'],
          },
        },
      },
    };

    const parent = testAgent();
    parent.configure();
    const session = fakeSession(parent.agent, parent.agent, {}, config);
    const host = new SessionSubagentHost(session, 'main');

    const spawned = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_external',
      prompt: 'delegate externally',
      description: 'delegate externally',
      runInBackground: false,
      signal,
      dispatch: {
        workCard: {
          id: 'card-external',
          title: 'External override card',
          goal: 'Route to echo-b instead of the pool pick',
          acceptance: 'Later continuations keep the same route and session',
          routeOverride: { backend: 'echo-b', model: 'override-model' },
        },
      },
    });
    const externalSessionId = session.metadata.agents[spawned.agentId]?.externalSessionId;
    expect(externalSessionId).toEqual(expect.any(String));
    await expect(spawned.completion).resolves.toEqual({
      result: `FROM_B|override-model|${externalSessionId}`,
    });

    const resumed = await host.resume(spawned.agentId, {
      parentToolCallId: 'call_external_resume',
      prompt: 'repair the initial delivery',
      description: 'repair the initial delivery',
      runInBackground: false,
      signal,
    });
    expect(resumed).toMatchObject({ agentId: spawned.agentId, resumed: true });
    await expect(resumed.completion).resolves.toEqual({
      result: `FROM_B_RESUMED|override-model|${externalSessionId}`,
    });

    const retried = await host.retry(spawned.agentId, {
      parentToolCallId: 'call_external_retry',
      prompt: 'retry after a transient failure',
      description: 'retry after a transient failure',
      runInBackground: false,
      signal,
    });
    expect(retried).toMatchObject({ agentId: spawned.agentId, resumed: true });
    await expect(retried.completion).resolves.toEqual({
      result: `FROM_B_RESUMED|override-model|${externalSessionId}`,
    });
    expect(session.metadata.agents[spawned.agentId]).toMatchObject({
      externalBackend: 'echo-b',
      externalModelAlias: 'override-model',
      externalSessionId,
    });
  });
});

describe('SessionSubagentHost circuit breaker (R-A2)', () => {
  const SAFE_SUMMARY_SUFFIX =
    ' The summary stays long enough to skip the automatic continuation retry that pads overly short subagent handoffs before returning them to the parent, since anything under two hundred characters triggers one extra follow-up turn asking for more detail.';

  const CHILD_MODELS = {
    primary: { provider: 'local', model: 'primary-model', maxContextSize: 128000 },
    fallback1: { provider: 'local', model: 'fallback1-model', maxContextSize: 128000 },
    fallback2: { provider: 'local', model: 'fallback2-model', maxContextSize: 128000 },
  } as const;

  function childInitialConfig(): AgentOptions['config'] {
    return {
      providers: { local: { type: 'openai', apiKey: 'test-key' } },
      models: CHILD_MODELS,
    };
  }

  function fallbackConfig(): KimiConfig {
    return {
      providers: {},
      models: CHILD_MODELS,
      subagent: {
        routing: { explore: { backend: 'kimi', model: 'primary' } },
        fallbackChain: [
          { backend: 'kimi', model: 'fallback1' },
          { backend: 'kimi', model: 'fallback2' },
        ],
      },
    };
  }

  it('resolves the configured route unchanged when its circuit is not open', async () => {
    const parent = testAgent();
    parent.configure();
    const child = testAgent({ initialConfig: childInitialConfig() });
    child.configure();
    child.mockNextResponse({ type: 'text', text: `Explored normally.${SAFE_SUMMARY_SUFFIX}` });

    const session = fakeSession(parent.agent, child.agent, {}, fallbackConfig());
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_explore',
      prompt: 'look around',
      description: 'look around',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    expect(child.agent.config.modelAlias).toBe('primary');
  });

  it('switches to the first fallback route when the default route is circuit-open', async () => {
    const parent = testAgent();
    parent.configure();
    parent.agent.dispatchController.openCircuit('kimi::primary', 'kimi::primary', 'provider.auth_error');
    const child = testAgent({ initialConfig: childInitialConfig() });
    child.configure();
    child.mockNextResponse({ type: 'text', text: `Explored via fallback.${SAFE_SUMMARY_SUFFIX}` });

    const session = fakeSession(parent.agent, child.agent, {}, fallbackConfig());
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_explore',
      prompt: 'look around',
      description: 'look around',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    expect(child.agent.config.modelAlias).toBe('fallback1');
  });

  it('walks past an already-circuit-open fallback to the next one in the chain', async () => {
    const parent = testAgent();
    parent.configure();
    parent.agent.dispatchController.openCircuit('kimi::primary', 'kimi::primary', 'provider.auth_error');
    parent.agent.dispatchController.openCircuit(
      'kimi::fallback1',
      'kimi::fallback1',
      'model.not_configured',
    );
    const child = testAgent({ initialConfig: childInitialConfig() });
    child.configure();
    child.mockNextResponse({ type: 'text', text: `Explored via second fallback.${SAFE_SUMMARY_SUFFIX}` });

    const session = fakeSession(parent.agent, child.agent, {}, fallbackConfig());
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_explore',
      prompt: 'look around',
      description: 'look around',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    expect(child.agent.config.modelAlias).toBe('fallback2');
  });

  it('terminates and reports the full failure chain once every fallback is also circuit-open', async () => {
    const parent = testAgent();
    parent.configure();
    parent.agent.dispatchController.openCircuit('kimi::primary', 'kimi::primary', 'provider.auth_error');
    parent.agent.dispatchController.openCircuit(
      'kimi::fallback1',
      'kimi::fallback1',
      'model.not_configured',
    );
    parent.agent.dispatchController.openCircuit(
      'kimi::fallback2',
      'kimi::fallback2',
      'auth.login_required',
    );
    const child = testAgent();
    child.configure();

    const session = fakeSession(parent.agent, child.agent, {}, fallbackConfig());
    const host = new SessionSubagentHost(session, 'main');

    await expect(
      host.spawn({
        profileName: 'explore',
        parentToolCallId: 'call_explore',
        prompt: 'look around',
        description: 'look around',
        runInBackground: false,
        signal,
      }),
    ).rejects.toThrow(/circuit-open.*kimi::primary.*provider\.auth_error.*kimi::fallback1.*model\.not_configured.*kimi::fallback2.*auth\.login_required/s);
  });

  it('terminates immediately on an open circuit when no fallbackChain is configured', async () => {
    const parent = testAgent();
    parent.configure();
    parent.agent.dispatchController.openCircuit('kimi::primary', 'kimi::primary', 'provider.auth_error');
    const child = testAgent();
    child.configure();

    const config: KimiConfig = {
      providers: {},
      models: { primary: { provider: 'local', model: 'primary-model', maxContextSize: 128000 } },
      subagent: { routing: { explore: { backend: 'kimi', model: 'primary' } } },
    };
    const session = fakeSession(parent.agent, child.agent, {}, config);
    const host = new SessionSubagentHost(session, 'main');

    await expect(
      host.spawn({
        profileName: 'explore',
        parentToolCallId: 'call_explore',
        prompt: 'look around',
        description: 'look around',
        runInBackground: false,
        signal,
      }),
    ).rejects.toThrow(/circuit-open/);
  });

  it('opens the circuit on a real non-retryable provider failure, then a later spawn picks the fallback', async () => {
    const parent = testAgent();
    parent.configure();

    const failingGenerate: GenerateFn = async () => {
      throw new KimiError('provider.auth_error', 'Provider authentication failed');
    };
    const failingChild = testAgent({ generate: failingGenerate, initialConfig: childInitialConfig() });
    failingChild.configure();

    const config = fallbackConfig();
    const failingSession = fakeSession(parent.agent, failingChild.agent, {}, config);
    const failingHost = new SessionSubagentHost(failingSession, 'main');

    const firstHandle = await failingHost.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_explore_1',
      prompt: 'look around',
      description: 'look around',
      runInBackground: false,
      signal,
    });
    await expect(firstHandle.completion).rejects.toThrow('Provider authentication failed');
    expect(parent.agent.dispatchController.isCircuitOpen('kimi::primary', 'kimi::primary')).toBe(true);

    const recoveredChild = testAgent({ initialConfig: childInitialConfig() });
    recoveredChild.configure();
    recoveredChild.mockNextResponse({
      type: 'text',
      text: `Recovered via fallback after the primary route failed.${SAFE_SUMMARY_SUFFIX}`,
    });
    const recoveredSession = fakeSession(parent.agent, recoveredChild.agent, {}, config);
    const recoveredHost = new SessionSubagentHost(recoveredSession, 'main');

    const secondHandle = await recoveredHost.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_explore_2',
      prompt: 'look around',
      description: 'look around',
      runInBackground: false,
      signal,
    });
    await secondHandle.completion;

    expect(recoveredChild.agent.config.modelAlias).toBe('fallback1');
  });
});

describe('SessionSubagentHost concurrency risk gate (R-C1)', () => {
  const SAFE_SUMMARY_SUFFIX =
    ' The summary stays long enough to skip the automatic continuation retry that pads overly short subagent handoffs before returning them to the parent, since anything under two hundred characters triggers one extra follow-up turn asking for more detail.';

  async function makeRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-subagent-risk-wiring-'));
    tempDirs.push(dir);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.test'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    return dir;
  }

  function editingTask(scope: readonly string[]): QueuedSubagentTask {
    return {
      kind: 'spawn',
      resumeAgentId: undefined,
      data: undefined,
      profileName: 'coder',
      parentToolCallId: 'call_swarm',
      prompt: 'do editing work',
      description: 'do editing work',
      runInBackground: false,
      dispatch: { scope },
      signal,
    };
  }

  it('forces maxConcurrency to 1 when the batch scope is dirty', async () => {
    capturedBatchMaxConcurrency.length = 0;
    const dir = await makeRepo();
    await mkdir(join(dir, 'src/a'), { recursive: true });
    await writeFile(join(dir, 'src/a/file.ts'), 'export const a = 1;');

    const parent = testAgent();
    parent.configure();
    parent.agent.config.update({ cwd: dir });
    const child = testAgent();
    child.configure();
    child.mockNextResponse({ type: 'text', text: `Done editing.${SAFE_SUMMARY_SUFFIX}` });

    const session = fakeSession(parent.agent, child.agent, { 'agent-0': {} } as never);
    const host = new SessionSubagentHost(session, 'main');

    await host.runQueued([editingTask(['src/a'])]);

    expect(capturedBatchMaxConcurrency).toEqual([1]);
  });

  it('leaves maxConcurrency unchanged when the batch scope is clean', async () => {
    capturedBatchMaxConcurrency.length = 0;
    const dir = await makeRepo();
    await mkdir(join(dir, 'src/a'), { recursive: true });
    await writeFile(join(dir, 'src/a/file.ts'), 'export const a = 1;');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

    const parent = testAgent();
    parent.configure();
    parent.agent.config.update({ cwd: dir });
    const child = testAgent();
    child.configure();
    child.mockNextResponse({ type: 'text', text: `Done editing.${SAFE_SUMMARY_SUFFIX}` });

    const session = fakeSession(parent.agent, child.agent, { 'agent-0': {} } as never);
    const host = new SessionSubagentHost(session, 'main');

    await host.runQueued([editingTask(['src/a'])]);

    expect(capturedBatchMaxConcurrency).toEqual([resolveSwarmMaxConcurrency()]);
  });

  it('skips risk detection entirely for a read-only batch', async () => {
    capturedBatchMaxConcurrency.length = 0;
    const dir = await mkdtemp(join(tmpdir(), 'kimi-subagent-risk-readonly-'));
    tempDirs.push(dir);

    const parent = testAgent();
    parent.configure();
    parent.agent.config.update({ cwd: dir });
    const child = testAgent();
    child.configure();
    child.mockNextResponse({ type: 'text', text: `Explored.${SAFE_SUMMARY_SUFFIX}` });

    const session = fakeSession(parent.agent, child.agent, { 'agent-0': {} } as never);
    const host = new SessionSubagentHost(session, 'main');

    await host.runQueued([
      {
        kind: 'spawn',
        resumeAgentId: undefined,
        data: undefined,
        profileName: 'explore',
        parentToolCallId: 'call_swarm',
        prompt: 'look around',
        description: 'look around',
        runInBackground: false,
        signal,
      },
    ]);

    expect(capturedBatchMaxConcurrency).toEqual([resolveSwarmMaxConcurrency()]);
  });
});

describe('Session resume permission parent chain', () => {
  it('restores subagent live-derived permission when metadata lists the child first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-permission-chain-'));
    tempDirs.push(dir);
    const sessionDir = join(dir, 'session');
    const workDir = join(dir, 'work');
    const mainDir = join(sessionDir, 'agents', 'main');
    const childDir = join(sessionDir, 'agents', 'agent-0');
    const sessionApprovalRule = 'Bash(printf parent)';
    await mkdir(workDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify(
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          title: 'Permission Chain',
          isCustomTitle: false,
          agents: {
            'agent-0': {
              homedir: childDir,
              type: 'sub',
              parentAgentId: 'main',
            },
            main: {
              homedir: mainDir,
              type: 'main',
              parentAgentId: null,
            },
          },
          custom: {},
        },
        null,
        2,
      ),
      'utf-8',
    );
    await writeWire(mainDir, [
      {
        type: 'permission.set_mode',
        mode: 'yolo',
      },
      {
        type: 'permission.record_approval_result',
        turnId: 0,
        toolCallId: 'call_parent_bash',
        toolName: 'Bash',
        action: 'run command',
        sessionApprovalRule,
        result: {
          decision: 'approved',
          scope: 'session',
          selectedLabel: 'Approve for this session',
        },
      },
    ]);
    await writeWire(childDir, []);

    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      initializeMainAgent: false,
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });

    try {
      await session.resume();

      const child = await session.ensureAgentResumed('agent-0');
      expect(child?.permission.mode).toBe('yolo');
      expect(child?.permission.rules).toEqual([]);
      expect(child?.permission.data().rules).toEqual([]);
      expect(child?.permission.sessionApprovalRulePatterns).toContain(sessionApprovalRule);
    } finally {
      await session.close();
    }
  });
});

describe('Session.createAgent', () => {
  it('uses the Kaos current directory when the session cwd is omitted', async () => {
    const workDir = '/remote/project';
    const kaos = createFakeKaos({
      getcwd: () => workDir,
      mkdir: vi.fn(async () => {}),
      writeText: vi.fn().mockResolvedValue(0),
      stat: vi.fn(async (path: string) => {
        if ([workDir, `${workDir}/.git`].includes(path)) {
          return stat('dir');
        }
        if ([`${workDir}/README.md`, `${workDir}/AGENTS.md`].includes(path)) {
          return stat('file');
        }
        throw new Error(`ENOENT ${path}`);
      }),
      iterdir: async function* (path: string) {
        if (path === workDir) {
          yield `${workDir}/README.md`;
          return;
        }
        throw new Error(`ENOENT ${path}`);
      },
      readText: vi.fn(async (path: string) => {
        if (path === `${workDir}/AGENTS.md`) return 'remote instructions';
        throw new Error(`ENOENT ${path}`);
      }),
    });
    const session = new Session({
      id: 'test-subagent-remote-context',
      kaos,
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    const created = await session.createAgent({ type: 'main' }, { profile: contextProfile() });

    expect(created.agent.config.systemPrompt).toContain('cwd=/remote/project');
    expect(created.agent.config.systemPrompt).toContain('listing=└── README.md');
    expect(created.agent.config.systemPrompt).toContain('remote instructions');
  });

  it('renders profiles with the current directory listing and merged AGENTS.md files', async () => {
    const workDir = '/repo/packages/app';
    const kaos = createFakeKaos({
      mkdir: vi.fn(async () => {}),
      writeText: vi.fn().mockResolvedValue(0),
      stat: vi.fn(async (path: string) => {
        if (
          [
            '/repo',
            '/repo/.git',
            '/repo/packages',
            workDir,
            `${workDir}/.agents`,
            `${workDir}/.github`,
            `${workDir}/.github/workflows`,
            `${workDir}/src`,
            `${workDir}/.kimi-code`,
          ].includes(path)
        ) {
          return stat('dir');
        }
        if (
          [
            '/repo/AGENTS.md',
            `${workDir}/.kimi-code/AGENTS.md`,
            `${workDir}/AGENTS.md`,
            `${workDir}/package.json`,
            `${workDir}/src/index.ts`,
            `${workDir}/.agents/hidden.md`,
            `${workDir}/.github/workflows/ci.yml`,
          ].includes(path)
        ) {
          return stat('file');
        }
        throw new Error(`ENOENT ${path}`);
      }),
      iterdir: async function* (path: string) {
        if (path === workDir) {
          yield `${workDir}/.agents`;
          yield `${workDir}/.github`;
          yield `${workDir}/src`;
          yield `${workDir}/package.json`;
          return;
        }
        if (path === `${workDir}/.agents`) {
          yield `${workDir}/.agents/hidden.md`;
          return;
        }
        if (path === `${workDir}/.github`) {
          yield `${workDir}/.github/workflows`;
          return;
        }
        if (path === `${workDir}/.github/workflows`) {
          yield `${workDir}/.github/workflows/ci.yml`;
          return;
        }
        if (path === `${workDir}/src`) {
          yield `${workDir}/src/index.ts`;
          return;
        }
        throw new Error(`ENOENT ${path}`);
      },
      readText: vi.fn(async (path: string) => {
        if (path === '/repo/AGENTS.md') return 'root instructions';
        if (path === `${workDir}/.kimi-code/AGENTS.md`) return 'brand instructions';
        if (path === `${workDir}/AGENTS.md`) return 'leaf instructions';
        throw new Error(`ENOENT ${path}`);
      }),
    });
    const session = new Session({
      id: 'test-subagent-agents-md',
      kaos: kaos.withCwd(workDir),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    const created = await session.createAgent({ type: 'main' }, { profile: contextProfile() });

    expect(created.agent.config.systemPrompt).toContain('cwd=/repo/packages/app');
    expect(created.agent.config.systemPrompt).toContain('listing=├── .agents/');
    expect(created.agent.config.systemPrompt).toContain('├── .github/');
    expect(created.agent.config.systemPrompt).toContain('├── src/');
    expect(created.agent.config.systemPrompt).toContain('│   └── index.ts');
    expect(created.agent.config.systemPrompt).toContain('└── package.json');
    expect(created.agent.config.systemPrompt).not.toContain('hidden.md');
    expect(created.agent.config.systemPrompt).not.toContain('ci.yml');
    expect(created.agent.config.systemPrompt).toContain('<!-- From: /repo/AGENTS.md -->');
    expect(created.agent.config.systemPrompt).toContain('root instructions');
    expect(created.agent.config.systemPrompt).toContain(
      '<!-- From: /repo/packages/app/.kimi-code/AGENTS.md -->',
    );
    expect(created.agent.config.systemPrompt).toContain('brand instructions');
    expect(created.agent.config.systemPrompt).toContain(
      '<!-- From: /repo/packages/app/AGENTS.md -->',
    );
    expect(created.agent.config.systemPrompt).toContain('leaf instructions');
  });

  it('uses the kimi home for global branded AGENTS.md files', async () => {
    const realHome = '/real-home';
    const kimiHome = '/kimi-home';
    const workDir = '/repo/packages/app';
    const kaos = createFakeKaos({
      gethome: () => realHome,
      mkdir: vi.fn(async () => {}),
      writeText: vi.fn().mockResolvedValue(0),
      stat: vi.fn(async (path: string) => {
        if (['/repo', '/repo/.git', '/repo/packages', workDir].includes(path)) {
          return stat('dir');
        }
        if ([`${kimiHome}/AGENTS.md`, `${realHome}/.kimi-code/AGENTS.md`].includes(path)) {
          return stat('file');
        }
        throw new Error(`ENOENT ${path}`);
      }),
      // oxlint-disable-next-line require-yield
      iterdir: async function* () {
        return;
      },
      readText: vi.fn(async (path: string) => {
        if (path === `${kimiHome}/AGENTS.md`) return 'kimi home instructions';
        if (path === `${realHome}/.kimi-code/AGENTS.md`) return 'stale real-home instructions';
        throw new Error(`ENOENT ${path}`);
      }),
    });
    const session = new Session({
      id: 'test-kimi-home-agents-md',
      kaos: kaos.withCwd(workDir),
      homedir: '/tmp/kimi-session',
      kimiHomeDir: kimiHome,
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    const created = await session.createAgent({ type: 'main' }, { profile: contextProfile() });

    expect(created.agent.config.systemPrompt).toContain('kimi home instructions');
    expect(created.agent.config.systemPrompt).not.toContain('stale real-home instructions');
  });

  it('inherits the parent agent cwd when creating a subagent', async () => {
    const sessionWorkDir = '/session/work';
    const parentWorkDir = '/parent/work';

    const kaos = createFakeKaos({
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeText: vi.fn().mockResolvedValue(0),
      stat: vi.fn(async (path: string) => {
        if ([sessionWorkDir, parentWorkDir].includes(path)) {
          return stat('dir');
        }
        throw new Error(`ENOENT ${path}`);
      }),
      // oxlint-disable-next-line require-yield
      iterdir: async function* () {
        return;
      },
      getcwd: () => sessionWorkDir,
    });

    const session = new Session({
      id: 'test-subagent-parent-cwd',
      kaos,
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    // Create a parent agent — it should start at the session workDir.
    const parent = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    expect(parent.agent.config.systemPrompt).toContain(`cwd=${sessionWorkDir}`);

    // Move the parent agent to a different cwd (e.g. after a config.update replay).
    parent.agent.config.update({ cwd: parentWorkDir });

    // Create a subagent from the moved parent.
    const child = await session.createAgent(
      { type: 'sub' },
      { profile: contextProfile(), parentAgentId: parent.id },
    );

    // The subagent should inherit the parent's current cwd, not the session default.
    expect(child.agent.config.systemPrompt).toContain(`cwd=${parentWorkDir}`);
    expect(child.agent.config.systemPrompt).not.toContain(`cwd=${sessionWorkDir}`);
  });

  it('passes session additional dirs to main and child agents', async () => {
    const extraDir = '/extra/work';
    const directories = new Set(['/workspace', extraDir]);
    const files = new Map([
      [join(extraDir, 'AGENTS.md'), 'extra agents instructions'],
      [join(extraDir, 'extra-file.ts'), 'export const extra = 1;'],
    ]);
    const session = new Session({
      id: 'test-subagent-additional-dirs',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
        stat: vi.fn(async (path: string) => {
          if (directories.has(path)) return stat('dir');
          if (files.has(path)) return stat('file');
          throw new Error(`ENOENT ${path}`);
        }),
        iterdir: async function* (path: string) {
          if (path === extraDir) {
            yield join(extraDir, 'AGENTS.md');
            yield join(extraDir, 'extra-file.ts');
          }
        },
        readText: vi.fn(async (path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error(`ENOENT ${path}`);
          return content;
        }),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
      additionalDirs: [extraDir],
    });

    const main = await session.createMain();
    const child = await session.createAgent(
      { type: 'sub' },
      { profile: contextProfile(), parentAgentId: 'main' },
    );

    expect(main.getAdditionalDirs()).toEqual([extraDir]);
    expect(child.agent.getAdditionalDirs()).toEqual([extraDir]);
    expect(child.agent.config.systemPrompt).toContain(`additional=### ${extraDir}`);
    expect(child.agent.config.systemPrompt).toContain('extra-file.ts');
  });

  it('allocates the next unused generated agent id', async () => {
    const session = new Session({
      id: 'test-subagent-agent-id',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    session.metadata.agents['agent-0'] = {
      homedir: '/tmp/kimi-session/agents/agent-0',
      type: 'sub',
      parentAgentId: null,
    };

    const created = await session.createAgent({ type: 'sub' });

    expect(created.id).toBe('agent-1');
    expect(session.agents.get('agent-1')).toBe(created.agent);
    expect(session.metadata.agents['agent-1']).toMatchObject({
      homedir: '/tmp/kimi-session/agents/agent-1',
      type: 'sub',
    });
  });

  it('shares the session McpConnectionManager with sub and main agents', async () => {
    const session = new Session({
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    const main = await session.createAgent({ type: 'main' });
    expect(main.agent.mcp).toBe(session.mcp);

    const sub = await session.createAgent({ type: 'sub' }, { parentAgentId: main.id });
    expect(sub.agent.mcp).toBe(session.mcp);
  });
});

function fakeSession(
  parent: Agent,
  child: Agent,
  metadataAgents: Session['metadata']['agents'] = {},
  config?: KimiConfig,
) {
  const agents = new Map<string, Agent>([['main', parent]]);
  if (metadataAgents['agent-0'] !== undefined) {
    agents.set('agent-0', child);
  }
  return {
    agents,
    options: { kimiHomeDir: undefined, config },
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      title: 'Test Session',
      isCustomTitle: false,
      agents: metadataAgents,
      custom: {},
    },
    writeMetadata: vi.fn(async () => {}),
    systemContextKaos: vi.fn((cwd: string) => parent.kaos.withCwd(cwd)),
    getReadyAgent: vi.fn((id: string) => agents.get(id)),
    ensureAgentResumed: vi.fn(async (id: string) => {
      const agent = agents.get(id);
      if (agent === undefined) {
        throw new Error(`Agent "${id}" was not found`);
      }
      return agent;
    }),
    createAgent: vi.fn(
      async (
        config: Parameters<Session['createAgent']>[0],
        options: Parameters<Session['createAgent']>[1] = {},
      ) => {
        agents.set('agent-0', child);
        const parentAgentId = options.parentAgentId ?? null;
        if (options.persistMetadata !== false) {
          metadataAgents['agent-0'] = {
            homedir: '/tmp/kimi-session/agents/agent-0',
            type: config.type ?? 'main',
            parentAgentId,
            swarmItem: options.swarmItem,
          };
        }
        if (options.profile !== undefined) {
          child.useProfile(options.profile);
        }
        return { id: 'agent-0', agent: child };
      },
    ),
  } as unknown as Session;
}

function editingCandidateDraft(): EditingCandidateDraft {
  return {
    version: 1,
    candidateHash: 'candidate-hash',
    repoRoot: '/repo',
    commonDir: '/repo/.git',
    headCommit: 'source-commit',
    scope: ['src/widget.ts'],
    requestedScope: ['src/widget.ts', 'test/widget.test.ts'],
    paths: [
      {
        relPath: 'src/widget.ts',
        classification: 'in_scope',
        before: { state: { kind: 'absent' } },
        after: {
          state: { kind: 'regular', mode: 0o100644, sha256: 'source-hash' },
          payload: Buffer.from('source'),
        },
      },
      {
        relPath: 'test/widget.test.ts',
        classification: 'scope_expansion_requested',
        before: { state: { kind: 'absent' } },
        after: {
          state: { kind: 'regular', mode: 0o100644, sha256: 'test-hash' },
          payload: Buffer.from('test'),
        },
      },
    ],
  };
}

function contextProfile(): ResolvedAgentProfile {
  return {
    name: 'context-profile',
    systemPrompt: (context) =>
      [
        `cwd=${context.cwd}`,
        `listing=${context.cwdListing ?? ''}`,
        `agents=${context.agentsMd ?? ''}`,
        `additional=${context.additionalDirsInfo ?? ''}`,
      ].join('\n'),
    tools: [],
  };
}

function lookupToolRegistration() {
  return {
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
  };
}

function profile(input: {
  readonly name: string;
  readonly tools: readonly string[];
  readonly systemPrompt: string;
  readonly description?: string | undefined;
  readonly subagents?: Record<string, ResolvedAgentProfile> | undefined;
}): ResolvedAgentProfile {
  return {
    name: input.name,
    description: input.description,
    systemPrompt: () => input.systemPrompt,
    tools: [...input.tools],
    subagents: input.subagents,
  };
}

function stat(kind: 'dir' | 'file') {
  return {
    stMode: kind === 'dir' ? 0o040000 : 0o100000,
    stIno: 0,
    stDev: 0,
    stNlink: 1,
    stUid: 0,
    stGid: 0,
    stSize: 0,
    stAtime: 0,
    stMtime: 0,
    stCtime: 0,
  };
}

function queuedTask(index: number): QueuedSubagentTask<number> {
  return {
    kind: 'spawn',
    data: index,
    profileName: 'coder',
    parentToolCallId: 'call_swarm',
    prompt: `Review item-${String(index)}`,
    description: `Review #${String(index)}`,
    swarmIndex: index,
    runInBackground: false,
  };
}

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-text',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
    usage: {
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    },
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}

function userTextMessages(history: readonly Message[]): string[] {
  return history
    .filter((message) => message.role === 'user')
    .map((message) =>
      message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
    );
}

async function writeWire(homedir: string, records: readonly Record<string, unknown>[]) {
  await mkdir(homedir, { recursive: true });
  const wireRecords =
    records.length === 0
      ? []
      : [
          {
            type: 'metadata',
            protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
            created_at: 1,
          },
          ...records,
        ];
  const text = wireRecords.map((record) => JSON.stringify(record)).join('\n');
  await writeFile(join(homedir, 'wire.jsonl'), text.length === 0 ? '' : `${text}\n`, 'utf-8');
}

function childBashToolResultOutput(child: AgentTestContext): string | undefined {
  for (const entry of child.allEvents) {
    if (entry.type !== '[wire]' || entry.event !== 'context.append_loop_event') continue;
    const loopEvent = (
      entry.args as {
        event?: { type?: string; toolCallId?: string; result?: { output?: unknown } };
      }
    ).event;
    if (loopEvent?.type === 'tool.result' && loopEvent.toolCallId === 'call_bash') {
      const output = loopEvent.result?.output;
      return typeof output === 'string' ? output : undefined;
    }
  }
  return undefined;
}

function bashCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
      arguments: '{"command":"printf should-not-run","timeout":60}',
  };
}

function createSessionRpc(): SDKSessionRPC {
  return new Proxy(
    {},
    {
      get: () => vi.fn(),
    },
  ) as SDKSessionRPC;
}
