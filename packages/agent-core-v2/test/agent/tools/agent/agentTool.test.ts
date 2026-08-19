/**
 * `tools` domain — SubagentTool worktree-isolation wiring tests.
 *
 * Covers the AC3 pool-slot lifecycle contract: the isolation acquire sits
 * inside the pool-slot hold window (`resolveSpawnRoute` returned the slot),
 * so an acquire failure must release the slot exactly once — otherwise the
 * B5-R leak (slot held forever when a spawn fails before the agent handle
 * exists) regresses. The sensitivity check is structural: with the release
 * removed from the catch path, the `releaseCalls` assertion below fails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { CollectionView } from '#/_base/di/collection';
import type { ILogService } from '#/_base/log/log';
import type { RunnableToolExecution } from '#/tool/toolContract';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IEventBus } from '#/app/event/eventBus';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionSubagentRoutingService } from '#/session/subagent/routingService';
import { ISessionSubagentCircuitService } from '#/session/subagent/circuitService';
import { IFlagService } from '#/app/flag/flag';
import { IConfigService } from '#/app/config/config';
import { IModelCatalog } from '#/kosong/model/catalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IGitService } from '#/app/git/git';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IAgentTaskService } from '#/agent/task/task';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';

import { SubagentTool } from '#/agent/tools/agent/agentTool';
import type { SubagentToolInput } from '#/agent/tools/agent/agent';

const WORK_DIR = '/tmp/ac3-worktree-test';

// Acquisition needs a real git repository, which this harness does not have.
// The override stands in a fake handle so the tests can observe what the spawn
// path does with one; unset, every caller runs the real implementation.
const worktreeMock = vi.hoisted(() => ({
  acquire: undefined as undefined | (() => unknown),
}));

vi.mock('#/session/subagent/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/session/subagent/worktree')>();
  return {
    ...actual,
    acquireSubagentWorktree: async (services: never, cwd: string, options: never) =>
      worktreeMock.acquire === undefined
        ? await actual.acquireSubagentWorktree(services, cwd, options)
        : worktreeMock.acquire(),
  };
});

function editingProfile(tools: readonly string[] | undefined): AgentProfile {
  return {
    name: 'coder',
    description: 'test',
    whenToUse: 'test',
    tools,
  } as unknown as AgentProfile;
}

function makeTool(deps: {
  routing: unknown;
  git: Partial<IGitService>;
  create?: ReturnType<typeof vi.fn>;
  flagsEnabled?: boolean;
  profile?: AgentProfile;
  run?: ReturnType<typeof vi.fn>;
  isolation?: 'strict' | 'best-effort';
}): SubagentTool {
  const accessor = {
    get: (id: unknown) => {
      if (id === IAgentPermissionModeService) return { setMode: () => {}, mode: 'acceptEdits' };
      if (id === IAgentUserToolService) return { inheritUserTools: () => {} };
      if (id === IAgentProfileService) {
        return { data: () => ({ modelAlias: 'test-model', thinkingLevel: 'high', profileName: 'main' }) };
      }
      // `emitAgentRunSpawned` publishes through these and tolerates their
      // absence; the tests that reach it only care about what happens after.
      if (id === IEventBus || id === IEventDispatcher || id === IAgentLifecycleService) return undefined;
      if (id === ITelemetryService) return noopTelemetryService;
      throw new Error(`unexpected accessor.get(${String(id)})`);
    },
  };
  const handle = { id: 'main', accessor } as unknown as IAgentScopeHandle;
  return new SubagentTool(
    {
      get: (id: string) => (id === 'main' ? handle : undefined),
      create: deps.create ?? vi.fn(async () => ({ id: 'agent-1', accessor }) as unknown as IAgentScopeHandle),
    } as unknown as IAgentLifecycleService,
    { run: deps.run ?? vi.fn() } as unknown as ISessionSubagentService,
    {
      ready: Promise.resolve(),
      get: () => deps.profile ?? editingProfile(['Write', 'Edit']),
      list: () => [],
      getDefault: () => ({ subagents: [] }),
    } as unknown as ISessionAgentProfileCatalog,
    { agentId: 'main', scope: () => '' } as IAgentScopeContext,
    {} as IAgentTaskService,
    { data: () => ({ modelAlias: 'test-model', thinkingLevel: 'high', profileName: 'main' }) } as unknown as IAgentProfileService,
    { isToolActive: () => false, isToolActiveForProfile: () => false } as unknown as IAgentToolPolicyService,
    { listReferences: () => [] } as unknown as IAgentToolRegistryService,
    { workDir: WORK_DIR, additionalDirs: [] } as unknown as ISessionWorkspaceContext,
    {
      acquire: () => ({
        runtime: { identity: { runtimeId: 'test-runtime' }, process: undefined },
        dispose: () => {},
      }),
    } as unknown as IAgentRuntimeService,
    { read: async () => ({}) } as unknown as ISessionMetadata,
    { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as unknown as ILogService,
    { mode: 'acceptEdits', setMode: () => {} } as unknown as IAgentPermissionModeService,
    {
      get: () => (deps.isolation === undefined ? undefined : { isolation: deps.isolation }),
    } as unknown as IConfigService,
    { enabled: (id: string) => (deps.flagsEnabled ?? true) || id === 'secondary-model' } as unknown as IFlagService,
    { get: () => ({}) } as unknown as IModelCatalog,
    deps.routing as unknown as ISessionSubagentRoutingService,
    { openCircuit: () => {} } as unknown as ISessionSubagentCircuitService,
    deps.git as IGitService,
    {} as IHostFileSystem,
    {} as IHostProcessService,
    { items: [], records: [] } as unknown as CollectionView<AgentToolContribution>,
  );
}

const args = (): SubagentToolInput => ({
  prompt: 'do the thing',
  description: 'ac3 test',
  subagent_type: 'coder',
  dispatch: { scope: ['src'] },
});

describe('SubagentTool worktree isolation wiring', () => {
  let releaseCalls: number;
  let releasePoolSlot: () => void;

  beforeEach(() => {
    releaseCalls = 0;
    releasePoolSlot = () => {
      releaseCalls += 1;
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    worktreeMock.acquire = undefined;
  });

  it('releases the pool slot exactly once when isolation acquire fails (AC3)', async () => {
    // Sensitivity: with the slot release removed from the spawn-failure
    // catch, this assertion fails — the leak the test guards against.
    const create = vi.fn(async () => {
      throw new Error('lifecycle.create must not be reached');
    });
    const tool = makeTool({
      routing: {
        resolveSpawnRoute: async () => ({
          route: { modelAlias: 'routed-model', thinkingEffort: 'max', circuitKey: 'k' },
          releasePoolSlot,
        }),
      },
      git: { repoInfo: async () => null }, // not a git repository → unsupported
      create,
      isolation: 'strict', // best-effort would dispatch unisolated instead of refusing
    });

    const execution = (await tool.resolveExecution(args())) as RunnableToolExecution;
    const result = await execution.execute({
      toolCallId: 'call-1',
      signal: new AbortController().signal,
    } as never);

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('Editing subagent isolation is unavailable');
    expect(releaseCalls).toBe(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not release any pool slot when isolation is not requested', async () => {
    const create = vi.fn(async () => {
      throw new Error('lifecycle.create must not be reached');
    });
    const tool = makeTool({
      routing: {
        resolveSpawnRoute: async () => ({
          route: { modelAlias: 'routed-model', thinkingEffort: 'max', circuitKey: 'k' },
          releasePoolSlot,
        }),
      },
      git: { repoInfo: async () => null },
      create,
      flagsEnabled: false,
    });

    const execution = (await tool.resolveExecution(args())) as RunnableToolExecution;
    const result = await execution.execute({
      toolCallId: 'call-1',
      signal: new AbortController().signal,
    } as never);

    // Flag off → no isolation → spawn proceeds; the failure here comes from
    // lifecycle.create, and the pool slot must still be released.
    expect(result.isError).toBe(true);
    expect(releaseCalls).toBe(1);
  });

  it('isolates a profile that declares no tool list', async () => {
    // An absent tool list means the profile inherits the full default set,
    // Write/Edit included. Reading it as an empty list would silently skip
    // isolation for every profile that does not spell its tools out — the
    // common shape for user-defined agents.
    const create = vi.fn(async () => {
      throw new Error('lifecycle.create must not be reached');
    });
    const tool = makeTool({
      routing: { resolveSpawnRoute: async () => undefined },
      git: { repoInfo: async () => null },
      create,
      isolation: 'strict', // best-effort would dispatch unisolated instead of refusing
      profile: editingProfile(undefined),
    });

    const execution = (await tool.resolveExecution(args())) as RunnableToolExecution;
    const result = await execution.execute({
      toolCallId: 'call-1',
      signal: new AbortController().signal,
    } as never);

    expect(String(result.output)).toContain('Editing subagent isolation is unavailable');
    expect(create).not.toHaveBeenCalled();
  });

  it('discards the worktree when the spawn fails after acquiring it', async () => {
    // Nothing else ever will: the completion handler that finishes a worktree
    // is only attached once the child's run has started.
    const finish = vi.fn(async () => ({ applied: false, reason: 'discarded' }));
    worktreeMock.acquire = () => ({ cwd: '/tmp/wt', finish });
    const create = vi.fn(async () => {
      throw new Error('lifecycle exploded');
    });
    const tool = makeTool({
      routing: { resolveSpawnRoute: async () => ({ route: { circuitKey: 'k' }, releasePoolSlot }) },
      git: {},
      create,
    });

    const execution = (await tool.resolveExecution(args())) as RunnableToolExecution;
    const result = await execution.execute({
      toolCallId: 'call-1',
      signal: new AbortController().signal,
    } as never);

    expect(result.isError).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({
      kind: 'discard',
      reason: 'spawn aborted before the child started',
    });
    expect(releaseCalls).toBe(1);
  });

  it('discards the worktree when the run rejects before it starts', async () => {
    const finish = vi.fn(async () => ({ applied: false, reason: 'discarded' }));
    worktreeMock.acquire = () => ({ cwd: '/tmp/wt', finish });
    const tool = makeTool({
      routing: { resolveSpawnRoute: async () => ({ route: { circuitKey: 'k' }, releasePoolSlot }) },
      git: {},
      run: vi.fn(async () => {
        throw new Error('run rejected');
      }),
    });

    const execution = (await tool.resolveExecution(args())) as RunnableToolExecution;
    const result = await execution.execute({
      toolCallId: 'call-1',
      signal: new AbortController().signal,
    } as never);

    expect(result.isError).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({
      kind: 'discard',
      reason: 'spawn aborted before the child started',
    });
    expect(releaseCalls).toBe(1);
  });

  // A workspace that cannot host a worktree at all is not the same as isolation
  // failing: `best-effort` (the default) dispatches unisolated with a warning,
  // `strict` refuses. Without this, turning the isolation flag on by default
  // would break every user who runs kimi outside a git repository.
  it.each([
    ['best-effort', 'best-effort' as const],
    ['unset (defaults to best-effort)', undefined],
  ])(
    'dispatches unisolated when the workspace cannot host a worktree — isolation: %s',
    async (_label: string, isolation: 'best-effort' | undefined) => {
      // Reaching `create` at all is the assertion: under `strict` the dispatch
      // is refused before it. What it throws afterwards is not this test's
      // subject — the other cases in this file cover the spawn-failure paths.
      const create = vi.fn(async (_options: { readonly workspaceCwd?: string }) => {
        throw new Error('spawn stops here');
      });
      const tool = makeTool({
        routing: {
          resolveSpawnRoute: async () => ({ route: { circuitKey: 'k' }, releasePoolSlot }),
        },
        git: { repoInfo: async () => null }, // not a git repository → unsupported
        create,
        isolation,
      });

      const execution = (await tool.resolveExecution(args())) as RunnableToolExecution;
      const result = await execution.execute({
        toolCallId: 'call-1',
        signal: new AbortController().signal,
      } as never);

      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]?.[0]).toMatchObject({ workspaceCwd: undefined });
      expect(JSON.stringify(result)).not.toContain('isolation is unavailable here');
    },
  );

  // The guard sits on the spawn path itself, not behind the isolation flag —
  // v1 refuses the dispatch outright, and an unscoped editing subagent writes
  // straight back to the workspace when isolation is off.
  it.each([true, false])(
    'refuses an editing dispatch with no scope (isolation flag: %s)',
    async (flagsEnabled: boolean) => {
      const create = vi.fn();
      const tool = makeTool({
        routing: {
          resolveSpawnRoute: async () => ({ route: { circuitKey: 'k' }, releasePoolSlot }),
        },
        git: {},
        create,
        flagsEnabled,
      });

      const execution = (await tool.resolveExecution({
        ...args(),
        dispatch: undefined,
      })) as RunnableToolExecution;
      const result = await execution.execute({
        toolCallId: 'call-1',
        signal: new AbortController().signal,
      } as never);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        'An editing-capable dispatch requires at least one scope entry.',
      );
      expect(create).not.toHaveBeenCalled();
      expect(releaseCalls).toBe(1);
    },
  );
});
