import type { Agent } from '../..';
import { isWithinWorkspace } from '../../../tools/policies/path-access';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { writeFileAccesses } from './file-access-ask';

/**
 * Approves writes that stay inside the workspace the user pointed the agent at.
 *
 * The authorization here comes from the user having chosen this `cwd`, not from
 * the directory happening to be a git work tree. Git provides a way to undo a
 * write; it is not what makes the write permitted. Gating on a `.git` marker
 * made a plain directory — a scratch project, a fresh game, anything not yet
 * under version control — ask for approval on every single Write/Edit, while
 * the identical write one `git init` away was silently approved even in manual
 * mode. That discrepancy was a difference in ceremony, not in risk.
 *
 * The accesses that genuinely need a prompt are already asked about by earlier
 * policies in the chain: `SensitiveFileAccessAskPermissionPolicy` (.env, keys,
 * credentials) and `GitControlPathAccessAskPermissionPolicy` (.git internals).
 * Writes outside the workspace never reach an approval here either — they fail
 * `isWithinWorkspace` and fall through to the ask.
 */
export class CwdWriteApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'cwd-write-approve';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return;
    if (this.agent.kaos.pathClass() !== 'posix') return;

    const cwd = this.agent.config.cwd;
    if (cwd.length === 0) return;

    const writeAccesses = writeFileAccesses(context);
    if (writeAccesses.length === 0) return;
    if (
      !writeAccesses.every((access) =>
        isWithinWorkspace(
          access.path,
          { workspaceDir: cwd, additionalDirs: this.agent.getAdditionalDirs() },
          'posix',
        ),
      )
    ) {
      return;
    }

    return {
      kind: 'approve',
    };
  }
}
