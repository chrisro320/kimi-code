/**
 * `git` domain — git integration for a repository on the local disk.
 *
 * Defines the `IGitService` that runs `git status` / `git diff` (plus `gh pr
 * view`) against a repository identified by an absolute `cwd`, and discovers
 * the enclosing git work tree of a directory (`findWorkTree`). App-scoped; it
 * spawns `git` / `gh` through the host process service rather than a
 * Session's execution environment, so it never depends on a Session. Path
 * confinement is the caller's responsibility — the service receives
 * already-resolved absolute `cwd` and repo-relative paths.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { GitWorkTree } from './workTree';

export type { GitWorkTree } from './workTree';

export const fsGitStatusSchema = z.enum([
  'clean',
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
  'ignored',
  'conflicted',
]);
export type FsGitStatus = z.infer<typeof fsGitStatusSchema>;

export const fsPullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'merged', 'closed', 'draft']),
  url: z.string().url(),
});
export type FsPullRequest = z.infer<typeof fsPullRequestSchema>;

export const fsGitStatusRequestSchema = z.object({
  paths: z.array(z.string().min(1)).optional(),
});
export type FsGitStatusRequest = z.infer<typeof fsGitStatusRequestSchema>;

export const fsGitStatusResponseSchema = z.object({
  branch: z.string(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  entries: z.record(z.string(), fsGitStatusSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  pullRequest: fsPullRequestSchema.nullable(),
});
export type FsGitStatusResponse = z.infer<typeof fsGitStatusResponseSchema>;

export const fsDiffRequestSchema = z.object({
  path: z.string().min(1),
});
export type FsDiffRequest = z.infer<typeof fsDiffRequestSchema>;

export const fsDiffResponseSchema = z.object({
  path: z.string(),
  diff: z.string(),
  truncated: z.boolean(),
});
export type FsDiffResponse = z.infer<typeof fsDiffResponseSchema>;

/**
 * Repository facts needed to build an isolated subagent worktree. `repoRoot`
 * is the top-level directory of the git repository containing `cwd`;
 * `commonDir` is the shared metadata directory (`--git-common-dir`), which
 * lives under `.git` in single-worktree repositories and outside the working
 * tree in linked ones; `headCommit` is the current HEAD, `null` for an
 * unborn branch (repository without commits).
 */
export interface GitRepoInfo {
  readonly repoRoot: string;
  readonly commonDir: string;
  readonly headCommit: string | null;
}

/**
 * The HEAD state of one repo-relative path, used to reconstruct the `before`
 * state of a clean tracked path at worktree finish time. `absent` means the
 * path is unknown to HEAD; `unreadable` means it cannot be reconstructed
 * (submodule gitlink, git failure) so callers fail closed.
 */
export type GitHeadEntry =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly error: string }
  | { readonly kind: 'regular'; readonly mode: number; readonly blob: Uint8Array }
  | { readonly kind: 'symlink'; readonly target: string };

export interface IGitService {
  readonly _serviceBrand: undefined;

  status(cwd: string, pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse>;
  diff(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse>;
  findWorkTree(cwd: string): Promise<GitWorkTree | null>;
  /** Top-level repo + shared metadata dir + HEAD, or `null` when `cwd` is not inside a git repository. */
  repoInfo(cwd: string): Promise<GitRepoInfo | null>;
  /** Create a detached worktree at `worktreeRoot` checked out at `headCommit`. */
  createDetachedWorktree(repoRoot: string, worktreeRoot: string, headCommit: string): Promise<void>;
  /** Remove the worktree at `worktreeRoot`, pruning the admin data when removal fails. */
  removeWorktree(repoRoot: string, worktreeRoot: string): Promise<void>;
  /** Repo-relative paths with uncommitted modifications (tracked changes, including rename/copy destinations). */
  diffChangedPaths(repoRoot: string): Promise<string[]>;
  /** Repo-relative untracked paths, excluding git-ignored entries (secrets are filtered by the caller). */
  untrackedPaths(repoRoot: string): Promise<string[]>;
  /** Every path tracked in the index. */
  trackedPaths(repoRoot: string): Promise<string[]>;
  /** HEAD state of one repo-relative path (blob payload for `regular`, link target for `symlink`). */
  headEntry(repoRoot: string, relPath: string): Promise<GitHeadEntry>;
}

export const IGitService: ServiceIdentifier<IGitService> =
  createDecorator<IGitService>('gitService');
