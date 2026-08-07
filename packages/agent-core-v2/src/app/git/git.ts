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
 *
 * The worktree-isolation additions (`repoInfo`, `createDetachedWorktree`,
 * `removeWorktree`, `diffChangedPaths`, `untrackedPaths`, `trackedPaths`,
 * `headEntry`) back the editing-subagent isolation (design D-B6-2).
 * `repoInfo` resolves the top-level repo root, the shared metadata dir
 * (`--git-common-dir`; under `.git` in single-worktree repositories, outside
 * the working tree in linked ones) and the current HEAD — `null` when the
 * cwd is not inside a git repository, and a `headCommit` of `null` for an
 * unborn branch. `headEntry` reconstructs one repo-relative path's HEAD
 * state (`absent` when unknown to HEAD, `unreadable` for submodule gitlinks
 * or git failures so callers fail closed, `regular` with the blob payload
 * for files, `symlink` with the link target).
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

export interface GitRepoInfo {
  readonly repoRoot: string;
  readonly commonDir: string;
  readonly headCommit: string | null;
}

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
  repoInfo(cwd: string): Promise<GitRepoInfo | null>;
  createDetachedWorktree(repoRoot: string, worktreeRoot: string, headCommit: string): Promise<void>;
  removeWorktree(repoRoot: string, worktreeRoot: string): Promise<void>;
  diffChangedPaths(repoRoot: string): Promise<string[]>;
  untrackedPaths(repoRoot: string): Promise<string[]>;
  trackedPaths(repoRoot: string): Promise<string[]>;
  headEntry(repoRoot: string, relPath: string): Promise<GitHeadEntry>;
}

export const IGitService: ServiceIdentifier<IGitService> =
  createDecorator<IGitService>('gitService');
