/**
 * Temporary git worktree isolation for editing-capable subagents.
 *
 * `acquireSubagentWorktree` creates a detached, throwaway git worktree
 * seeded with the caller's current uncommitted state (tracked dirty diff +
 * safe untracked files), so an editing subagent can run against an
 * isolated copy of the workspace instead of racing the parent's live
 * working tree. The returned handle's `finish` either applies the worker's
 * delta back onto the real working tree (only when it stays within the
 * declared scope and the source hasn't diverged since the baseline was
 * captured) or preserves recovery data and leaves the real working tree
 * untouched.
 *
 * Every step is git-based and driven through `Kaos.exec`, matching the
 * execution backend (local, SSH, ...) the caller's `cwd` lives on. Setup
 * failures (not a repo, no commits yet, `git worktree add` failing) return
 * `null`; editing dispatch callers treat that as a fail-closed refusal.
 */

import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import * as pathe from 'pathe';

import { log } from '../logging/logger';
import { pathGlobMatch } from '../tools/support/path-glob-match';

const GIT_TIMEOUT_MS = 30_000;

// Untracked files matching any of these are never copied into (or back out
// of) an isolated worktree, even when they are not gitignored.
const SECRET_PATH_PATTERNS = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_ecdsa*',
  '**/id_dsa*',
  '**/.netrc',
  '**/.aws/**',
  '**/.ssh/**',
  '**/*credentials*',
] as const;

export interface SubagentWorktreeOptions {
  /** Workspace-relative dispatch scope (see `agent/dispatch/scope.ts`). Unrestricted when omitted/empty. */
  readonly scope?: readonly string[];
}

export type SubagentWorktreeOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'incomplete'; readonly reason?: string };

export interface SubagentWorktreeFinishResult {
  readonly applied: boolean;
  readonly reason?: string;
  readonly recoveryPath?: string;
}

export interface SubagentWorktreeHandle {
  /** Directory the subagent should use as its cwd, mirroring the original relative position inside the repo. */
  readonly cwd: string;
  /**
   * Settle the isolation session exactly once (subsequent calls return the
   * first call's result). On `'success'` this validates scope + baseline
   * and applies the delta, throwing without touching the real working tree
   * if either check fails. On `'incomplete'` it only preserves recovery
   * data and cleans up the worktree.
   */
  finish(outcome: SubagentWorktreeOutcome): Promise<SubagentWorktreeFinishResult>;
}

interface WorktreeContext {
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  readonly recoveryDir: string;
  readonly headCommit: string;
  readonly baselineTrackedPatch: string;
  readonly baselineTrackedPaths: ReadonlySet<string>;
  readonly baselineTrackedHashes: ReadonlyMap<string, string>;
  readonly baselineUntrackedHashes: ReadonlyMap<string, string>;
  readonly scope: readonly string[];
}

export async function acquireSubagentWorktree(
  kaos: Kaos,
  repoCwd: string,
  options: SubagentWorktreeOptions = {},
): Promise<SubagentWorktreeHandle | null> {
  const repoRoot = await gitStdout(kaos, repoCwd, ['rev-parse', '--show-toplevel']);
  if (repoRoot === null) return null;
  const headCommit = await gitStdout(kaos, repoCwd, ['rev-parse', 'HEAD']);
  if (headCommit === null) return null; // unborn repo (no commits yet): fall back, no isolation.

  const commonDirRaw = await gitStdout(kaos, repoCwd, ['rev-parse', '--git-common-dir']);
  const commonDir =
    commonDirRaw === null
      ? pathe.join(repoRoot, '.git')
      : pathe.isAbsolute(commonDirRaw)
        ? commonDirRaw
        : pathe.resolve(repoCwd, commonDirRaw);

  const id = randomId();
  const worktreesDir = pathe.join(commonDir, 'kimi-code-subagent-worktrees');
  const worktreeRoot = pathe.join(worktreesDir, id);
  const recoveryDir = pathe.join(commonDir, 'kimi-code-subagent-recovery', id);

  await kaos.mkdir(worktreesDir, { parents: true, existOk: true });
  const added = await execGit(kaos, repoRoot, ['worktree', 'add', '--detach', worktreeRoot, headCommit]);
  if (!added.ok) {
    log.warn('subagent worktree: git worktree add failed', { repoRoot, stderr: added.stderr });
    return null;
  }

  const baselineTrackedPatch = await gitDiffHead(kaos, repoRoot);
  const baselineUntracked = await listSafeUntracked(kaos, repoRoot);

  try {
    if (baselineTrackedPatch.length > 0) {
      const applied = await execGit(kaos, worktreeRoot, ['apply'], baselineTrackedPatch);
      if (!applied.ok) {
        throw new Error(`failed to seed baseline changes into isolated worktree: ${applied.stderr}`);
      }
    }
    for (const relPath of baselineUntracked) {
      const bytes = await kaos.readBytes(pathe.join(repoRoot, relPath));
      const dest = pathe.join(worktreeRoot, relPath);
      await kaos.mkdir(pathe.dirname(dest), { parents: true, existOk: true });
      await kaos.writeBytes(dest, bytes);
    }
  } catch (error) {
    await removeWorktree(kaos, repoRoot, worktreeRoot);
    throw error;
  }

  const baselineTrackedPaths = new Set(await listTracked(kaos, repoRoot));
  const baselineTrackedHashes = await hashFiles(kaos, repoRoot, [...baselineTrackedPaths]);
  const baselineUntrackedHashes = await hashFiles(kaos, repoRoot, baselineUntracked);
  const relativeCwd = pathe.relative(repoRoot, repoCwd);
  const childCwd = relativeCwd.length === 0 ? worktreeRoot : pathe.join(worktreeRoot, relativeCwd);
  await kaos.mkdir(childCwd, { parents: true, existOk: true });

  const ctx: WorktreeContext = {
    repoRoot,
    worktreeRoot,
    recoveryDir,
    headCommit,
    baselineTrackedPatch,
    baselineTrackedPaths,
    baselineTrackedHashes,
    baselineUntrackedHashes,
    scope: normalizeScope(options.scope),
  };

  let settled: Promise<SubagentWorktreeFinishResult> | undefined;
  return {
    cwd: childCwd,
    finish(outcome) {
      settled ??= finishWorktree(kaos, ctx, outcome);
      return settled;
    },
  };
}

