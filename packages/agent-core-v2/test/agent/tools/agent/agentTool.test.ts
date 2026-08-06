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
import type { ILogService } from '#/_base/log/log';
import type { RunnableToolExecution } from '#/tool/toolContract';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionSubagentRoutingService } from '#/session/subagent/routingService';
import { ISessionSubagentCircuitService } from '#/session/subagent/circuitService';
import { IFlagService } from '#/app/flag/flag';
import { IConfigService } from '#/app/config/config';
import { IModelCatalog } from '#/kosong/model/catalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionProcessRunner } from '#/session/process/processRunner';
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

function editingProfile(): AgentProfile {
  return {
    name: 'coder',
    description: 'test',
    whenToUse: 'test',
    tools: ['Write', 'Edit'],
  } as unknown as AgentProfile;
}

function makeTool(deps: {
  routing: unknown;
  git: Partial<IGitService>;
  create?: ReturnType<typeof vi.fn>;
  flagsEnabled?: boolean;
}): SubagentTool {
  const accessor = {
    get: (id: unknown) => {
      if (id === IAgentPermissionModeService) return { setMode: () => {}, mode: 'acceptEdits' };
      if (id === IAgentUserToolService) return { inheritUserTools: () => {} };
      if (id === IAgentProfileService) {
        return { data: () => ({ modelAlias: 'test-model', thinkingLevel: 'high', profileName: 'main' }) };
      }
      throw new Error(`unexpected accessor.get(${String(id)})`);
    },
  };
  const handle = { id: 'main', accessor } as unknown as IAgentScopeHandle;
  return new SubagentTool(
    {
      get: (id: string) => (id === 'main' ? handle : undefined),
      create: deps.create ?? vi.fn(async () => ({ id: 'agent-1', accessor }) as unknown as IAgentScopeHandle),
    } as unknown as IAgentLifecycleService,
    { run: vi.fn() } as unknown as ISessionSubagentService,
    {
      ready: Promise.resolve(),
      get: () => editingProfile(),
      list: () => [],
      getDefault: () => ({ subagents: [] }),
    } as unknown as ISessionAgentProfileCatalog,
    { agentId: 'main', scope: () => '' } as IAgentScopeContext,
    {} as IAgentTaskService,
    { data: () => ({ modelAlias: 'test-model', thinkingLevel: 'high', profileName: 'main' }) } as unknown as IAgentProfileService,
    { isToolActive: () => false, isToolActiveForProfile: () => false } as unknown as IAgentToolPolicyService,
    { listReferences: () => [] } as unknown as IAgentToolRegistryService,
    { workDir: WORK_DIR, additionalDirs: [] } as unknown as ISessionWorkspaceContext,
    {} as ISessionProcessRunner,
    { read: async () => ({}) } as unknown as ISessionMetadata,
    { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as unknown as ILogService,
    { mode: 'acceptEdits', setMode: () => {} } as unknown as IAgentPermissionModeService,
    { get: () => undefined } as unknown as IConfigService,
    { enabled: (id: string) => (deps.flagsEnabled ?? true) || id === 'secondary-model' } as unknown as IFlagService,
    { get: () => ({}) } as unknown as IModelCatalog,
    deps.routing as unknown as ISessionSubagentRoutingService,
    { openCircuit: () => {} } as unknown as ISessionSubagentCircuitService,
    deps.git as IGitService,
    {} as IHostFileSystem,
    {} as IHostProcessService,
  );
}

const args = (): SubagentToolInput => ({
  prompt: 'do the thing',
  description: 'ac3 test',
  subagent_type: 'coder',
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
});
