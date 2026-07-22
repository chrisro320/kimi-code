import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Normalized per-item shape `resolveEffectiveMaxConcurrency` needs. Callers
 * (e.g. `SessionSubagentHost.runQueued`) adapt their own task/profile
 * resolution into this shape so the risk checks stay pure and independently
 * testable, with no dependency on `Agent`/`ResolvedAgentProfile`/DI services.
 */
export interface RiskCheckItem {
  readonly isEditingCapable: boolean;
  readonly scope: readonly string[] | undefined;
}

const GIT_STATUS_TIMEOUT_MS = 5_000;

/**
 * Starting point for R-C1 signal 2 (concurrent editing item count), pending
 * phase-3 calibration against real false-positive/negative fixture data (see
 * design.md). Chosen to match `DISPATCH_MAX_ACTIVE_EDITING`
 * (`agent/dispatch/controller.ts`) — an already-calibrated concurrency limit
 * for the same kind of editing-capable dispatch — rather than an arbitrary
 * number.
 */
export const DEFAULT_RISK_CONCURRENCY_THRESHOLD = 4;

function editingScopes(items: readonly RiskCheckItem[]): string[][] {
  return items
    .filter((item) => item.isEditingCapable && item.scope !== undefined && item.scope.length > 0)
    .map((item) => [...(item.scope as readonly string[])]);
}

async function runGitStatus(workspaceDir: string, pathspec: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...pathspec], {
      cwd: workspaceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`git status timed out after ${String(GIT_STATUS_TIMEOUT_MS)}ms`));
    }, GIT_STATUS_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`git status exited ${String(code)}: ${stderr.trim()}`));
      }
    });
  });
}

/**
 * R-C1 signal 1: any uncommitted change under the union of this batch's
 * declared editing scopes. Scoped to those paths (not the whole repo) — an
 * unrelated dirty file elsewhere in a monorepo must not count, or `auto`
 * would effectively become "always serialize" (see design.md).
 *
 * Uses a direct `git status` spawn rather than the v2 `FsGitService`: that
 * service is DI-scoped to `ISessionService` (agent-core-v2), a different
 * architecture layer than the legacy `SessionSubagentHost` this runs in.
 *
 * An inconclusive result (git missing, cwd not a repo, timeout) resolves to
 * `false` rather than throwing: per Case 10, an indeterminate signal must not
 * be treated as a violation, and a risk-detector's own infra hiccup must
 * never crash an otherwise-legitimate AgentSwarm dispatch.
 */
export async function checkDirtyScope(
  items: readonly RiskCheckItem[],
  workspaceDir: string,
): Promise<boolean> {
  const scopes = editingScopes(items);
  if (scopes.length === 0) return false;
  const pathspec = [...new Set(scopes.flat())];
  if (pathspec.length === 0) return false;

  try {
    const output = await runGitStatus(workspaceDir, pathspec);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/** R-C1 signal 2: N or more editing items dispatched in the same batch. */
export function checkConcurrencyThreshold(items: readonly RiskCheckItem[], n: number): boolean {
  return items.filter((item) => item.isEditingCapable).length >= n;
}

/** The literal path portion before the first glob metacharacter, trimmed to a whole segment. */
const GLOB_METACHARACTERS = /[*?[\]{}]/;

function staticPrefix(entry: string): string {
  const metaIndex = entry.search(GLOB_METACHARACTERS);
  if (metaIndex === -1) return entry;
  const upToMeta = entry.slice(0, metaIndex);
  const lastSlash = upToMeta.lastIndexOf('/');
  return lastSlash === -1 ? '' : upToMeta.slice(0, lastSlash);
}

async function nearestManifestDir(workspaceDir: string, relativePath: string): Promise<string | undefined> {
  let dir = relativePath.length === 0 ? '.' : dirname(relativePath);
  for (;;) {
    const candidate = dir === '.' ? workspaceDir : join(workspaceDir, dir);
    const hasManifest = await Promise.all([
      access(join(candidate, 'package.json')).then(
        () => true,
        () => false,
      ),
      access(join(candidate, 'tsconfig.json')).then(
        () => true,
        () => false,
      ),
    ]).then(([pkg, tsconfig]) => pkg || tsconfig);
    if (hasManifest) return dir;
    if (dir === '.') return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * R-C1 signal 3: two or more editing items whose scopes don't literally
 * overlap (already rejected by `scopesOverlap` elsewhere) but resolve to the
 * same nearest package.json/tsconfig.json ancestor directory — a proxy for
 * "logically dependent, not just path-disjoint" (see design.md's Case 9
 * background on shared config/export/test dependencies). This is a starting
 * heuristic pending calibration (phase 3): if it proves too permissive in a
 * large monorepo package, a real dependency-graph read may be needed instead.
 */
export async function checkFileFamilyOverlap(
  items: readonly RiskCheckItem[],
  workspaceDir: string,
): Promise<boolean> {
  const scopes = editingScopes(items);
  if (scopes.length < 2) return false;

  const manifestDirsByItem = await Promise.all(
    scopes.map(async (scope) => {
      const dirs = await Promise.all(
        scope.map((entry) => nearestManifestDir(workspaceDir, staticPrefix(entry))),
      );
      return new Set(dirs.filter((d): d is string => d !== undefined));
    }),
  );

  for (let i = 0; i < manifestDirsByItem.length; i += 1) {
    for (let j = i + 1; j < manifestDirsByItem.length; j += 1) {
      for (const dir of manifestDirsByItem[i]!) {
        if (manifestDirsByItem[j]!.has(dir)) return true;
      }
    }
  }
  return false;
}

export interface RiskContext {
  readonly workspaceDir: string;
  readonly concurrencyThreshold: number;
}

/**
 * Combines the three R-C1 signals: if this batch has no editing-capable item
 * at all, skip risk detection entirely (read-only swarms can't hit Case 9) and
 * return `configured` unchanged. Otherwise, any signal hitting forces
 * `maxConcurrency` down to 1 (silent serialization — no ask, no turn
 * interruption; see design.md for why). No signal hitting leaves `configured`
 * untouched, so `auto` must not become "always serialize".
 */
export async function resolveEffectiveMaxConcurrency(
  items: readonly RiskCheckItem[],
  configured: number | undefined,
  ctx: RiskContext,
): Promise<number | undefined> {
  if (!items.some((item) => item.isEditingCapable)) return configured;

  const [dirty, fileFamily] = await Promise.all([
    checkDirtyScope(items, ctx.workspaceDir),
    checkFileFamilyOverlap(items, ctx.workspaceDir),
  ]);
  if (dirty) return 1;
  if (checkConcurrencyThreshold(items, ctx.concurrencyThreshold)) return 1;
  if (fileFamily) return 1;
  return configured;
}
