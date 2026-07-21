/**
 * Covers: TaskListTool, TaskOutputTool, TaskStopTool.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { dirname, join } from 'pathe';

import { LocalKaos, type KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BackgroundTaskPersistence,
  type BackgroundManager,
  type BackgroundTaskInfo,
} from '../../../src/agent/background';
import { TaskListTool } from '../../../src/tools/background/task-list';
import { TaskOutputTool } from '../../../src/tools/background/task-output';
import { TaskStopTool } from '../../../src/tools/background/task-stop';
import {
  acquireSubagentWorktree,
  applySubagentWorktreeCandidate,
  type EditingCandidateDraft,
} from '../../../src/session/subagent-worktree';
import {
  agentTask,
  createBackgroundManager,
  editingCandidateCompletion,
  registerProcess,
  waitForOutput,
} from '../../agent/background/helpers';
import { executeTool } from '../fixtures/execute-tool';
import { toolContentString } from '../fixtures/fake-kaos';

const signal = new AbortController().signal;

function context<Input>(toolCallId: string, args: Input) {
  return { turnId: '0', toolCallId, args, signal };
}

function immediateProcess(exitCode: number, stdoutText = ''): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 10000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as KaosProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

function pendingProcess(): KaosProcess {
  let resolveWait: (n: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async () => {
    if (currentExitCode !== null) return;
    currentExitCode = 143;
    resolveWait(143);
  });
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54321,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

function persistedProcess(
  overrides: Partial<Extract<BackgroundTaskInfo, { kind: 'process' }>> = {},
): Extract<BackgroundTaskInfo, { kind: 'process' }> {
  return {
    taskId: 'bash-deadbeef',
    kind: 'process',
    command: 'sleep 60',
    description: 'persisted task',
    pid: 999,
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_001,
    exitCode: null,
    status: 'killed',
    ...overrides,
  };
}

async function taskOutput(manager: BackgroundManager, taskId: string, block = false): Promise<string> {
  const result = await executeTool(
    new TaskOutputTool(manager),
    context('task_output', { task_id: taskId, block, timeout: 1 }),
  );
  expect(result.isError).toBe(false);
  return toolContentString(result);
}

async function executeTaskOutput(
  manager: BackgroundManager,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof executeTool>>> {
  return executeTool(new TaskOutputTool(manager), context('task_output_resolution', args));
}

async function createCandidateTask(options: {
  readonly sessionDir: string;
  readonly replayCandidate?: ConstructorParameters<typeof BackgroundManager>[2];
}): Promise<{ taskId: string; manager: BackgroundManager; persistence: BackgroundTaskPersistence }> {
  const { manager, persistence } = createBackgroundManager({
    sessionDir: options.sessionDir,
    enableWorktreeIsolation: true,
    replayCandidate: options.replayCandidate,
  });
  const taskId = manager.registerTask(
    agentTask(Promise.resolve(editingCandidateCompletion()), 'candidate resolution task'),
  );
  await manager.wait(taskId);
  return { taskId, manager, persistence: persistence! };
}

const candidateIdentity = {
  candidate_hash: '960e0ff0617bdc2d4d4a524fbc4370ffcc6273adab91929c1bb271ea013dba85',
  requested_scope: ['src/widget.ts', 'test/widget.test.ts'],
} as const;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function initReleaseDemoRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'kimi-bg-release-demo-repo-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/widget.ts'), 'export const widget = 1;\n');
  await writeFile(join(repo, 'README.md'), 'release demo\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

async function createRealCandidateTask(options: {
  readonly repo: string;
  readonly sessionDir: string;
  readonly kaos: LocalKaos;
  readonly sourceText: string;
  readonly companionPath: string;
  readonly companionText: string;
  readonly beforeRegister?: () => Promise<void>;
  readonly replayCandidate?: ConstructorParameters<typeof BackgroundManager>[2];
}): Promise<{
  readonly taskId: string;
  readonly candidate: EditingCandidateDraft;
  readonly manager: BackgroundManager;
  readonly persistence: BackgroundTaskPersistence;
}> {
  const worktree = await acquireSubagentWorktree(options.kaos, options.repo, {
    scope: ['src/widget.ts'],
  });
  if (worktree === null) throw new Error('expected local Git worktree isolation');
  await writeFile(join(worktree.cwd, 'src/widget.ts'), options.sourceText);
  await mkdir(dirname(join(worktree.cwd, options.companionPath)), { recursive: true });
  await writeFile(join(worktree.cwd, options.companionPath), options.companionText);
  const finish = await worktree.finish({ kind: 'success' });
  if (finish.candidate === undefined || finish.acknowledgePersisted === undefined) {
    throw new Error('expected scope-expansion candidate');
  }
  const completion = {
    result: 'candidate handoff\nvalidation: local fixture passed',
    editingCandidate: {
      draft: finish.candidate,
      agentId: 'agent-release-demo',
      logicalRunId: 'logical-release-demo',
      originalScope: finish.candidate.scope,
      requestedScope: finish.candidate.requestedScope,
      outsideScope: finish.outsideScope ?? [],
      acknowledgePersisted: finish.acknowledgePersisted,
    },
  };
  await options.beforeRegister?.();
  const created = createBackgroundManager({
    sessionDir: options.sessionDir,
    enableWorktreeIsolation: true,
    kaos: options.kaos,
    replayCandidate: options.replayCandidate,
  });
  const taskId = created.manager.registerTask(
    agentTask(Promise.resolve(completion), 'release demo', { agentId: 'agent-release-demo' }),
  );
  await created.manager.wait(taskId);
  return {
    taskId,
    candidate: finish.candidate,
    manager: created.manager,
    persistence: created.persistence!,
  };
}

describe('TaskListTool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has name "TaskList"', () => {
    expect(new TaskListTool(createBackgroundManager().manager).name).toBe('TaskList');
  });

  it('returns "No background tasks found." when empty', async () => {
    const tool = new TaskListTool(createBackgroundManager().manager);

    const result = await executeTool(tool, context('c_empty', { active_only: true }));

    expect(toolContentString(result)).toContain('No background tasks found');
  });

  it('lists active process tasks', async () => {
    const { manager } = createBackgroundManager();
    registerProcess(manager, pendingProcess(), 'sleep 60', 'test task');

    const result = await executeTool(
      new TaskListTool(manager),
      context('c_active', { active_only: true }),
    );
    const content = toolContentString(result);

    expect(content).toMatch(/^active_background_tasks:\s*1/);
    expect(content).toContain('kind: process');
    expect(content).toContain('command: sleep 60');
    expect(content).toContain('description: test task');
  });

  it('excludes terminal tasks from active_only=true', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, immediateProcess(0), 'echo done', 'done');
    await manager.wait(taskId);

    const result = await executeTool(
      new TaskListTool(manager),
      context('c_active_terminal', { active_only: true }),
    );

    expect(toolContentString(result)).toContain('No background tasks found');
  });

  it('includes terminal tasks and exit_code when active_only=false', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, immediateProcess(7), 'exit 7', 'exit code test');
    await manager.wait(taskId);

    const result = await executeTool(
      new TaskListTool(manager),
      context('c_all_terminal', { active_only: false }),
    );
    const content = toolContentString(result);

    expect(content).toMatch(/^background_tasks:\s*1/);
    expect(content).toContain(taskId);
    expect(content).toContain('status: failed');
    expect(content).toContain('exit_code: 7');
  });

  it('honours the limit parameter', async () => {
    const { manager } = createBackgroundManager();
    const first = registerProcess(manager, pendingProcess(), 'sleep 1', 'one');
    const second = registerProcess(manager, pendingProcess(), 'sleep 2', 'two');

    const result = await executeTool(
      new TaskListTool(manager),
      context('c_limit', { active_only: true, limit: 1 }),
    );
    const content = toolContentString(result);

    expect(content).toContain('active_background_tasks: 1');
    expect(content).toContain(first);
    expect(content).not.toContain(second);
  });

  it('includes stop_reason for stopped tasks in all-tasks view', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'stop reason');
    await manager.stop(taskId, 'superseded by newer task');

    const result = await executeTool(
      new TaskListTool(manager),
      context('c_stop_reason', { active_only: false }),
    );

    expect(toolContentString(result)).toContain(
      'stop_reason: superseded by newer task',
    );
  });

  it('does not sleep when listing a running task', async () => {
    vi.useFakeTimers();
    const { manager } = createBackgroundManager();
    registerProcess(manager, pendingProcess(), 'sleep 60', 'running list');
    const resultPromise = executeTool(
      new TaskListTool(manager),
      context('c_latency', { active_only: true }),
    );

    await Promise.resolve();
    const result = await resultPromise;

    expect(toolContentString(result)).toContain('running list');
  });
});

describe('TaskOutputTool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has name "TaskOutput"', () => {
    expect(new TaskOutputTool(createBackgroundManager().manager).name).toBe('TaskOutput');
  });

  it('returns error for unknown task', async () => {
    const result = await executeTool(
      new TaskOutputTool(createBackgroundManager().manager),
      context('c_unknown', { task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('Task not found');
  });

  it('returns live output when no persisted log is available', async () => {
    const { manager } = createBackgroundManager();
    const payload = 'DETACHED-PAYLOAD-LINE\n';
    const taskId = registerProcess(manager, immediateProcess(0, payload), 'echo demo', 'demo');

    await manager.wait(taskId);
    await waitForOutput(manager, taskId, 'DETACHED-PAYLOAD-LINE');
    const content = await taskOutput(manager, taskId);

    expect(content).toContain('retrieval_status: success');
    expect(content).toContain('status: completed');
    expect(content).toContain('[output]\nDETACHED-PAYLOAD-LINE');
    expect(content).toContain(`output_size_bytes: ${Buffer.byteLength(payload).toString()}`);
    expect(content).not.toContain('output_path:');
  });

  it('returns persisted output path and guidance when a log is available', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-output-tool-'));
    try {
      const { manager } = createBackgroundManager({ sessionDir });
      const taskId = registerProcess(
        manager,
        immediateProcess(0, 'STDOUT-PAYLOAD-LINE\n'),
        'echo demo',
        'output test',
      );

      await manager.wait(taskId);
      await waitForOutput(manager, taskId, 'STDOUT-PAYLOAD-LINE');
      const content = await taskOutput(manager, taskId, true);

      expect(content).toContain('status: completed');
      expect(content).toContain('output_path:');
      expect(content).toContain('full_output_available: true');
      expect(content).toContain('full_output_tool: Read');
      expect(content).toContain('full_output_hint:');
      expect(content).toContain('[output]\nSTDOUT-PAYLOAD-LINE');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('returns agent metadata and final summary without process fields', async () => {
    const { manager } = createBackgroundManager();
    const taskId = manager.registerTask(
      agentTask(
        Promise.resolve({ result: 'SUBAGENT-FINAL-SUMMARY\n' }),
        'agent output test',
        { agentId: 'agent-child', subagentType: 'coder' },
      ),
    );

    await manager.wait(taskId);
    const content = await taskOutput(manager, taskId);

    expect(content).toContain('kind: agent');
    expect(content).toContain('agent_id: agent-child');
    expect(content).toContain('subagent_type: coder');
    expect(content).toContain('[output]\nSUBAGENT-FINAL-SUMMARY');
    expect(content).not.toMatch(/^pid:/m);
    expect(content).not.toMatch(/^command:/m);
    expect(content).not.toMatch(/^exit_code:/m);
  });

  it('reads persisted output for a task loaded after restart', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-output-'));
    try {
      const writer = createBackgroundManager({ sessionDir }).manager;
      const taskId = registerProcess(
        writer,
        immediateProcess(0, 'persisted output\n'),
        'echo persisted output',
        'persist output test',
      );
      await writer.wait(taskId);
      await waitForOutput(writer, taskId, 'persisted output');

      const reader = createBackgroundManager({ sessionDir }).manager;
      await reader.loadFromDisk();
      await reader.reconcile();
      const content = await taskOutput(reader, taskId);

      expect(content).toContain('status: completed');
      expect(content).toContain('output_path:');
      expect(content).toContain('persisted output');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('returns not_ready for non-blocking running tasks', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'running task');

    const content = await taskOutput(manager, taskId);

    expect(content).toContain('retrieval_status: not_ready');
    expect(content).toContain('status: running');
    expect(content).not.toContain('next_step');
  });

  it('returns timeout for block=true when a running task does not finish', async () => {
    // Fake timers drive the real 1s block timeout (taskOutput passes
    // timeout: 1) so the test does not wait a real second.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'blocking task');

    const contentPromise = taskOutput(manager, taskId, true);
    await vi.advanceTimersByTimeAsync(1_000);
    const content = await contentPromise;

    expect(content).toContain('retrieval_status: timeout');
    expect(content).toContain('status: running');
    // A blocking wait that timed out must steer the caller away from blocking
    // again — the completion notification arrives on its own.
    expect(content).toContain('next_step:');
    expect(content).toContain('Do not block on it again');
  });

  it('surfaces timeout terminal metadata', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manager } = createBackgroundManager();
    const taskId = manager.registerTask(
      agentTask(new Promise(() => {}), 'will time out'),
      { timeoutMs: 1 },
    );

    const terminal = manager.wait(taskId);
    await vi.advanceTimersByTimeAsync(5_010);
    await terminal;
    const content = await taskOutput(manager, taskId, true);

    expect(content).toContain('status: timed_out');
    expect(content).not.toContain('stop_reason:');
    expect(content).toContain('terminal_reason: timed_out');
  });

  it('surfaces stopped terminal metadata', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'stoppable task');

    await manager.stop(taskId, 'operator cancelled');
    const content = await taskOutput(manager, taskId);

    expect(content).toContain('status: killed');
    expect(content).toContain('stop_reason: operator cancelled');
    expect(content).toContain('terminal_reason: stopped');
  });

  it('does not advertise output_path when the persisted log file does not exist', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-empty-'));
    try {
      const { manager } = createBackgroundManager({ sessionDir });
      const taskId = registerProcess(manager, immediateProcess(0), 'sleep 1', 'silent task');

      await manager.wait(taskId);
      const content = await taskOutput(manager, taskId);

      expect(content).not.toContain('output_path:');
      expect(content).toContain('output_size_bytes: 0');
      expect(content).toContain('full_output_available: false');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('truncates output > 32 KiB to a tail preview and reports paging metadata', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-trunc-'));
    try {
      const { manager } = createBackgroundManager({ sessionDir });
      const head = 'HEAD-MARKER\n';
      const tail = 'TAIL-MARKER\n';
      const big = head + 'x'.repeat(200 * 1024) + tail;
      const taskId = registerProcess(manager, immediateProcess(0, big), 'echo big', 'large');

      await manager.wait(taskId);
      const content = await taskOutput(manager, taskId);

      expect(content).toContain('output_truncated: true');
      expect(content).toContain(`output_size_bytes: ${Buffer.byteLength(big).toString()}`);
      expect(content).toContain('full_output_available: true');
      expect(content).toContain('full_output_tool: Read');
      expect(content).toContain('[Truncated. Full output:');
      expect(content).toContain('TAIL-MARKER');
      expect(content).not.toContain('HEAD-MARKER');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('lookup of a non-existent task does not create persisted state', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-missing-'));
    try {
      const { manager } = createBackgroundManager({ sessionDir });

      const result = await executeTool(
        new TaskOutputTool(manager),
        context('c_missing', { task_id: 'bash-noex0000' }),
      );

      expect(result.isError).toBe(true);
      expect(await new BackgroundTaskPersistence(sessionDir).listTasks()).toEqual([]);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });


  it('inspects an input_required candidate without blocking and exposes stable actions', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-candidate-inspect-'));
    try {
      const { manager, taskId } = await createCandidateTask({ sessionDir });
      const content = await taskOutput(manager, taskId, true);

      expect(content).toContain('retrieval_status: success');
      expect(content).toContain('status: input_required');
      expect(content).toContain(`candidate_hash: ${candidateIdentity.candidate_hash}`);
      expect(content).toContain('requested_scope: src/widget.ts,test/widget.test.ts');
      expect(content).toContain('available_actions: approve_scope_expansion,deny_scope_expansion');
      expect(content).toContain('[output]\ncandidate handoff');
      expect(content).not.toContain('next_step:');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('denies after restart, retains the bundle, and makes identical denial idempotent', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-candidate-deny-'));
    try {
      const created = await createCandidateTask({ sessionDir });
      const reader = createBackgroundManager({
        sessionDir,
        enableWorktreeIsolation: true,
      }).manager;
      await reader.loadFromDisk();
      await reader.reconcile();

      const args = {
        action: 'deny_scope_expansion',
        task_id: created.taskId,
        ...candidateIdentity,
      };
      const first = await executeTaskOutput(reader, args);
      const duplicate = await executeTaskOutput(reader, args);
      const reverse = await executeTaskOutput(reader, {
        ...args,
        action: 'approve_scope_expansion',
      });

      expect(first.isError).toBe(false);
      expect(toolContentString(first)).toContain('status: expansion_denied');
      expect(toolContentString(first)).toContain('idempotent: false');
      expect(duplicate.isError).toBe(false);
      expect(toolContentString(duplicate)).toContain('idempotent: true');
      expect(reverse.isError).toBe(true);
      expect(toolContentString(reverse)).toContain('resolution_reason: candidate_already_resolved');
      expect(await created.persistence.readEditingCandidate(created.taskId)).toMatchObject({
        resolution: { kind: 'denied' },
      });
      expect(await readFile(created.persistence.taskOutputFile(created.taskId), 'utf-8')).toBe('candidate handoff');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('approves after restart exactly once and preserves the immutable bundle', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-candidate-approve-'));
    const replayCandidate = vi.fn(async () => ({ applied: true as const }));
    try {
      const created = await createCandidateTask({ sessionDir });
      const reader = createBackgroundManager({
        sessionDir,
        enableWorktreeIsolation: true,
        replayCandidate,
      }).manager;
      await reader.loadFromDisk();
      await reader.reconcile();
      const args = {
        action: 'approve_scope_expansion',
        task_id: created.taskId,
        ...candidateIdentity,
      };

      const [first, duplicate] = await Promise.all([
        executeTaskOutput(reader, args),
        executeTaskOutput(reader, args),
      ]);

      expect(first.isError).toBe(false);
      expect(toolContentString(first)).toContain('status: completed');
      expect(toolContentString(first)).toContain('idempotent: false');
      expect(duplicate.isError).toBe(false);
      expect(toolContentString(duplicate)).toContain('idempotent: true');
      expect(replayCandidate).toHaveBeenCalledTimes(1);
      expect(replayCandidate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ candidateHash: candidateIdentity.candidate_hash }),
        candidateIdentity.requested_scope,
      );
      expect(await created.persistence.readEditingCandidate(created.taskId)).toMatchObject({
        resolution: { kind: 'approved_applied' },
      });
      expect(await readFile(created.persistence.taskOutputFile(created.taskId), 'utf-8')).toBe('candidate handoff');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('runs the complete local Git release demonstration without provider or tool dispatch', async () => {
    const roots: string[] = [];
    const kaos = await LocalKaos.create();
    const providerBoundary = {
      generation: vi.fn(),
      resume: vi.fn(),
      retry: vi.fn(),
      routeSubstitution: vi.fn(),
      Agent: vi.fn(),
      AgentSwarm: vi.fn(),
    };
    try {
      const approveRepo = await initReleaseDemoRepo();
      const approveSession = await mkdtemp(join(tmpdir(), 'kimi-bg-release-demo-approve-'));
      roots.push(approveRepo, approveSession);
      await writeFile(join(approveRepo, 'README.md'), 'release demo\ndirty tracked baseline\n');
      await writeFile(join(approveRepo, 'scratch.txt'), 'dirty untracked baseline\n');
      const approveBaseline = {
        source: await readFile(join(approveRepo, 'src/widget.ts'), 'utf8'),
        readme: await readFile(join(approveRepo, 'README.md'), 'utf8'),
        scratch: await readFile(join(approveRepo, 'scratch.txt'), 'utf8'),
      };
      const approveCreated = await createRealCandidateTask({
        repo: approveRepo,
        sessionDir: approveSession,
        kaos,
        sourceText: 'export const widget = 2;\n',
        companionPath: 'test/widget.test.ts',
        companionText: 'expect(widget).toBe(2);\n',
        beforeRegister: async () => {
          await writeFile(join(approveRepo, 'README.md'), `${approveBaseline.readme}unrelated drift\n`);
        },
        replayCandidate: applySubagentWorktreeCandidate,
      });
      expect(approveCreated.candidate.paths.map((path) => path.relPath)).toEqual([
        'src/widget.ts',
        'test/widget.test.ts',
      ]);
      expect(await readFile(join(approveRepo, 'src/widget.ts'), 'utf8')).toBe('export const widget = 2;\n');
      expect(await readFile(join(approveRepo, 'test/widget.test.ts'), 'utf8')).toBe('expect(widget).toBe(2);\n');
      expect(await readFile(join(approveRepo, 'README.md'), 'utf8')).toBe(
        `${approveBaseline.readme}unrelated drift\n`,
      );
      expect(await readFile(join(approveRepo, 'scratch.txt'), 'utf8')).toBe(approveBaseline.scratch);

      const approveReader = createBackgroundManager({
        sessionDir: approveSession,
        enableWorktreeIsolation: true,
        kaos,
        replayCandidate: applySubagentWorktreeCandidate,
      }).manager;
      await approveReader.loadFromDisk();
      await approveReader.reconcile();
      const inspected = await taskOutput(approveReader, approveCreated.taskId, true);
      expect(inspected).toContain('status: completed');
      expect(inspected).toContain('candidate handoff');
      expect(inspected).toContain(`candidate_hash: ${approveCreated.candidate.candidateHash}`);
      expect(inspected).toContain('resolution: approved_applied');

      const duplicateApproval = await executeTaskOutput(approveReader, {
        action: 'approve_scope_expansion',
        task_id: approveCreated.taskId,
        candidate_hash: approveCreated.candidate.candidateHash,
        requested_scope: approveCreated.candidate.requestedScope,
      });
      expect(duplicateApproval.isError, toolContentString(duplicateApproval)).toBe(false);
      expect(toolContentString(duplicateApproval)).toContain('status: completed');
      expect(toolContentString(duplicateApproval)).toContain('idempotent: true');
      expect(await readFile(join(approveRepo, 'src/widget.ts'), 'utf8')).toBe('export const widget = 2;\n');
      expect(await readFile(join(approveRepo, 'test/widget.test.ts'), 'utf8')).toBe('expect(widget).toBe(2);\n');
      expect(await readFile(join(approveRepo, 'README.md'), 'utf8')).toBe(
        `${approveBaseline.readme}unrelated drift\n`,
      );
      expect(await readFile(join(approveRepo, 'scratch.txt'), 'utf8')).toBe(approveBaseline.scratch);
      expect(await approveCreated.persistence.readEditingCandidate(approveCreated.taskId)).toMatchObject({
        resolution: { kind: 'approved_applied' },
      });

      const denyRepo = await initReleaseDemoRepo();
      const denySession = await mkdtemp(join(tmpdir(), 'kimi-bg-release-demo-deny-'));
      roots.push(denyRepo, denySession);
      const denyCreated = await createRealCandidateTask({
        repo: denyRepo,
        sessionDir: denySession,
        kaos,
        sourceText: 'export const widget = 3;\n',
        companionPath: 'test/widget.test.ts',
        companionText: 'expect(widget).toBe(3);\n',
        replayCandidate: vi.fn(async () => {
          throw new Error('candidate_policy_decision: retained for explicit denial');
        }),
      });
      expect(denyCreated.manager.getTask(denyCreated.taskId)).toMatchObject({ status: 'input_required' });
      const denyReader = createBackgroundManager({
        sessionDir: denySession,
        enableWorktreeIsolation: true,
        kaos,
      }).manager;
      await denyReader.loadFromDisk();
      await denyReader.reconcile();
      const denial = await executeTaskOutput(denyReader, {
        action: 'deny_scope_expansion',
        task_id: denyCreated.taskId,
        candidate_hash: denyCreated.candidate.candidateHash,
        requested_scope: denyCreated.candidate.requestedScope,
      });
      expect(denial.isError).toBe(false);
      expect(toolContentString(denial)).toContain('status: expansion_denied');
      expect(await readFile(join(denyRepo, 'src/widget.ts'), 'utf8')).toBe('export const widget = 1;\n');
      await expect(stat(join(denyRepo, 'test/widget.test.ts'))).rejects.toThrow();
      expect(await denyCreated.persistence.readEditingCandidate(denyCreated.taskId)).toMatchObject({
        resolution: { kind: 'denied' },
      });

      const conflictRepo = await initReleaseDemoRepo();
      const conflictSession = await mkdtemp(join(tmpdir(), 'kimi-bg-release-demo-conflict-'));
      roots.push(conflictRepo, conflictSession);
      const conflictCreated = await createRealCandidateTask({
        repo: conflictRepo,
        sessionDir: conflictSession,
        kaos,
        sourceText: 'export const widget = 4;\n',
        companionPath: 'test/widget.test.ts',
        companionText: 'expect(widget).toBe(4);\n',
        beforeRegister: async () => {
          await writeFile(join(conflictRepo, 'src/widget.ts'), 'export const widget = 99;\n');
        },
        replayCandidate: applySubagentWorktreeCandidate,
      });
      expect(conflictCreated.manager.getTask(conflictCreated.taskId)).toMatchObject({
        status: 'input_required',
      });
      const conflictReader = createBackgroundManager({
        sessionDir: conflictSession,
        enableWorktreeIsolation: true,
        kaos,
        replayCandidate: applySubagentWorktreeCandidate,
      }).manager;
      await conflictReader.loadFromDisk();
      await conflictReader.reconcile();
      const conflict = await executeTaskOutput(conflictReader, {
        action: 'approve_scope_expansion',
        task_id: conflictCreated.taskId,
        candidate_hash: conflictCreated.candidate.candidateHash,
        requested_scope: conflictCreated.candidate.requestedScope,
      });
      expect(conflict.isError).toBe(true);
      expect(toolContentString(conflict)).toContain('resolution_reason: candidate_path_diverged');
      expect(await readFile(join(conflictRepo, 'src/widget.ts'), 'utf8')).toBe(
        'export const widget = 99;\n',
      );
      await expect(stat(join(conflictRepo, 'test/widget.test.ts'))).rejects.toThrow();
      expect(conflictReader.getTask(conflictCreated.taskId)).toMatchObject({ status: 'input_required' });
      expect(
        (await conflictCreated.persistence.readEditingCandidate(conflictCreated.taskId))?.resolution,
      ).toBeUndefined();

      for (const spy of Object.values(providerBoundary)) expect(spy).not.toHaveBeenCalled();
    } finally {
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it('rejects disabled, stale identity, replay conflicts, and corrupt payload without state mutation', async () => {
    const cases = [
      {
        label: 'disabled',
        managerOptions: { enableWorktreeIsolation: false },
        args: candidateIdentity,
        expected: 'candidate_resolution_disabled',
      },
      {
        label: 'stale hash',
        managerOptions: { enableWorktreeIsolation: true },
        args: { ...candidateIdentity, candidate_hash: 'stale-hash' },
        expected: 'candidate_identity_mismatch',
      },
      {
        label: 'stale scope',
        managerOptions: { enableWorktreeIsolation: true },
        args: { ...candidateIdentity, requested_scope: ['src/widget.ts'] },
        expected: 'candidate_identity_mismatch',
      },
      {
        label: 'path conflict',
        managerOptions: {
          enableWorktreeIsolation: true,
          replayCandidate: vi.fn(async () => { throw new Error('candidate_path_diverged: src/widget.ts'); }),
        },
        args: candidateIdentity,
        expected: 'candidate_path_diverged',
      },
      {
        label: 'rolled back apply failure',
        managerOptions: {
          enableWorktreeIsolation: true,
          replayCandidate: vi.fn(async () => { throw new Error('write failed'); }),
        },
        args: candidateIdentity,
        expected: 'apply_failed_rolled_back',
      },
      {
        label: 'incomplete rollback',
        managerOptions: {
          enableWorktreeIsolation: true,
          replayCandidate: vi.fn(async () => { throw new Error('write failed; guarded rollback incomplete: src/widget.ts'); }),
        },
        args: candidateIdentity,
        expected: 'apply_failed_recovery_required',
      },
    ] as const;

    for (const testCase of cases) {
      const sessionDir = await mkdtemp(join(tmpdir(), `kimi-bg-candidate-${testCase.label}-`));
      try {
        const created = await createCandidateTask({ sessionDir });
        const reader = createBackgroundManager({
          sessionDir,
          ...testCase.managerOptions,
        }).manager;
        await reader.loadFromDisk();
        const result = await executeTaskOutput(reader, {
          action: 'approve_scope_expansion',
          task_id: created.taskId,
          ...testCase.args,
        });
        expect(result.isError).toBe(true);
        expect(toolContentString(result)).toContain(`resolution_reason: ${testCase.expected}`);
        expect(reader.getTask(created.taskId)).toMatchObject({ status: 'input_required' });
        expect((await created.persistence.readEditingCandidate(created.taskId))?.resolution).toBeUndefined();
      } finally {
        await rm(sessionDir, { recursive: true, force: true });
      }
    }

    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-candidate-corrupt-'));
    try {
      const created = await createCandidateTask({ sessionDir });
      await writeFile(
        join(sessionDir, 'tasks', created.taskId, 'candidate', 'worker-final', 'src/widget.ts'),
        'tampered payload',
      );
      const reader = createBackgroundManager({ sessionDir, enableWorktreeIsolation: true }).manager;
      await reader.loadFromDisk();
      const result = await executeTaskOutput(reader, {
        action: 'approve_scope_expansion',
        task_id: created.taskId,
        ...candidateIdentity,
      });
      expect(result.isError).toBe(true);
      expect(toolContentString(result)).toContain('resolution_reason: candidate_corrupt');
      expect(reader.getTask(created.taskId)).toMatchObject({ status: 'input_required' });
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('TaskStopTool', () => {
  it('has name "TaskStop"', () => {
    expect(new TaskStopTool(createBackgroundManager().manager).name).toBe('TaskStop');
  });

  it('returns error for unknown task', async () => {
    const result = await executeTool(
      new TaskStopTool(createBackgroundManager().manager),
      context('c_unknown', { task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('Task not found');
  });

  it('stops a running task and records the reason', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'stop test');

    const result = await executeTool(
      new TaskStopTool(manager),
      context('c_stop', { task_id: taskId, reason: 'custom stop reason' }),
    );

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('status: killed');
    expect(toolContentString(result)).toContain('custom stop reason');
    expect(manager.getTask(taskId)?.stopReason).toBe('custom stop reason');
  });

  it('does not steer a terminal notification for model-requested stops', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'stop test');

    const result = await executeTool(
      new TaskStopTool(manager),
      context('c_stop_silent', { task_id: taskId }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('status: killed');
    expect(agent.turn.steer).not.toHaveBeenCalled();
    expect(manager.getTask(taskId)).toMatchObject({
      status: 'killed',
      terminalNotificationSuppressed: true,
    });
  });

  it('persists stop reason when the manager has persistence', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-stop-reason-'));
    try {
      const writer = createBackgroundManager({ sessionDir }).manager;
      const taskId = registerProcess(writer, pendingProcess(), 'sleep 60', 'persist stop');

      const result = await executeTool(
        new TaskStopTool(writer),
        context('c_stop_reason', { task_id: taskId, reason: 'operator cancelled' }),
      );
      expect(result.isError).toBe(false);

      const { agent, manager: reader } = createBackgroundManager({ sessionDir });
      await reader.loadFromDisk();
      expect(reader.getTask(taskId)).toMatchObject({
        stopReason: 'operator cancelled',
        terminalNotificationSuppressed: true,
      });
      await reader.reconcile();
      expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'an empty-string reason', reason: '' },
    { label: 'a whitespace-only reason', reason: '   ' },
    { label: 'an omitted reason', reason: undefined as string | undefined },
  ])('falls back to default reason given $label', async ({ reason }) => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'empty reason test');

    const result = await executeTool(
      new TaskStopTool(manager),
      context('c_empty_reason', { task_id: taskId, reason }),
    );

    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('reason: Stopped by TaskStop');
    expect(manager.getTask(taskId)?.stopReason).toBe('Stopped by TaskStop');
  });

  it('returns info when task is already terminal', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(manager, immediateProcess(0), 'echo done', 'terminal test');
    await manager.wait(taskId);

    const result = await executeTool(
      new TaskStopTool(manager),
      context('c_terminal', { task_id: taskId }),
    );

    expect(result.isError).toBe(false);
    expect(toolContentString(result).trim().split('\n')).toEqual([
      `task_id: ${taskId}`,
      'status: completed',
      'reason: Task already in terminal state',
    ]);
    expect(manager.getTask(taskId)?.terminalNotificationSuppressed).not.toBe(true);
  });

  it('falls back to the placeholder when a terminal task has a blank stored reason', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-blank-stored-reason-'));
    try {
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(persistedProcess({ stopReason: '' }));
      const reader = createBackgroundManager({ sessionDir }).manager;
      await reader.loadFromDisk();

      const result = await executeTool(
        new TaskStopTool(reader),
        context('c_blank_stored', { task_id: 'bash-deadbeef' }),
      );

      expect(result.isError).toBe(false);
      expect(toolContentString(result).trim().split('\n')[2]).toBe(
        'reason: Task already in terminal state',
      );
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('background tool descriptions', () => {
  const manager = createBackgroundManager().manager;

  it('TaskOutput description mentions background tasks, block, output_path, and Read', () => {
    const description = new TaskOutputTool(manager).description;

    expect(description).toMatch(/background/i);
    expect(description).toMatch(/block/);
    expect(description).toMatch(/output_path/);
    expect(description).toMatch(/Read/);
    // terminal_reason can also be `failed` (task-output.ts terminalReason), not
    // just timed_out / stopped — the description must enumerate it.
    expect(description).toContain('`failed`');
    // ...but a plain non-zero command exit carries no terminal_reason/stop_reason —
    // the description must point the model at exit_code for that common failure.
    expect(description).toContain('exit_code');
    // Backstop: don't let the model use TaskOutput to sit and wait for a result it needs.
    expect(description).toContain('run that task in the foreground instead');
  });

  it('TaskList description mentions active_only default, read-only, and plan-mode safety', () => {
    const description = new TaskListTool(manager).description;

    expect(description).toMatch(/active_only/);
    expect(description).toMatch(/read[- ]only/i);
    expect(description).toMatch(/plan[- ]mode/i);
    expect(description).toMatch(/background tasks?/i);
    // command/PID/exit-code are shell-task fields only (ProcessBackgroundTaskInfo).
    expect(description).toMatch(/shell tasks/i);
  });

  it('TaskStop description clarifies destructive cancellation and generic behavior', () => {
    const description = new TaskStopTool(manager).description;

    expect(description).toMatch(/destructive/i);
    expect(description).toMatch(/cancel/i);
    expect(description).toMatch(/general[-\s]?purpose|generic/i);
    expect(description).toMatch(/long runtime/i);
    expect(description).toMatch(/empty buffered output/i);
    expect(description).toMatch(/explicit user confirmation/i);
    expect(description).toMatch(/resume/i);
    expect(description).not.toMatch(/bash[- ]?only/i);
  });
});
