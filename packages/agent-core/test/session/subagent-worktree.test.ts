import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalKaos } from '@moonshot-ai/kaos';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { __testing, acquireSubagentWorktree } from '../../src/session/subagent-worktree';

// These tests drive the real `git` binary through a real `LocalKaos` (the
// same integration-test posture as `GlobTool integration (real ripgrep)` in
// tools/glob.test.ts) because the service orchestrates several git
// subcommands together (`worktree add`, `diff`, `apply`, `status`) whose
// interaction is what's actually under test — scripting every combination
// through a fake Kaos would just re-encode the implementation as fixtures.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-worktree-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

async function initNestedWorkspace(): Promise<{ outer: string; inner: string }> {
  const outer = await mkdtemp(join(tmpdir(), 'subagent-nested-'));
  git(outer, ['init', '-q', '-b', 'main']);
  git(outer, ['config', 'user.email', 'test@example.com']);
  git(outer, ['config', 'user.name', 'Test']);
  const inner = join(outer, 'upstream-kimi-code');
  await mkdir(inner, { recursive: true });
  git(inner, ['init', '-q', '-b', 'main']);
  git(inner, ['config', 'user.email', 'test@example.com']);
  git(inner, ['config', 'user.name', 'Test']);
  await writeFile(join(inner, 'a.txt'), 'inner\n');
  git(inner, ['add', 'a.txt']);
  git(inner, ['commit', '-q', '-m', 'inner init']);
  return { outer, inner };
}

let runRealGit = false;
const tempDirs: string[] = [];

function recoveryRoot(repo: string): string {
  const commonDir = git(repo, ['rev-parse', '--git-common-dir']).trim();
  return join(repo, commonDir, 'kimi-code-subagent-recovery');
}

