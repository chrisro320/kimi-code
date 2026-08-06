import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { ILogService } from '#/_base/log/log';
import { IGitService } from '#/app/git/git';
import { GitService } from '#/app/git/gitService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import {
  __testing,
  acquireSubagentWorktree,
  applySubagentWorktreeCandidate,
  isSubagentWorktreeUnsupported,
  type SubagentWorktreeHandle,
  type SubagentWorktreeServices,
} from '#/session/subagent/worktree';

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-test-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

describe('subagent worktree isolation (real git integration)', () => {
  let repo: string;
  let disposables: DisposableStore;
  let services: SubagentWorktreeServices;

  beforeEach(() => {
    repo = makeRepo();
    disposables = new DisposableStore();
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
        reg.define(IHostFileSystem, HostFileSystem);
        reg.define(IGitService, GitService);
      },
    });
    services = {
      git: ix.get(IGitService),
      fs: ix.get(IHostFileSystem),
      proc: ix.get(IHostProcessService),
      log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as unknown as ILogService,
    };
    __testing.failApplyAt(undefined);
  });

  afterEach(() => {
    disposables.dispose();
    rmSync(repo, { recursive: true, force: true });
  });

  async function acquire(scope?: readonly string[]): Promise<SubagentWorktreeHandle> {
    const acquisition = await acquireSubagentWorktree(services, repo, { scope });
    if (acquisition === null || isSubagentWorktreeUnsupported(acquisition)) {
      throw new Error('unexpected unsupported/null acquisition');
    }
    return acquisition;
  }

  it('reports isolation as unsupported when the directory is not a git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-no-git-'));
    try {
      const acquisition = await acquireSubagentWorktree(services, dir);
      expect(isSubagentWorktreeUnsupported(acquisition)).toBe(true);
      if (isSubagentWorktreeUnsupported(acquisition)) {
        expect(acquisition.unsupported).toContain('not a git repository');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports isolation as unsupported for a repository with no commits yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-unborn-'));
    try {
      git(dir, ['init', '-q']);
      const acquisition = await acquireSubagentWorktree(services, dir);
      expect(isSubagentWorktreeUnsupported(acquisition)).toBe(true);
      if (isSubagentWorktreeUnsupported(acquisition)) {
        expect(acquisition.unsupported).toContain('no commit');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('seeds dirty and untracked baseline state without touching the source', async () => {
    writeFileSync(join(repo, 'a.txt'), 'dirty\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    const handle = await acquire();
    expect(git(repo, ['worktree', 'list'])).toContain(handle.cwd);
  });

  it('applies an in-scope worker delta back onto the workspace, then removes the worktree', async () => {
    const handle = await acquire();
    writeFileSync(join(handle.cwd, 'a.txt'), 'worker edit\n');
    const result = await handle.finish({ kind: 'success' });
    expect(result.applied).toBe(true);
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toContain('a.txt');
    expect(git(repo, ['worktree', 'list'])).not.toContain(handle.cwd);
  });

  it('applies a worker-side deletion of a tracked file', async () => {
    const handle = await acquire();
    rmSync(join(handle.cwd, 'a.txt'));
    const result = await handle.finish({ kind: 'success' });
    expect(result.applied).toBe(true);
    expect(git(repo, ['status', '--porcelain'])).toContain('a.txt');
  });

  it('returns a worker-only scope-expansion candidate without mutating the workspace', async () => {
    const handle = await acquire(['a.txt']);
    writeFileSync(join(handle.cwd, 'b.txt'), 'outside scope\n');
    const result = await handle.finish({ kind: 'success' });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('scope-expansion-required');
    expect(result.outsideScope).toEqual(['b.txt']);
    expect(result.candidate?.requestedScope).toEqual(['a.txt', 'b.txt']);
    expect(() => execFileSync('git', ['-C', repo, 'show', 'HEAD:b.txt'], { encoding: 'utf8' })).toThrow();
    expect(git(repo, ['worktree', 'list'])).toContain(handle.cwd);
  });

  it('applies an approved scope-expansion candidate', async () => {
    const handle = await acquire(['a.txt']);
    writeFileSync(join(handle.cwd, 'b.txt'), 'outside scope\n');
    const result = await handle.finish({ kind: 'success' });
    expect(result.candidate).toBeDefined();
    await applySubagentWorktreeCandidate(services, result.candidate!, result.candidate!.requestedScope);
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toContain('b.txt');
  });

  it('orders candidate paths by code unit, not by collation', async () => {
    const handle = await acquire(['a.txt']);
    writeFileSync(join(handle.cwd, 'w_x.txt'), 'underscore\n');
    writeFileSync(join(handle.cwd, 'w-x.txt'), 'hyphen\n');
    const result = await handle.finish({ kind: 'success' });
    expect(result.candidate?.requestedScope).toEqual(['a.txt', 'w-x.txt', 'w_x.txt']);
  });

  it('rejects worker-planted symlinks with escaping or absolute targets', async () => {
    for (const target of ['../../etc/passwd', '/etc/passwd']) {
      const handle = await acquire();
      symlinkSync(target, join(handle.cwd, 'evil-link'));
      await expect(handle.finish({ kind: 'success' })).rejects.toThrow('unsafe symlink target');
      expect(
        execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).includes('evil-link'),
      ).toBe(false);
    }
  });

  it('rejects and preserves recovery data when the workspace changed underneath the worker', async () => {
    const handle = await acquire();
    writeFileSync(join(repo, 'a.txt'), 'external concurrent edit\n');
    writeFileSync(join(handle.cwd, 'a.txt'), 'worker edit\n');
    await expect(handle.finish({ kind: 'success' })).rejects.toThrow('diverged');
    expect(
      execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }),
    ).toContain('a.txt');
  });

  it('preserves recovery data on an incomplete outcome without applying anything', async () => {
    const handle = await acquire();
    writeFileSync(join(handle.cwd, 'a.txt'), 'worker edit\n');
    const result = await handle.finish({ kind: 'incomplete', reason: 'worker died' });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('worker died');
    expect(result.recoveryPath).toBeDefined();
    expect(git(repo, ['worktree', 'list'])).not.toContain(handle.cwd);
  });

  it('rolls back every earlier path when a later multi-file operation fails', async () => {
    const handle = await acquire();
    writeFileSync(join(handle.cwd, 'b.txt'), 'first\n');
    writeFileSync(join(handle.cwd, 'a.txt'), 'second\n');
    __testing.failApplyAt(2);
    await expect(handle.finish({ kind: 'success' })).rejects.toThrow('test-injected apply failure');
    expect(
      execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }),
    ).not.toContain('a.txt');
    expect(
      execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }),
    ).not.toContain('b.txt');
  });

  it('rejects an approved candidate whose requested scope differs from the manifest', async () => {
    const handle = await acquire(['a.txt']);
    writeFileSync(join(handle.cwd, 'b.txt'), 'outside scope\n');
    const result = await handle.finish({ kind: 'success' });
    expect(result.candidate).toBeDefined();
    await expect(
      applySubagentWorktreeCandidate(services, result.candidate!, ['a.txt']),
    ).rejects.toThrow('candidate_identity_mismatch');
  });
});
