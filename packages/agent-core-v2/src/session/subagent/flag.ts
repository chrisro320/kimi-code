/**
 * `subagent` domain — registers the subagent experimental flags into `flag`.
 *
 * `secondary-model` gates secondary-model selection for newly spawned
 * subagents, including the agent-facing model choices and startup validation
 * warning. Off by default; enable via `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL`,
 * the master `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config
 * section.
 *
 * `subagent-worktree-isolation` is a definition-only port of the v1 flag; the
 * gated behavior lands with worktree isolation (B6).
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SECONDARY_MODEL_FLAG_ID = 'secondary-model';
export const SECONDARY_MODEL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL';

export const secondaryModelFlag: FlagDefinitionInput = {
  id: SECONDARY_MODEL_FLAG_ID,
  title: 'Secondary model for subagents',
  description:
    'Let newly spawned subagents use a separately configured secondary model by default, with an explicit primary-model override for quality-sensitive tasks.',
  env: SECONDARY_MODEL_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(secondaryModelFlag);

export const SUBAGENT_WORKTREE_ISOLATION_FLAG_ID = 'subagent-worktree-isolation';
export const SUBAGENT_WORKTREE_ISOLATION_FLAG_ENV =
  'KIMI_CODE_EXPERIMENTAL_SUBAGENT_WORKTREE_ISOLATION';

/**
 * Definition-only port of the v1 flag (`flags/registry.ts`). The gated
 * behavior lands with worktree isolation (B6); registering the id now keeps
 * env/config parsing aligned with v1.
 */
export const subagentWorktreeIsolationFlag: FlagDefinitionInput = {
  id: SUBAGENT_WORKTREE_ISOLATION_FLAG_ID,
  title: 'Editing subagent worktree isolation',
  description:
    'Run editing-capable subagents (internal and external) in a temporary detached git worktree seeded from the current uncommitted state, then apply safe changes back through guarded candidate-path checks even when necessary companion files expand the declared scope. On a real path conflict, unsafe change, abort, or timeout, the workspace is left untouched and recovery data is preserved instead.',
  env: SUBAGENT_WORKTREE_ISOLATION_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(subagentWorktreeIsolationFlag);
