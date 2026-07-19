import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalKaos } from '@moonshot-ai/kaos';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { acquireSubagentWorktree } from '../../src/session/subagent-worktree';

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

let runRealGit = false;
const tempDirs: string[] = [];

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
    expect(await readFile(join(recoveryDir, 'worker.diff'), 'utf8')).toContain('out of scope edit');
  });

  it('rejects and preserves recovery data when the workspace changed underneath the running subagent (baseline mismatch)', async () => {
    const handle = await acquireSubagentWorktree(kaos, repoDir);
    expect(handle).not.toBeNull();
    const worktreeCwd = handle!.cwd;

    await writeFile(join(worktreeCwd, 'a.txt'), 'hello\nworker edit\n');
    // Concurrently, the main workspace changes underneath the running subagent.
    await writeFile(join(repoDir, 'a.txt'), 'hello\nconcurrent human edit\n');

    await expect(handle!.finish({ kind: 'success' })).rejects.toThrow(/changed while the editing subagent/);

    // The concurrent edit must survive untouched, not be overwritten by the worker's delta.
    expect(await readFile(join(repoDir, 'a.txt'), 'utf8')).toBe('hello\nconcurrent human edit\n');
    expect(git(repoDir, ['worktree', 'list'])).not.toContain(worktreeCwd);
  });

  it('rejects on a new commit landing on the source repo while the subagent was running (HEAD moved)', async () => {
    const handle = await acquireSubagentWorktree(kaos, repoDir);
    expect(handle).not.toBeNull();

    await writeFile(join(repoDir, 'b.txt'), 'second file\n');
    git(repoDir, ['add', 'b.txt']);
    git(repoDir, ['commit', '-q', '-m', 'second commit']);

    await expect(handle!.finish({ kind: 'success' })).rejects.toThrow(/changed while the editing subagent/);
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
});