async function onlyRecoveryDir(repo: string): Promise<string> {
  const ids = await readdir(recoveryRoot(repo));
  expect(ids).toHaveLength(1);
  return join(recoveryRoot(repo), ids[0]!);
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('acquireSubagentWorktree (real git integration)', () => {
  let kaos: LocalKaos;
  let repoDir: string;

  beforeAll(() => {
    try {
      execFileSync('git', ['--version']);
      runRealGit = true;
    } catch {
      runRealGit = false;
    }
  });

  beforeEach(async (ctx) => {
    if (!runRealGit) ctx.skip();
    kaos = await LocalKaos.create();
    repoDir = await initRepo();
    tempDirs.push(repoDir);
  });

  it('returns null when the directory is not a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'not-a-repo-'));
    tempDirs.push(dir);

    expect(await acquireSubagentWorktree(kaos, dir)).toBeNull();
  });

  it('returns null for a repository with no commits yet (unborn HEAD)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unborn-'));
    tempDirs.push(dir);
    git(dir, ['init', '-q']);

    expect(await acquireSubagentWorktree(kaos, dir)).toBeNull();
  });

  it('seeds the isolated worktree with tracked dirty and untracked baseline state, without touching the source', async () => {
    await writeFile(join(repoDir, 'a.txt'), 'hello\nedited\n');
    await writeFile(join(repoDir, 'new.txt'), 'brand new\n');

    const handle = await acquireSubagentWorktree(kaos, repoDir);
    expect(handle).not.toBeNull();
    const worktreeCwd = handle!.cwd;

    expect(await readFile(join(worktreeCwd, 'a.txt'), 'utf8')).toBe('hello\nedited\n');
    expect(await readFile(join(worktreeCwd, 'new.txt'), 'utf8')).toBe('brand new\n');
    expect(git(repoDir, ['worktree', 'list'])).toContain(worktreeCwd);
    // Acquiring the worktree must never mutate the source repo's working tree.
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('hello\nedited\n');

    await handle!.finish({ kind: 'incomplete', reason: 'test-teardown' });
  });

  it('excludes secret-looking untracked files from the seeded worktree', async () => {
    await writeFile(join(repoDir, '.env'), 'SECRET=1\n');

    const handle = await acquireSubagentWorktree(kaos, repoDir);
    expect(handle).not.toBeNull();

    await expect(stat(join(handle!.cwd, '.env'))).rejects.toThrow();

    await handle!.finish({ kind: 'incomplete' });
  });

  it('cleans up the worktree and preserves recovery data on an incomplete outcome, without applying anything', async () => {
    await writeFile(join(repoDir, 'a.txt'), 'hello\nedited\n');
    const handle = await acquireSubagentWorktree(kaos, repoDir);
    expect(handle).not.toBeNull();
    const worktreeCwd = handle!.cwd;

    const result = await handle!.finish({ kind: 'incomplete', reason: 'aborted-by-user' });

    expect(result.applied).toBe(false);
    expect(result.recoveryPath).toBeDefined();
    expect(git(repoDir, ['worktree', 'list'])).not.toContain(worktreeCwd);

    const manifest = JSON.parse(await readFile(join(result.recoveryPath!, 'manifest.json'), 'utf8')) as {
      reason: string;
    };
    expect(manifest.reason).toBe('aborted-by-user');
  });

  it('discards analysis-only worker delta without creating recovery artifacts', async () => {
    const handle = await acquireSubagentWorktree(kaos, repoDir, { scope: ['a.txt', 'created.txt'] });
    expect(handle).not.toBeNull();
    const worktreeCwd = handle!.cwd;
    await writeFile(join(worktreeCwd, 'a.txt'), 'hello\nanalysis edit\n');
    await writeFile(join(worktreeCwd, 'created.txt'), 'analysis artifact\n');

    const result = await handle!.finish({
      kind: 'discard',
      reason: 'analysis-only subagent delta discarded',
    });

    expect(result).toEqual({
      applied: false,
      reason: 'analysis-only subagent delta discarded',
    });
    expect(result.recoveryPath).toBeUndefined();
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('hello\n');
    await expect(stat(join(repoDir, 'created.txt'))).rejects.toThrow();
    expect(git(repoDir, ['worktree', 'list'])).not.toContain(worktreeCwd);
    await expect(stat(recoveryRoot(repoDir))).rejects.toThrow();
  });

  it('applies an in-scope worker delta back onto the workspace on success, then removes the worktree', async () => {
    const handle = await acquireSubagentWorktree(kaos, repoDir, { scope: ['a.txt', 'created.txt'] });
    expect(handle).not.toBeNull();
    const worktreeCwd = handle!.cwd;

    await writeFile(join(worktreeCwd, 'a.txt'), 'hello\nworker edit\n');
    await writeFile(join(worktreeCwd, 'created.txt'), 'from worker\n');

    const result = await handle!.finish({ kind: 'success' });

    expect(result.applied).toBe(true);
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('hello\nworker edit\n');
    expect(await readFile(join(repoDir, 'created.txt'), 'utf8')).toBe('from worker\n');
    expect(git(repoDir, ['worktree', 'list'])).not.toContain(worktreeCwd);
  });

  it('applies a worker-side deletion of a baseline untracked file back onto the workspace', async () => {
    await writeFile(join(repoDir, 'scratch.txt'), 'seed me\n');
    const handle = await acquireSubagentWorktree(kaos, repoDir, { scope: ['scratch.txt'] });
    expect(handle).not.toBeNull();
    await expect(readFile(join(handle!.cwd, 'scratch.txt'), 'utf8')).resolves.toBe('seed me\n');

    await rm(join(handle!.cwd, 'scratch.txt'));
    const result = await handle!.finish({ kind: 'success' });

    expect(result.applied).toBe(true);
    await expect(stat(join(repoDir, 'scratch.txt'))).rejects.toThrow();
  });

  it('records worker-side deletions in recovery metadata', async () => {
    const handle = await acquireSubagentWorktree(kaos, repoDir, { scope: ['allowed'] });
    expect(handle).not.toBeNull();
    await rm(join(handle!.cwd, 'a.txt'));

    await expect(handle!.finish({ kind: 'success' })).rejects.toThrow(/outside its declared scope/);

    const gitCommonDir = git(repoDir, ['rev-parse', '--git-common-dir']).trim();
    const recoveryRoot = join(repoDir, gitCommonDir, 'kimi-code-subagent-recovery');
    const ids = await readdir(recoveryRoot);
    const manifest = JSON.parse(
      await readFile(join(recoveryRoot, ids[0]!, 'manifest.json'), 'utf8'),
    ) as { deltaPaths: string[]; deletedPaths: string[] };
    expect(manifest.deltaPaths).toEqual(['a.txt']);
    expect(manifest.deletedPaths).toEqual(['a.txt']);
  });

  it('ignores baseline-only dirty files outside scope when applying a worker delta', async () => {
    await writeFile(join(repoDir, 'baseline.txt'), 'baseline noise\n');
    const handle = await acquireSubagentWorktree(kaos, repoDir, { scope: ['a.txt'] });
    expect(handle).not.toBeNull();

    await writeFile(join(handle!.cwd, 'a.txt'), 'hello\nworker edit\n');
    const result = await handle!.finish({ kind: 'success' });

    expect(result.applied).toBe(true);
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('hello\nworker edit\n');
    expect(await readFile(join(repoDir, 'baseline.txt'), 'utf8')).toBe('baseline noise\n');
  });

  it('preserves only worker delta in recovery, excluding tracked and untracked baseline noise', async () => {
    await writeFile(join(repoDir, 'a.txt'), 'hello\nbaseline edit\n');
    await writeFile(join(repoDir, 'baseline.txt'), 'baseline noise\n');
    const handle = await acquireSubagentWorktree(kaos, repoDir, { scope: ['allowed'] });
    expect(handle).not.toBeNull();

    await writeFile(join(handle!.cwd, 'a.txt'), 'hello\nbaseline edit\nworker edit\n');
    await writeFile(join(handle!.cwd, 'worker-only.txt'), 'worker artifact\n');

    await expect(handle!.finish({ kind: 'success' })).rejects.toThrow(/outside its declared scope/);

    const gitCommonDir = git(repoDir, ['rev-parse', '--git-common-dir']).trim();
    const recoveryRoot = join(repoDir, gitCommonDir, 'kimi-code-subagent-recovery');
    const ids = await readdir(recoveryRoot);
    expect(ids).toHaveLength(1);
    const recoveryDir = join(recoveryRoot, ids[0]!);
    const manifest = JSON.parse(await readFile(join(recoveryDir, 'manifest.json'), 'utf8')) as {
      deltaPaths: string[];
      deletedPaths: string[];
    };
    expect(manifest.deltaPaths).toEqual(['a.txt', 'worker-only.txt']);
    expect(manifest.deletedPaths).toEqual([]);
    expect(await readFile(join(recoveryDir, 'baseline', 'a.txt'), 'utf8')).toBe('hello\nbaseline edit\n');
    expect(await readFile(join(recoveryDir, 'worker-final', 'a.txt'), 'utf8')).toBe(
      'hello\nbaseline edit\nworker edit\n',
    );
    await expect(stat(join(recoveryDir, 'worker-final', 'baseline.txt'))).rejects.toThrow();
    expect(await readFile(join(recoveryDir, 'worker-final', 'worker-only.txt'), 'utf8')).toBe('worker artifact\n');
  });

  it('rejects and preserves recovery data when the worker edits a file outside its declared scope, leaving the workspace untouched', async () => {
    const handle = await acquireSubagentWorktree(kaos, repoDir, { scope: ['allowed'] });
    expect(handle).not.toBeNull();
    const worktreeCwd = handle!.cwd;

    await writeFile(join(worktreeCwd, 'a.txt'), 'hello\nout of scope edit\n');

    await expect(handle!.finish({ kind: 'success' })).rejects.toThrow(/outside its declared scope/);

    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(git(repoDir, ['worktree', 'list'])).not.toContain(worktreeCwd);

    const gitCommonDir = git(repoDir, ['rev-parse', '--git-common-dir']).trim();
    const recoveryRoot = join(repoDir, gitCommonDir, 'kimi-code-subagent-recovery');
    const ids = await readdir(recoveryRoot);
    expect(ids).toHaveLength(1);
    const recoveryDir = join(recoveryRoot, ids[0]!);
    expect(await readFile(join(recoveryDir, 'manifest.json'), 'utf8')).toContain('scope-violation');
    expect(await readFile(join(recoveryDir, 'worker-final', 'a.txt'), 'utf8')).toContain('out of scope edit');
  });

  it('rejects and preserves recovery data when the workspace changed underneath the running subagent (baseline mismatch)', async () => {
    const handle = await acquireSubagentWorktree(kaos, repoDir);
    expect(handle).not.toBeNull();
    const worktreeCwd = handle!.cwd;

    await writeFile(join(worktreeCwd, 'a.txt'), 'hello\nworker edit\n');
    // Concurrently, the main workspace changes underneath the running subagent.
    await writeFile(join(repoDir, 'a.txt'), 'hello\nconcurrent human edit\n');

    await expect(handle!.finish({ kind: 'success' })).rejects.toThrow(/worker delta path\(s\) diverged/);

    // The concurrent edit must survive untouched, not be overwritten by the worker's delta.
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('hello\nconcurrent human edit\n');
    expect(git(repoDir, ['worktree', 'list'])).not.toContain(worktreeCwd);
  });

  it('allows disjoint editing workers to finish without invalidating each other', async () => {
    await writeFile(join(repoDir, 'b.txt'), 'second\n');
    git(repoDir, ['add', 'b.txt']);
    git(repoDir, ['commit', '-q', '-m', 'add second file']);
    const first = await acquireSubagentWorktree(kaos, repoDir, { scope: ['a.txt'] });
    const second = await acquireSubagentWorktree(kaos, repoDir, { scope: ['b.txt'] });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    await writeFile(join(first!.cwd, 'a.txt'), 'first worker\n');
    await writeFile(join(second!.cwd, 'b.txt'), 'second worker\n');

    const results = await Promise.all([
      first!.finish({ kind: 'success' }),
      second!.finish({ kind: 'success' }),
    ]);
    expect(results).toEqual([{ applied: true }, { applied: true }]);
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('first worker\n');
    expect(await readFile(join(repoDir, 'b.txt'), 'utf8')).toBe('second worker\n');
  });

  it('serializes competing workers and rejects the second writer to the same path', async () => {
    const first = await acquireSubagentWorktree(kaos, repoDir, { scope: ['a.txt'] });
    const second = await acquireSubagentWorktree(kaos, repoDir, { scope: ['a.txt'] });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    await writeFile(join(first!.cwd, 'a.txt'), 'first worker\n');
    await writeFile(join(second!.cwd, 'a.txt'), 'second worker\n');

    const results = await Promise.allSettled([
      first!.finish({ kind: 'success' }),
      second!.finish({ kind: 'success' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected' });
    expect(String((rejected as PromiseRejectedResult).reason)).toContain('worker delta path(s) diverged: a.txt');
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('first worker\n');
  });

  it('rejects on a new commit landing on the source repo while the subagent was running (HEAD moved)', async () => {
    const handle = await acquireSubagentWorktree(kaos, repoDir);
    expect(handle).not.toBeNull();

    await writeFile(join(repoDir, 'b.txt'), 'second file\n');
    git(repoDir, ['add', 'b.txt']);
    git(repoDir, ['commit', '-q', '-m', 'second commit']);

    await expect(handle!.finish({ kind: 'success' })).rejects.toThrow(/changed while the editing subagent/);
  });

  it('uses the nested repository for an outer workspace and translates scope', async () => {
    const nested = await initNestedWorkspace();
    tempDirs.push(nested.outer);

    const handle = await acquireSubagentWorktree(kaos, nested.outer, {
      scope: ['upstream-kimi-code/packages/agent-core/**'],
    });
    expect(handle).not.toBeNull();
    expect(handle!.cwd).not.toBe(nested.outer);
    expect(git(handle!.cwd, ['rev-parse', '--show-toplevel'])).toContain(nested.inner);
    const created = join(handle!.cwd, 'packages', 'agent-core', 'created.txt');
    await mkdir(join(handle!.cwd, 'packages', 'agent-core'), { recursive: true });
    await writeFile(created, 'from nested worker\n');

    const result = await handle!.finish({ kind: 'success' });
    expect(result.applied).toBe(true);
    await expect(readFile(join(nested.inner, 'packages', 'agent-core', 'created.txt'), 'utf8')).resolves.toBe(
      'from nested worker\n',
    );
  });

  it('skips a nested repository directory instead of reading it as an untracked file', async () => {
    const nested = await initNestedWorkspace();
    tempDirs.push(nested.outer);

    const handle = await acquireSubagentWorktree(kaos, nested.outer);
    expect(handle).not.toBeNull();
    await handle!.finish({ kind: 'incomplete' });
  });

  it('mirrors the caller cwd position relative to the repo root inside the isolated worktree', async () => {
    const subdir = join(repoDir, 'pkg', 'sub');
    await mkdir(subdir, { recursive: true });
    await writeFile(join(subdir, 'nested.txt'), 'nested\n');
    git(repoDir, ['add', 'pkg']);
    git(repoDir, ['commit', '-q', '-m', 'add nested package']);

    const handle = await acquireSubagentWorktree(kaos, subdir);
    expect(handle).not.toBeNull();
    expect(handle!.cwd.endsWith(join('pkg', 'sub'))).toBe(true);
    expect(await readFile(join(handle!.cwd, 'nested.txt'), 'utf8')).toBe('nested\n');

    await handle!.finish({ kind: 'incomplete' });
  });

  it('treats an unstaged tracked deletion as baseline state when the worker is a no-op', async () => {
    await rm(join(repoDir, 'a.txt'));
    const handle = await acquireSubagentWorktree(kaos, repoDir);
    expect(handle).not.toBeNull();
    await expect(stat(join(handle!.cwd, 'a.txt'))).rejects.toThrow();
    await expect(handle!.finish({ kind: 'success' })).resolves.toEqual({ applied: true });
    await expect(stat(join(repoDir, 'a.txt'))).rejects.toThrow();
  });

  it('preserves staged addition deletion and rename baseline states for a no-op worker', async () => {
    await writeFile(join(repoDir, 'added.txt'), 'staged addition\n');
    git(repoDir, ['add', 'added.txt']);
    git(repoDir, ['rm', 'a.txt']);
    await writeFile(join(repoDir, 'rename-source.txt'), 'rename me\n');
    git(repoDir, ['add', 'rename-source.txt']);
    git(repoDir, ['commit', '-q', '-m', 'add rename source']);
    git(repoDir, ['mv', 'rename-source.txt', 'renamed.txt']);

    const handle = await acquireSubagentWorktree(kaos, repoDir);
    expect(handle).not.toBeNull();
    await expect(readFile(join(handle!.cwd, 'added.txt'), 'utf8')).resolves.toBe('staged addition\n');
    await expect(stat(join(handle!.cwd, 'a.txt'))).rejects.toThrow();
    await expect(readFile(join(handle!.cwd, 'renamed.txt'), 'utf8')).resolves.toBe('rename me\n');
    await expect(handle!.finish({ kind: 'success' })).resolves.toEqual({ applied: true });
    await expect(readFile(join(repoDir, 'added.txt'), 'utf8')).resolves.toBe('staged addition\n');
    await expect(stat(join(repoDir, 'a.txt'))).rejects.toThrow();
    await expect(readFile(join(repoDir, 'renamed.txt'), 'utf8')).resolves.toBe('rename me\n');
  });

  it('applies a worker edit to the new endpoint of a staged rename', async () => {
    git(repoDir, ['mv', 'a.txt', 'renamed.txt']);
    const handle = await acquireSubagentWorktree(kaos, repoDir, { scope: ['renamed.txt'] });
    expect(handle).not.toBeNull();
    await writeFile(join(handle!.cwd, 'renamed.txt'), 'worker rename edit\n');
    await expect(handle!.finish({ kind: 'success' })).resolves.toEqual({ applied: true });
    await expect(readFile(join(repoDir, 'renamed.txt'), 'utf8')).resolves.toBe('worker rename edit\n');
    await expect(stat(join(repoDir, 'a.txt'))).rejects.toThrow();
  });

  it('preserves baseline mode changes and applies worker mode-only deltas', async () => {
    await chmod(join(repoDir, 'a.txt'), 0o755);
    const baseline = await acquireSubagentWorktree(kaos, repoDir);
    expect(baseline).not.toBeNull();
    await expect(baseline!.finish({ kind: 'success' })).resolves.toEqual({ applied: true });
    expect((await stat(join(repoDir, 'a.txt'))).mode & 0o777).toBe(0o755);

    const worker = await acquireSubagentWorktree(kaos, repoDir, { scope: ['a.txt'] });
    expect(worker).not.toBeNull();
    await chmod(join(worker!.cwd, 'a.txt'), 0o644);
    await expect(worker!.finish({ kind: 'success' })).resolves.toEqual({ applied: true });
    expect((await stat(join(repoDir, 'a.txt'))).mode & 0o777).toBe(0o644);
  });

  it('applies a symlink target change and rejects a symlink ancestor', async () => {
    await writeFile(join(repoDir, 'target-one.txt'), 'one\n');
    await writeFile(join(repoDir, 'target-two.txt'), 'two\n');
    await symlink('target-one.txt', join(repoDir, 'link.txt'));
    git(repoDir, ['add', 'target-one.txt', 'target-two.txt', 'link.txt']);
    git(repoDir, ['commit', '-q', '-m', 'add symlink']);

    const handle = await acquireSubagentWorktree(kaos, repoDir, { scope: ['link.txt'] });
    expect(handle).not.toBeNull();
    await rm(join(handle!.cwd, 'link.txt'));
    await symlink('target-two.txt', join(handle!.cwd, 'link.txt'));
    await expect(handle!.finish({ kind: 'success' })).resolves.toEqual({ applied: true });
    expect(await readFile(join(repoDir, 'link.txt'), 'utf8')).toBe('two\n');
    expect((await lstat(join(repoDir, 'link.txt'))).isSymbolicLink()).toBe(true);

    const guarded = await acquireSubagentWorktree(kaos, repoDir, { scope: ['dir/file.txt'] });
    expect(guarded).not.toBeNull();
    await rm(join(repoDir, 'dir'), { recursive: true, force: true });
    await symlink('.', join(repoDir, 'dir'));
    await mkdir(join(guarded!.cwd, 'dir'), { recursive: true });
    await writeFile(join(guarded!.cwd, 'dir', 'file.txt'), 'unsafe ancestor\n');
    await expect(guarded!.finish({ kind: 'success' })).rejects.toThrow(/unsafe non-directory ancestor/);
  });

  it('stores dirty-overlap before and after recovery payloads plus binary and deletion states', async () => {
    await writeFile(join(repoDir, 'a.txt'), 'hello\nbaseline\n');
    await writeFile(join(repoDir, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
    const handle = await acquireSubagentWorktree(kaos, repoDir, { scope: ['allowed'] });
    expect(handle).not.toBeNull();
    await writeFile(join(handle!.cwd, 'a.txt'), 'hello\nbaseline\nworker\n');
    await writeFile(join(handle!.cwd, 'binary.bin'), Buffer.from([255, 2, 1, 0]));
    await rm(join(handle!.cwd, 'a.txt'));
    await expect(handle!.finish({ kind: 'success' })).rejects.toThrow(/outside its declared scope/);

    const recovery = await onlyRecoveryDir(repoDir);
    const manifest = JSON.parse(await readFile(join(recovery, 'manifest.json'), 'utf8')) as {
      version: number;
      complete: boolean;
      deltas: Array<{ path: string; baseline: { kind: string }; workerFinal: { kind: string } }>;
    };
    expect(manifest.version).toBe(2);
    expect(manifest.complete).toBe(true);
    expect(manifest.deltas).toContainEqual(expect.objectContaining({
      path: 'a.txt',
      baseline: expect.objectContaining({ kind: 'regular' }),
      workerFinal: expect.objectContaining({ kind: 'absent' }),
    }));
    expect(await readFile(join(recovery, 'baseline', 'a.txt'), 'utf8')).toBe('hello\nbaseline\n');
    await expect(stat(join(recovery, 'worker-final', 'a.txt'))).rejects.toThrow();
    expect(await readFile(join(recovery, 'baseline', 'binary.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await readFile(join(recovery, 'worker-final', 'binary.bin'))).toEqual(Buffer.from([255, 2, 1, 0]));
  });

  it('rolls back every earlier path when a later multi-file operation fails', async () => {
    await writeFile(join(repoDir, 'b.txt'), 'before b\n');
    git(repoDir, ['add', 'b.txt']);
    git(repoDir, ['commit', '-q', '-m', 'add b']);
    const handle = await acquireSubagentWorktree(kaos, repoDir, { scope: ['a.txt', 'b.txt'] });
    expect(handle).not.toBeNull();
    await writeFile(join(handle!.cwd, 'a.txt'), 'worker a\n');
    await writeFile(join(handle!.cwd, 'b.txt'), 'worker b\n');
    __testing.failApplyAt(2);
    await expect(handle!.finish({ kind: 'success' })).rejects.toThrow(/test-injected apply failure/);
    __testing.failApplyAt(undefined);
    await expect(readFile(join(repoDir, 'a.txt'), 'utf8')).resolves.toBe('hello\n');
    await expect(readFile(join(repoDir, 'b.txt'), 'utf8')).resolves.toBe('before b\n');
  });

  it('refuses an unknown filesystem lock without deleting its owner metadata', async () => {
    const commonDir = git(repoDir, ['rev-parse', '--git-common-dir']).trim();
    const lockDir = join(repoDir, commonDir, 'kimi-code-subagent-apply.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'owner.json'), '{"owner":"external"}\n');
    const handle = await acquireSubagentWorktree(kaos, repoDir, { scope: ['a.txt'] });
    expect(handle).not.toBeNull();
    await writeFile(join(handle!.cwd, 'a.txt'), 'worker edit\n');
    await expect(handle!.finish({ kind: 'success' })).rejects.toThrow(/filesystem repository lock is held/);
    expect(await readFile(join(lockDir, 'owner.json'), 'utf8')).toBe('{"owner":"external"}\n');
  });
});
