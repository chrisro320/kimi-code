/**
 * `git` domain — `IGitService` implementation.
 *
 * Runs `git status` / `git diff` (and `gh pr view`) against a repository on
 * the local disk, and discovers the enclosing git work tree of a directory
 * (`findWorkTree`). Process spawning goes through the App-scope
 * `IHostProcessService`, and the single path-existence probe in `diff` goes
 * through `IHostFileSystem`; no Node platform API is imported directly. Bound
 * at App scope — it owns no Session dependency, so the caller supplies an
 * absolute `cwd` and already-confined repo-relative paths.
 */

import type {
  FsDiffResponse,
  FsGitStatusResponse,
  FsPullRequest,
  GitHeadEntry,
  GitRepoInfo,
} from './git';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, Error2 } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IRuntimeResolver, IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { isAbsolute, join, relative, resolve } from 'pathe';

import { IGitService } from './git';
import { parseNumstat, parsePorcelain, parsePullRequest } from './gitParsers';
import { findGitWorkTree, type GitWorkTree } from './workTree';

const DIFF_MAX_BYTES = 1_048_576;

const PR_SPAWN_TIMEOUT_MS = 5_000;
const PULL_REQUEST_TTL_MS = 60_000;

export class GitService implements IGitService {
  declare readonly _serviceBrand: undefined;

  private readonly pullRequestCache = new Map<
    string,
    { value: FsPullRequest | null; fetchedAt: number }
  >();

  constructor(
    @IRuntimeResolver private readonly resolver: IRuntimeResolver,
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostProcessService private readonly hostProcess: IHostProcessService,
  ) {}

