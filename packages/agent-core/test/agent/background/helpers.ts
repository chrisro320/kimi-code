import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import { vi } from 'vitest';

import {
  AgentBackgroundTask,
  BackgroundManager,
  BackgroundTaskPersistence,
  ProcessBackgroundTask,
  type BackgroundTaskInfo,
} from '../../../src/agent/background';
import type {
  SessionSubagentHost,
  SubagentCompletion,
  SubagentHandle,
} from '../../../src/session/subagent-host';
import type { AgentEvent } from '../../../src/rpc/events';
import { FlagResolver } from '../../../src/flags/resolver';

export interface FakeBackgroundAgent {
  emitEvent: ReturnType<typeof vi.fn>;
  emittedEvents: AgentEvent[];
  kimiConfig?: { background?: { maxRunningTasks?: number } };
  telemetry: { track: ReturnType<typeof vi.fn> };
  context: { appendUserMessage: ReturnType<typeof vi.fn> };
  turn: { steer: ReturnType<typeof vi.fn> };
  hooks?: { fireAndForgetTrigger: ReturnType<typeof vi.fn> };
  kaos: Kaos;
  experimentalFlags: FlagResolver;
}

export interface BackgroundManagerFixture {
  agent: FakeBackgroundAgent;
  manager: BackgroundManager;
  persistence?: BackgroundTaskPersistence;
}

export function createBackgroundManager(options: {
  sessionDir?: string;
  maxRunningTasks?: number;
  hooks?: FakeBackgroundAgent['hooks'];
  kaos?: Kaos;
  enableWorktreeIsolation?: boolean;
  replayCandidate?: ConstructorParameters<typeof BackgroundManager>[2];
} = {}): BackgroundManagerFixture {
  const emittedEvents: AgentEvent[] = [];
  const agent: FakeBackgroundAgent = {
    emittedEvents,
    emitEvent: vi.fn((event: AgentEvent) => {
      emittedEvents.push(event);
    }),
    kimiConfig:
      options.maxRunningTasks === undefined
        ? undefined
        : { background: { maxRunningTasks: options.maxRunningTasks } },
    telemetry: { track: vi.fn() },
    context: { appendUserMessage: vi.fn() },
    turn: { steer: vi.fn() },
    hooks: options.hooks,
    kaos: options.kaos ?? ({} as Kaos),
    experimentalFlags: new FlagResolver({}, undefined, {
      'subagent-worktree-isolation': options.enableWorktreeIsolation ?? false,
    }),
  };
  const persistence =
    options.sessionDir === undefined
      ? undefined
      : new BackgroundTaskPersistence(options.sessionDir);
  return {
    agent,
    manager: new BackgroundManager(agent as never, persistence, options.replayCandidate),
    persistence,
  };
}

export function registerProcess(
  manager: BackgroundManager,
  proc: KaosProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessBackgroundTask(proc, command, description));
}

export function agentTask(
  completion: Promise<SubagentCompletion>,
  description: string,
  options: {
    readonly agentId?: string;
    readonly subagentType?: string;
    readonly subagentHost?: Pick<SessionSubagentHost, 'markActiveChildDetached'>;
    readonly abortController?: AbortController;
  } = {},
): AgentBackgroundTask {
  const handle: SubagentHandle = {
    agentId: options.agentId ?? 'agent-child',
    profileName: options.subagentType ?? 'coder',
    resumed: false,
    completion,
  };
  return new AgentBackgroundTask(
    handle,
    description,
    options.subagentHost ?? { markActiveChildDetached: vi.fn() },
    options.abortController ?? new AbortController(),
  );
}

export function editingCandidateCompletion(options: {
  acknowledgePersisted?: () => Promise<void>;
} = {}): SubagentCompletion {
  return {
    result: 'candidate handoff',
    editingCandidate: {
      draft: {
        version: 1,
        candidateHash: '960e0ff0617bdc2d4d4a524fbc4370ffcc6273adab91929c1bb271ea013dba85',
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
              state: { kind: 'regular', mode: 0o100644, sha256: '18432423c770c61fe19e0282020eb7749c3cfea665a33e200d5d9bc1afb47cd7' },
              payload: Buffer.from('source payload'),
            },
          },
          {
            relPath: 'test/widget.test.ts',
            classification: 'scope_expansion_requested',
            before: { state: { kind: 'absent' } },
            after: {
              state: { kind: 'regular', mode: 0o100644, sha256: '813ca5285c28ccee5cab8b10ebda9c908fd6d78ed9dc94cc65ea6cb67a7f13ae' },
              payload: Buffer.from('test payload'),
            },
          },
        ],
      },
      agentId: 'agent-child',
      logicalRunId: 'logical-run',
      originalScope: ['src/widget.ts'],
      requestedScope: ['src/widget.ts', 'test/widget.test.ts'],
      outsideScope: ['test/widget.test.ts'],
      acknowledgePersisted: options.acknowledgePersisted ?? (async () => {}),
    },
  };
}

export async function waitForTerminal(
  manager: BackgroundManager,
  taskId: string,
  timeoutMs = 30_000,
): Promise<BackgroundTaskInfo | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const info = await manager.wait(taskId, 5);
    if (
      info?.status === 'completed' ||
      info?.status === 'failed' ||
      info?.status === 'timed_out' ||
      info?.status === 'killed' ||
      info?.status === 'lost'
    ) {
      return info;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return manager.getTask(taskId);
}

export async function waitForOutput(
  manager: BackgroundManager,
  taskId: string,
  expected: string,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const output = await manager.readOutput(taskId);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for output: ${expected}`);
}
