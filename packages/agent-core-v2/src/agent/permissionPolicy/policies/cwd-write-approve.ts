import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { isWithinWorkspace } from '#/tool/path-access';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IHostEnvironment as HostEnvironment } from '#/os/interface/hostEnvironment';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ISessionWorkspaceContext as WorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { writeFileAccesses } from './path-utils';

/**
 * Approves writes that stay inside the workspace the user pointed the agent at.
 *
 * The authorization comes from the user having chosen this `cwd`, not from the
 * directory happening to be a git work tree — git supplies a way to undo a
 * write, not the permission to make it. Requiring a marker made an
 * uninitialized project ask for approval on every Write/Edit while the same
 * write one `git init` away was auto-approved even in manual mode: a difference
 * in ceremony, not in risk. Accesses that do warrant a prompt are asked about
 * earlier in the chain by the sensitive-file and git-control-path policies.
 *
 * Mirrors agent-core's `CwdWriteApprovePermissionPolicy`.
 */
export class CwdWriteApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'cwd-write-approve';

  constructor(
    @IHostEnvironment private readonly env: HostEnvironment,
    @ISessionWorkspaceContext private readonly workspace: WorkspaceContext,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return undefined;
    if (this.env.pathClass !== 'posix') return undefined;

    const cwd = this.workspace.workDir;
    if (cwd.length === 0) return undefined;

    const writeAccesses = writeFileAccesses(context);
    if (writeAccesses.length === 0) return undefined;
    if (
      !writeAccesses.every((access) =>
        isWithinWorkspace(
          access.path,
          { workspaceDir: cwd, additionalDirs: this.workspace.additionalDirs },
          'posix',
        ),
      )
    ) {
      return undefined;
    }

    return { kind: 'approve' };
  }
}