  async status(cwd: string, pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse> {
    const inside = await this.runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const porc = await this.runCommand('git', ['status', '--porcelain=v1', '--branch'], cwd);
    if (porc.exitCode !== 0) {
      throw this.gitUnavailable(cwd, porc.stderr.trim() || `git status exit ${porc.exitCode}`);
    }

    const result = parsePorcelain(porc.stdout, pathFilter);

    const dirty = porc.stdout
      .split('\n')
      .some((line) => line.length > 0 && !line.startsWith('## '));
    if (dirty) {
      const head = await this.runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
      if (head.exitCode === 0) {
        const numstat = await this.runCommand('git', ['diff', '--no-color', '--numstat', 'HEAD', '--'], cwd);
        if (numstat.exitCode === 0) {
          const stats = parseNumstat(numstat.stdout);
          result.additions = stats.additions;
          result.deletions = stats.deletions;
        }
      }
    }

    result.pullRequest = await this.readPullRequest(cwd);
    return result;
  }

  async diff(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse> {
    const inside = await this.runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const statusRes = await this.runCommand('git', ['status', '--porcelain=v1', '--', relPath], cwd);
    if (statusRes.exitCode !== 0) {
      throw this.gitUnavailable(cwd, statusRes.stderr.trim() || `git status exit ${statusRes.exitCode}`);
    }
    const untracked = statusRes.stdout.startsWith('??');

    const headRes = await this.runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
    const hasHead = headRes.exitCode === 0;

    let diffStdout: string;
    if (untracked || !hasHead) {
      const res = await this.runCommand(
        'git',
        ['diff', '--no-color', '--no-index', '--', '/dev/null', relPath],
        cwd,
      );
      if (res.exitCode !== 0 && res.exitCode !== 1) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      diffStdout = res.stdout;
    } else {
      const res = await this.runCommand('git', ['diff', '--no-color', 'HEAD', '--', relPath], cwd);
      if (res.exitCode !== 0) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      if (res.stdout.length === 0 && statusRes.stdout.length === 0) {
        const exists = await this.fs.lstat(absPath).then(
          () => true,
          () => false,
        );
        if (!exists) {
          throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `path not found: ${relPath}`, {
            details: { path: relPath },
          });
        }
      }
      diffStdout = res.stdout;
    }

    const truncated = diffStdout.length > DIFF_MAX_BYTES;
    return {
      path: relPath,
      diff: truncated ? diffStdout.slice(0, DIFF_MAX_BYTES) : diffStdout,
      truncated,
    };
  }

  findWorkTree(cwd: string): Promise<GitWorkTree | null> {
    return findGitWorkTree(this.fs, cwd);
  }

  async repoInfo(cwd: string): Promise<GitRepoInfo | null> {
    const root = await this.runCommand('git', ['rev-parse', '--show-toplevel'], cwd);
    if (root.exitCode !== 0 || root.stdout.trim().length === 0) return null;
    const repoRoot = root.stdout.trim();
    const common = await this.runCommand('git', ['rev-parse', '--git-common-dir'], repoRoot);
    const commonRaw = common.stdout.trim();
    const commonDir =
      common.exitCode === 0 && commonRaw.length > 0
        ? isAbsolute(commonRaw)
          ? commonRaw
          : resolve(repoRoot, commonRaw)
        : join(repoRoot, '.git');
    const head = await this.runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], repoRoot);
    const headCommit = head.exitCode === 0 ? head.stdout.trim() : null;
    return { repoRoot, commonDir, headCommit };
  }

  async createDetachedWorktree(
    repoRoot: string,
    worktreeRoot: string,
    headCommit: string,
  ): Promise<void> {
    const res = await this.runCommand(
      'git',
      ['worktree', 'add', '--detach', worktreeRoot, headCommit],
      repoRoot,
    );
    if (res.exitCode !== 0) {
      throw this.gitUnavailable(
        repoRoot,
        res.stderr.trim() || `git worktree add exit ${res.exitCode}`,
      );
    }
  }

  async removeWorktree(repoRoot: string, worktreeRoot: string): Promise<void> {
    const res = await this.runCommand(
      'git',
      ['worktree', 'remove', '--force', worktreeRoot],
      repoRoot,
    );
    if (res.exitCode !== 0) {
      await this.runCommand('git', ['worktree', 'prune'], repoRoot);
    }
  }

  async diffChangedPaths(repoRoot: string): Promise<string[]> {
    const res = await this.runCommand('git', ['diff', '--name-status', '-z', 'HEAD'], repoRoot);
    if (res.exitCode !== 0) return [];
    const tokens = res.stdout.split('\0').filter(Boolean);
    const paths: string[] = [];
    let index = 0;
    while (index < tokens.length) {
      const status = tokens[index++] ?? '';
      const count = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
      for (let offset = 0; offset < count && index < tokens.length; offset += 1) {
        const path = tokens[index++];
        if (path !== undefined) paths.push(path);
      }
    }
    return paths;
  }

  async untrackedPaths(repoRoot: string): Promise<string[]> {
    const res = await this.runCommand(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      repoRoot,
    );
    if (res.exitCode !== 0) return [];
    const paths: string[] = [];
    for (const record of res.stdout.split('\0')) {
      if (!record.startsWith('?? ')) continue;
      const relPath = record.slice(3);
      if (relPath.length > 0) paths.push(relPath);
    }
    return paths;
  }

  async trackedPaths(repoRoot: string): Promise<string[]> {
    const res = await this.runCommand('git', ['ls-files', '-z'], repoRoot);
    return res.exitCode === 0 ? res.stdout.split('\0').filter(Boolean) : [];
  }

  async headEntry(repoRoot: string, relPath: string): Promise<GitHeadEntry> {
    const entry = await this.runCommand(
      'git',
      ['ls-files', '-s', '-z', 'HEAD', '--', relPath],
      repoRoot,
    );
    if (entry.exitCode !== 0) {
      return { kind: 'unreadable', error: `git ls-files: ${entry.stderr.trim() || 'failed'}` };
    }
    const record = entry.stdout.split('\0').find((token) => token.length > 0);
    if (record === undefined) return { kind: 'absent' };
    const match = /^(\d{6}) [0-9a-f]{40} \d\t/.exec(record);
    if (match === null) {
      return { kind: 'unreadable', error: `unparseable ls-files record for ${relPath}` };
    }
    const gitMode = match[1]!;
    if (gitMode === '160000') {
      return { kind: 'unreadable', error: `submodule gitlink is not supported: ${relPath}` };
    }
    const blob = await this.runCommandBytes('git', ['show', `HEAD:${relPath}`], repoRoot);
    if (blob.exitCode !== 0) {
      return { kind: 'unreadable', error: `git show: ${blob.stderr.trim() || 'failed'}` };
    }
    if (gitMode === '120000') {
      return { kind: 'symlink', target: blob.stdout.toString('utf8') };
    }
    return {
      kind: 'regular',
      mode: gitMode === '100755' ? 0o100755 : 0o100644,
      blob: blob.stdout,
    };
  }

  private async readPullRequest(cwd: string): Promise<FsPullRequest | null> {
    const cached = this.pullRequestCache.get(cwd);
    const now = Date.now();
    if (cached !== undefined && now - cached.fetchedAt < PULL_REQUEST_TTL_MS) {
      return cached.value;
    }

    const res = await this.runCommand(
      'gh',
      ['pr', 'view', '--json', 'number,url,state'],
      cwd,
      {
        env: { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' },
        timeoutMs: PR_SPAWN_TIMEOUT_MS,
      },
    );
    const value = res.exitCode === 0 ? parsePullRequest(res.stdout) : null;
    this.pullRequestCache.set(cwd, { value, fetchedAt: now });
    return value;
  }

  private async runCommand(
    cmd: string,
    args: readonly string[],
    cwd: string,
    options: RunOptions = {},
  ): Promise<RunResult> {
    const workspaceId = this.resolveWorkspaceId(cwd);
    const lease = this.resolver.acquire({ workspaceId, runtimeId: 'local' }, ['process']);
    const spawned = await lease.runtime.process!
      .spawn(cmd, args, { cwd, env: options.env })
      .then(
        (proc) => ({ ok: true as const, proc }),
        () => ({ ok: false as const }),
      );
    if (!spawned.ok) {
      return { exitCode: -1, stdout: '', stderr: '' };
    }
    const { proc } = spawned;

    const work = Promise.all([
      collect(proc.stdout),
      collect(proc.stderr),
      proc.wait().catch(() => -1),
    ] as const);
    work.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (options.timeoutMs === undefined) {
        const [stdout, stderr, exitCode] = await work;
        return { exitCode, stdout, stderr };
      }
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), options.timeoutMs);
        timer.unref?.();
      });
      const result = await Promise.race([
        work.then(
          ([stdout, stderr, exitCode]) =>
            ({ kind: 'done' as const, stdout, stderr, exitCode }),
        ),
        timeout.then((kind) => ({ kind })),
      ]);
      if (result.kind === 'done') {
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      }
      await proc.kill('SIGKILL').catch(() => {});
      const [stdout, stderr] = await work
        .then(([so, se]) => [so, se] as const)
        .catch(() => ['', ''] as const);
      return { exitCode: -1, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      void proc.dispose();
      lease.dispose();
    }
  }

  private resolveWorkspaceId(cwd: string): string {
    const exact = this.workspaces.findByRoot(cwd);
    if (exact !== undefined) return exact.id;

    const absoluteCwd = resolve(cwd);
    let workspaceId: string | undefined;
    let longestRoot = -1;
    for (const workspace of this.workspaces.list()) {
      const root = resolve(workspace.root);
      const rel = relative(root, absoluteCwd);
      const containsCwd = rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
      if (containsCwd && root.length > longestRoot) {
        workspaceId = workspace.id;
        longestRoot = root.length;
      }
    }
    if (workspaceId === undefined) {
      throw new Error(`workspace containing ${cwd} is not materialized`);
    }
    return workspaceId;
  }

  private gitUnavailable(cwd: string, detail: string): Error2 {
    return new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, `git unavailable at ${cwd}: ${detail}`, {
      details: { cwd, detail },
    });
  }

  private async runCommandBytes(
    cmd: string,
    args: readonly string[],
    cwd: string,
  ): Promise<RunBytesResult> {
    const spawned = await this.hostProcess
      .spawn(cmd, args, { cwd })
      .then(
        (proc) => ({ ok: true as const, proc }),
        () => ({ ok: false as const }),
      );
    if (!spawned.ok) {
      return { exitCode: -1, stdout: Buffer.alloc(0), stderr: '' };
    }
    const { proc } = spawned;
    const work = Promise.all([
      collectBytes(proc.stdout),
      collect(proc.stderr),
      proc.wait().catch(() => -1),
    ] as const);
    work.catch(() => {});
    try {
      const [stdout, stderr, exitCode] = await work;
      return { exitCode, stdout, stderr };
    } finally {
      proc.dispose();
    }
  }
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunBytesResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

interface RunOptions {
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
}

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
}

async function collectBytes(stream: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

registerScopedService(LifecycleScope.App, IGitService, GitService, ScopeActivation.OnScopeCreated, 'git');
