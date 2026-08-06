/**
 * `workspaceContext` domain — per-scope workspace context view factory.
 *
 * Builds an `ISessionWorkspaceContext`-shaped view over a fixed work
 * directory plus a shared additional-dirs set. The Session-scoped
 * `SessionWorkspaceContextService` owns the session default view; this
 * factory backs per-Agent overrides (worktree isolation seeds one into the
 * child agent scope so editing subagents operate inside their isolated
 * worktree while path confinement semantics stay identical). Pure
 * configuration + boundary — performs no IO.
 */

import { isAbsolute, relative, resolve } from 'node:path';

import { ErrorCodes, Error2 } from '#/errors';

import { ISessionWorkspaceContext, type PathAccessOperation } from './workspaceContext';

export function makeWorkspaceContextView(
  workDir: string,
  additionalDirs: readonly string[],
): ISessionWorkspaceContext {
  const resolvedWorkDir = resolve(workDir);
  const resolvedAdditional = additionalDirs.map((dir) => resolve(dir));
  return {
    _serviceBrand: undefined,
    get workDir(): string {
      return resolvedWorkDir;
    },
    get additionalDirs(): readonly string[] {
      return resolvedAdditional;
    },
    resolve(rel: string): string {
      return isAbsolute(rel) ? resolve(rel) : resolve(resolvedWorkDir, rel);
    },
    isWithin(absPath: string): boolean {
      const target = resolve(absPath);
      if (target === resolvedWorkDir) return true;
      const rel = relative(resolvedWorkDir, target);
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true;
      return resolvedAdditional.some((dir) => {
        const r = relative(dir, target);
        return r === '' || (!r.startsWith('..') && !isAbsolute(r));
      });
    },
    assertAllowed(absPath: string, op: PathAccessOperation): string {
      const target = this.resolve(absPath);
      if (!this.isWithin(target)) {
        throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `Path outside workspace (${op}): ${target}`, {
          details: { op, path: target },
        });
      }
      return target;
    },
  };
}