async function finishWorktree(
  kaos: Kaos,
  ctx: WorktreeContext,
  outcome: SubagentWorktreeOutcome,
): Promise<SubagentWorktreeFinishResult> {
  const { repoRoot, worktreeRoot } = ctx;

  if (outcome.kind !== 'success') {
    const recoveryPath = await preserveRecovery(kaos, ctx, outcome.reason ?? 'incomplete').catch((error) => {
      log.warn('subagent worktree: failed to preserve recovery data', {
        worktreeRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });
    await removeWorktree(kaos, repoRoot, worktreeRoot);
    return { applied: false, reason: outcome.reason ?? 'incomplete', recoveryPath };
  }

  const deltaPaths = await collectDeltaPaths(kaos, ctx);

  if (ctx.scope.length > 0) {
    const outside = [...deltaPaths].filter((relPath) => !isPathInScope(relPath, ctx.scope));
    if (outside.length > 0) {
      const recoveryPath = await preserveRecovery(kaos, ctx, `scope-violation: ${outside.join(', ')}`);
      await removeWorktree(kaos, repoRoot, worktreeRoot);
      throw new Error(
        `Editing subagent changed file(s) outside its declared scope: ${outside.join(', ')}. ` +
          `Changes were not applied to the workspace; recovery data preserved at ${recoveryPath}.`,
      );
    }
  }

  const mismatch = await detectBaselineMismatch(kaos, ctx);
  if (mismatch !== undefined) {
    const recoveryPath = await preserveRecovery(kaos, ctx, `baseline-mismatch: ${mismatch}`);
    await removeWorktree(kaos, repoRoot, worktreeRoot);
    throw new Error(
      `The main workspace changed while the editing subagent was running (${mismatch}). ` +
        `Changes were not applied to the workspace; recovery data preserved at ${recoveryPath}.`,
    );
  }

  const writes: Array<{ readonly relPath: string; readonly bytes: Buffer }> = [];
  const deletes: string[] = [];
  for (const relPath of deltaPaths) {
    if (await pathExists(kaos, pathe.join(worktreeRoot, relPath))) {
      writes.push({ relPath, bytes: await kaos.readBytes(pathe.join(worktreeRoot, relPath)) });
    } else {
      deletes.push(relPath);
    }
  }

  try {
    for (const { relPath, bytes } of writes) {
      const dest = pathe.join(repoRoot, relPath);
      await kaos.mkdir(pathe.dirname(dest), { parents: true, existOk: true });
      await kaos.writeBytes(dest, bytes);
    }
    for (const relPath of deletes) {
      await removeFile(kaos, pathe.join(repoRoot, relPath));
    }
  } catch (error) {
    const recoveryPath = await preserveRecovery(
      kaos,
      ctx,
      `apply-failed: ${error instanceof Error ? error.message : String(error)}`,
    ).catch(() => undefined);
    await removeWorktree(kaos, repoRoot, worktreeRoot);
    throw new Error(
      `Failed to apply editing subagent changes to the workspace: ` +
        `${error instanceof Error ? error.message : String(error)}` +
        (recoveryPath === undefined ? '' : ` (recovery data preserved at ${recoveryPath})`),
    );
  }

  await removeWorktree(kaos, repoRoot, worktreeRoot);
  return { applied: true };
}

/** Every path whose worker state differs from the captured baseline. */
async function collectDeltaPaths(kaos: Kaos, ctx: WorktreeContext): Promise<readonly string[]> {
  const paths = new Set<string>();
  for (const relPath of await gitDiffChangedPaths(kaos, ctx.worktreeRoot)) {
    const filePath = pathe.join(ctx.worktreeRoot, relPath);
    if (!(await pathExists(kaos, filePath))) {
      paths.add(relPath);
      continue;
    }
    const baselineHash = ctx.baselineTrackedHashes.get(relPath);
    if (baselineHash === undefined || baselineHash !== await hashFile(kaos, filePath)) {
      paths.add(relPath);
    }
  }

  const workerUntracked = new Set(await listSafeUntracked(kaos, ctx.worktreeRoot));
  for (const relPath of workerUntracked) {
    const baselineHash = ctx.baselineUntrackedHashes.get(relPath);
    const currentHash = await hashFile(kaos, pathe.join(ctx.worktreeRoot, relPath));
    if (baselineHash === undefined || baselineHash !== currentHash) paths.add(relPath);
  }
  for (const relPath of ctx.baselineUntrackedHashes.keys()) {
    if (!workerUntracked.has(relPath)) paths.add(relPath);
  }
  return [...paths];
}

/** Returns a human-readable mismatch reason, or `undefined` when the source hasn't diverged. */
async function detectBaselineMismatch(kaos: Kaos, ctx: WorktreeContext): Promise<string | undefined> {
  const currentHead = await gitStdout(kaos, ctx.repoRoot, ['rev-parse', 'HEAD']);
  if (currentHead !== ctx.headCommit) return `HEAD moved from ${ctx.headCommit} to ${currentHead ?? 'unknown'}`;

  const currentTrackedPatch = await gitDiffHead(kaos, ctx.repoRoot);
  if (currentTrackedPatch !== ctx.baselineTrackedPatch) return 'tracked working-tree changes diverged';

  const currentUntracked = await listSafeUntracked(kaos, ctx.repoRoot);
  const currentUntrackedHashes = await hashFiles(kaos, ctx.repoRoot, currentUntracked);
  if (!mapsEqual(currentUntrackedHashes, ctx.baselineUntrackedHashes)) return 'untracked files diverged';

  return undefined;
}

async function preserveRecovery(kaos: Kaos, ctx: WorktreeContext, reason: string): Promise<string> {
  const { worktreeRoot, recoveryDir, headCommit, scope } = ctx;
  await kaos.mkdir(recoveryDir, { parents: true, existOk: true });

  const patch = await gitDiffHead(kaos, worktreeRoot);
  if (patch.length > 0) {
    await kaos.writeText(pathe.join(recoveryDir, 'worker.diff'), patch);
  }
  for (const relPath of await listSafeUntracked(kaos, worktreeRoot)) {
    try {
      const bytes = await kaos.readBytes(pathe.join(worktreeRoot, relPath));
      const dest = pathe.join(recoveryDir, 'untracked', relPath);
      await kaos.mkdir(pathe.dirname(dest), { parents: true, existOk: true });
      await kaos.writeBytes(dest, bytes);
    } catch {
      /* best-effort: a file that vanished between listing and reading is skipped */
    }
  }
  const manifest = {
    reason,
    headCommit,
    scope,
    savedAt: new Date().toISOString(),
    worktreeRoot,
  };
  await kaos.writeText(pathe.join(recoveryDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return recoveryDir;
}

async function removeWorktree(kaos: Kaos, repoRoot: string, worktreeRoot: string): Promise<void> {
  const result = await execGit(kaos, repoRoot, ['worktree', 'remove', '--force', worktreeRoot]);
  if (!result.ok) {
    log.warn('subagent worktree: git worktree remove failed, pruning instead', {
      repoRoot,
      worktreeRoot,
      stderr: result.stderr,
    });
    await execGit(kaos, repoRoot, ['worktree', 'prune']);
  }
}

function normalizeScope(scope: readonly string[] | undefined): readonly string[] {
  return scope === undefined ? [] : scope.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** A relative delta path is in scope when it equals, nests under, or glob-matches a declared scope entry. */
function isPathInScope(relPath: string, scope: readonly string[]): boolean {
  return scope.some((entry) => {
    if (relPath === entry) return true;
    if (relPath.startsWith(`${entry}/`)) return true;
    return pathGlobMatch(relPath, entry) || pathGlobMatch(relPath, `${entry}/**`);
  });
}

function isSecretPath(relPath: string): boolean {
  if (relPath === '.git' || relPath.startsWith('.git/')) return true;
  return SECRET_PATH_PATTERNS.some((pattern) => pathGlobMatch(relPath, pattern));
}

async function hashFile(kaos: Kaos, path: string): Promise<string | undefined> {
  try {
    return createHash('sha256').update(await kaos.readBytes(path)).digest('hex');
  } catch {
    return undefined;
  }
}

async function listTracked(kaos: Kaos, cwd: string): Promise<string[]> {
  const result = await execGit(kaos, cwd, ['ls-files', '-z']);
  return result.ok ? result.stdout.split('\0').filter((path) => path.length > 0) : [];
}

async function hashFiles(
  kaos: Kaos,
  root: string,
  relPaths: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const map = new Map<string, string>();
  for (const relPath of relPaths) {
    try {
      const bytes = await kaos.readBytes(pathe.join(root, relPath));
      map.set(relPath, createHash('sha256').update(bytes).digest('hex'));
    } catch {
      /* file vanished between listing and hashing: treated as absent */
    }
  }
  return map;
}

function mapsEqual(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

async function pathExists(kaos: Kaos, path: string): Promise<boolean> {
  try {
    await kaos.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `Kaos` has no delete primitive; shell out, branching for the two OS families the repo already special-cases. */
async function removeFile(kaos: Kaos, path: string): Promise<void> {
  const args = kaos.pathClass() === 'win32' ? ['cmd', '/c', 'del', '/f', '/q', path] : ['rm', '-f', path];
  const proc = await kaos.exec(...args);
  try {
    await proc.wait();
  } finally {
    await proc.dispose();
  }
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** `git status --porcelain -z`, filtered to untracked entries that are not secrets or VCS metadata. */
async function listSafeUntracked(kaos: Kaos, cwd: string): Promise<string[]> {
  const result = await execGit(kaos, cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!result.ok) return [];
  const paths: string[] = [];
  for (const record of result.stdout.split('\0')) {
    if (!record.startsWith('?? ')) continue;
    const relPath = record.slice(3);
    if (relPath.length === 0 || isSecretPath(relPath)) continue;
    paths.push(relPath);
  }
  return paths;
}

/** `git diff --binary HEAD`, un-trimmed so the exact byte stream stays valid `git apply` input. */
async function gitDiffHead(kaos: Kaos, cwd: string): Promise<string> {
  const result = await execGit(kaos, cwd, ['diff', '--binary', 'HEAD']);
  return result.ok ? result.stdout : '';
}

/** Every path touched by the tracked diff against `HEAD` (both sides of a rename/copy). */
async function gitDiffChangedPaths(kaos: Kaos, cwd: string): Promise<string[]> {
  const result = await execGit(kaos, cwd, ['diff', '--name-status', '-z', 'HEAD']);
  if (!result.ok) return [];
  const tokens = result.stdout.split('\0').filter((token) => token.length > 0);
  const paths = new Set<string>();
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i] ?? '';
    i += 1;
    const pathCount = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    for (let k = 0; k < pathCount && i < tokens.length; k += 1, i += 1) {
      const token = tokens[i];
      if (token !== undefined && token.length > 0) paths.add(token);
    }
  }
  return [...paths];
}

async function gitStdout(kaos: Kaos, cwd: string, args: readonly string[]): Promise<string | null> {
  const result = await execGit(kaos, cwd, args);
  return result.ok ? result.stdout.trim() : null;
}

interface GitExecResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function execGit(
  kaos: Kaos,
  cwd: string,
  args: readonly string[],
  stdin?: string,
): Promise<GitExecResult> {
  let proc: KaosProcess;
  try {
    proc = await kaos.exec('git', '-C', cwd, ...args);
  } catch (error) {
    return { ok: false, exitCode: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }

  // A short-lived process (e.g. `rev-parse` outside a repo) may exit and
  // close stdin before this write lands; that surfaces as an async EPIPE
  // 'error' event, not a synchronous throw, so it needs its own listener.
  proc.stdin.on('error', () => {});
  try {
    proc.stdin.write(stdin ?? '');
    proc.stdin.end();
  } catch {
    /* stdin already closed */
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.all([collectStream(proc.stdout), collectStream(proc.stderr), proc.wait()]);
  work.catch(() => {});
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`git ${args.join(' ')} timed out`)), GIT_TIMEOUT_MS);
    });
    const [stdout, stderr, exitCode] = await Promise.race([work, timeout]);
    return { ok: exitCode === 0, exitCode, stdout, stderr };
  } catch (error) {
    try {
      await proc.kill('SIGKILL');
    } catch {
      /* process already gone */
    }
    await work.catch(() => {});
    return { ok: false, exitCode: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      await proc.dispose();
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function collectStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}
