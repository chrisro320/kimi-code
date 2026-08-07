/**
 * `subagent` domain — editing-subagent worktree isolation.
 *
 * Runs editing-capable subagents in a temporary detached git worktree seeded
 * from the repository's uncommitted state, then applies the worker's delta
 * back to the caller workspace through guarded candidate-path checks
 * (identity vs. the declared scope, baseline divergence detection, symlink
 * escape rejection) while holding a per-repository apply lock. Changes
 * outside the declared scope produce a durable scope-expansion candidate
 * instead of being applied or discarded.
 *
 * Baseline semantics: only uncommitted state (tracked dirty + untracked
 * paths) is seeded and snapshotted — `git worktree add` already populates
 * clean tracked files from HEAD, so snapshotting the whole tree would pin
 * the repo's bytes in memory for the subagent's lifetime. Worker edits to
 * clean tracked files are discovered at finish time via `git diff HEAD` in
 * the worktree, with their `before` state reconstructed from HEAD blobs;
 * such paths reconstruct as `absent` when unknown to HEAD and `unreadable`
 * for anything unsupported (e.g. submodule gitlinks), failing closed.
 *
 * Symlink safety: worker-planted symlinks are a read-path escape — applied
 * into the real workspace, a later Read following the link leaves the repo
 * and the declared scope. Only relative targets that resolve back inside the
 * repo are applied; absolute or escaping targets fail closed.
 *
 * State comparison only reads what git itself tracks: content hash, file
 * type, and the owner-exec bit. The remaining permission bits are umask
 * noise that would falsely flag an untouched file as diverged whenever one
 * side of the comparison comes from a HEAD blob (mode 644/755) and the other
 * from a stat (e.g. 664 under umask 002). Symlinks compare by target alone,
 * their modes being neither portable nor reliably settable.
 *
 * Isolation can never work in some workspaces (non-POSIX backend, not a git
 * repository, no commit to base a worktree on); that is a property of the
 * environment, not a failure, and surfaces as `SubagentWorktreeUnsupported`.
 * A `null` acquisition instead means isolation *should* have worked but did
 * not (creation failed, baseline could not be snapshotted, seeded tree
 * diverged) and still refuses dispatch: running unisolated in a repository
 * whose state we failed to capture is the exact situation isolation exists
 * to prevent. Failed or refused applies preserve the worker's state under
 * the recovery directory with a manifest instead of discarding it.
 *
 * Ported from v1 `session/subagent-worktree.ts` (design D-B6-1/2): git
 * operations go through `git` (`IGitService`), filesystem operations
 * through `fs` (`IHostFileSystem`) plus POSIX commands through `proc`
 * (`IHostProcessService` — mode bits and symlink targets are not exposed by
 * the fs contract), and diagnostics through `log` (`ILogService`). Not a
 * Service: the exported functions take the collaborator services explicitly.
 * Path ordering is by UTF-16 code unit (never locale collation) so manifest
 * order stays a contract the integrity check re-derives with a plain sort.
 */

import { createHash } from 'node:crypto';

import * as pathe from 'pathe';

import { IGitService, type GitHeadEntry } from '#/app/git/git';
import { IHostFileSystem, type HostFileStat, type HostDirEntry } from '#/os/interface/hostFileSystem';
import {
  IHostProcessService,
  type IHostProcess,
} from '#/os/interface/hostProcess';
import { ILogService } from '#/_base/log/log';
import { pathGlobMatch } from '#/tool/rule-match';

const GIT_TIMEOUT_MS = 30_000;
const FILE_LOCK_TIMEOUT_MS = 500;
const repoApplyQueues = new Map<string, Promise<void>>();

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

export interface SubagentWorktreeServices {
  readonly git: IGitService;
  readonly fs: IHostFileSystem;
  readonly proc: IHostProcessService;
  readonly log: ILogService;
}

export interface SubagentWorktreeOptions {
  readonly scope?: readonly string[];
}

export type SubagentWorktreeOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'incomplete'; readonly reason?: string }
  | { readonly kind: 'discard'; readonly reason?: string };

export interface SubagentWorktreeFinishResult {
  readonly applied: boolean;
  readonly reason?: string;
  readonly recoveryPath?: string;
  readonly outsideScope?: readonly string[];
  readonly candidate?: EditingCandidateDraft;
  readonly acknowledgePersisted?: () => Promise<void>;
}

export interface SubagentWorktreeHandle {
  readonly cwd: string;
  finish(outcome: SubagentWorktreeOutcome): Promise<SubagentWorktreeFinishResult>;
}

export interface SubagentWorktreeUnsupported {
  readonly unsupported: string;
}

export type SubagentWorktreeAcquisition =
  | SubagentWorktreeHandle
  | SubagentWorktreeUnsupported
  | null;

export function isSubagentWorktreeUnsupported(
  acquisition: SubagentWorktreeAcquisition,
): acquisition is SubagentWorktreeUnsupported {
  return acquisition !== null && 'unsupported' in acquisition;
}

export type EditingCandidatePathClassification = 'in_scope' | 'scope_expansion_requested';

export type EditingCandidatePathState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'regular'; readonly mode: number; readonly sha256: string }
  | { readonly kind: 'directory'; readonly mode: number }
  | { readonly kind: 'symlink'; readonly mode: number; readonly target: string }
  | { readonly kind: 'special'; readonly mode: number }
  | { readonly kind: 'unreadable'; readonly error: string };

export interface EditingCandidatePathSnapshot {
  readonly state: EditingCandidatePathState;
  readonly payload?: Uint8Array;
}

export interface EditingCandidatePath {
  readonly relPath: string;
  readonly classification: EditingCandidatePathClassification;
  readonly before: EditingCandidatePathSnapshot;
  readonly after: EditingCandidatePathSnapshot;
}

export interface EditingCandidateDraft {
  readonly version: 1;
  readonly candidateHash: string;
  readonly repoRoot: string;
  readonly commonDir: string;
  readonly headCommit: string;
  readonly scope: readonly string[];
  readonly requestedScope: readonly string[];
  readonly paths: readonly EditingCandidatePath[];
}

type PathState = EditingCandidatePathState;
type PathSnapshot = EditingCandidatePathSnapshot;
type Delta = Omit<EditingCandidatePath, 'classification'>;

interface WorktreeContext {
  readonly repoRoot: string;
  readonly commonDir: string;
  readonly worktreeRoot: string;
  readonly recoveryDir: string;
  readonly headCommit: string;
  readonly baseline: ReadonlyMap<string, PathSnapshot>;
  readonly candidates: ReadonlySet<string>;
  readonly scope: readonly string[];
  readonly capabilities: Capabilities;
}

interface IsolationRootResolution {
  readonly repoRoot: string;
  readonly scope: readonly string[];
}

interface Capabilities {
  readonly posix: boolean;
  readonly stateMaterialization: boolean;
  readonly symlink: boolean;
}

interface RecoveryResult {
  readonly path: string;
  readonly complete: boolean;
}

interface CommandResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandBytesResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

let testApplyFailureAt: number | undefined;

export const __testing = {
  failApplyAt(operation: number | undefined): void {
    testApplyFailureAt = operation;
  },
};

/**
 * Releases a worktree acquired for a spawn that never reached its first run.
 * Every acquisition has to be paired with this on the failure path (v1 does it
 * in `subagent-host.ts` under the same reason string): without it a throw
 * between acquire and the child's first run leaks both the worktree
 * registration and its checkout, and no completion handler will ever fire to
 * clean them up.
 */
export async function discardSpawnWorktree(
  worktree: SubagentWorktreeHandle | undefined,
): Promise<void> {
  if (worktree === undefined) return;
  await worktree
    .finish({ kind: 'discard', reason: 'spawn aborted before the child started' })
    .catch(() => {});
}

export async function acquireSubagentWorktree(
  services: SubagentWorktreeServices,
  repoCwd: string,
  options: SubagentWorktreeOptions = {},
): Promise<SubagentWorktreeAcquisition> {
  const capabilities = getCapabilities();
  if (!capabilities.stateMaterialization) {
    return { unsupported: 'the backend cannot materialize POSIX filesystem state' };
  }

  const info = await services.git.repoInfo(repoCwd);
  if (info === null) {
    return { unsupported: 'the workspace is not a git repository' };
  }
  const rootResolution = await resolveIsolationRoot(services, info.repoRoot, options.scope);
  if (rootResolution === null) return null;
  const repoRoot = rootResolution.repoRoot;
  const effectiveCwd = repoRoot === info.repoRoot ? repoCwd : repoRoot;
  const repoInfo = await services.git.repoInfo(effectiveCwd);
  if (repoInfo === null) {
    return { unsupported: 'the workspace is not a git repository' };
  }
  const headCommit = repoInfo.headCommit;
  if (headCommit === null) {
    return { unsupported: 'the repository has no commit to base an isolated worktree on' };
  }
  const commonDir = repoInfo.commonDir;
  const id = randomId();
  const worktreeRoot = pathe.join(commonDir, 'kimi-code-subagent-worktrees', id);
  const recoveryDir = pathe.join(commonDir, 'kimi-code-subagent-recovery', id);

  let candidates: string[];
  let baseline: Map<string, PathSnapshot>;
  try {
    candidates = await acquisitionCandidates(services, repoRoot);
    await assertSafePathSet(services, repoRoot, candidates);
    baseline = await snapshotPaths(services, repoRoot, candidates);
    assertReadableSnapshots(baseline);
  } catch (error) {
    logWarn(services, 'subagent worktree: unable to capture a safe source baseline', {
      repoRoot,
      error: errorMessage(error),
    });
    return null;
  }

  await services.fs.mkdir(pathe.dirname(worktreeRoot), { recursive: true });
  try {
    await services.git.createDetachedWorktree(repoRoot, worktreeRoot, headCommit);
  } catch (error) {
    logWarn(services, 'subagent worktree: git worktree add failed', {
      repoRoot,
      error: errorMessage(error),
    });
    return null;
  }

  try {
    for (const relPath of candidates) {
      await materializeState(services, worktreeRoot, relPath, baseline.get(relPath)!, undefined);
    }
    await assertSafePathSet(services, worktreeRoot, candidates);
    const seeded = await snapshotPaths(services, worktreeRoot, candidates);
    if (!snapshotMapsEqual(baseline, seeded)) throw new Error('seeded filesystem state differs from source baseline');
  } catch (error) {
    await removeWorktree(services, repoRoot, worktreeRoot);
    logWarn(services, 'subagent worktree: failed to seed isolated filesystem baseline', {
      repoRoot,
      error: errorMessage(error),
    });
    return null;
  }

  const relativeCwd = normalizePath(pathe.relative(repoRoot, repoCwd));
  const childCwd = isCanonicalRelativePath(relativeCwd) ? pathe.join(worktreeRoot, relativeCwd) : worktreeRoot;
  try {
    if (isCanonicalRelativePath(relativeCwd)) await assertSafeAncestors(services, worktreeRoot, relativeCwd);
    await services.fs.mkdir(childCwd, { recursive: true });
  } catch {
    await removeWorktree(services, repoRoot, worktreeRoot);
    return null;
  }

  const ctx: WorktreeContext = {
    repoRoot,
    commonDir,
    worktreeRoot,
    recoveryDir,
    headCommit,
    baseline,
    candidates: new Set(candidates),
    scope: rootResolution.scope,
    capabilities,
  };
  let settled: Promise<SubagentWorktreeFinishResult> | undefined;
  return {
    cwd: childCwd,
    finish(outcome) {
      settled ??= finishWorktree(services, ctx, outcome);
      return settled;
    },
  };
}

async function finishWorktree(
  services: SubagentWorktreeServices,
  ctx: WorktreeContext,
  outcome: SubagentWorktreeOutcome,
): Promise<SubagentWorktreeFinishResult> {
  if (outcome.kind === 'discard') {
    await removeWorktree(services, ctx.repoRoot, ctx.worktreeRoot);
    return {
      applied: false,
      reason: outcome.reason ?? 'discarded',
    };
  }
  if (outcome.kind === 'incomplete') {
    return finishWithRecovery(services, ctx, outcome.reason ?? 'incomplete');
  }

  let deltas: Delta[];
  try {
    deltas = await collectDeltas(services, ctx);
  } catch (error) {
    return finishWithRecovery(services, ctx, `snapshot-failed: ${errorMessage(error)}`);
  }

  const outside = ctx.scope.length === 0
    ? []
    : deltas.filter((delta) => !isPathInScope(delta.relPath, ctx.scope)).map((delta) => delta.relPath);
  if (outside.length > 0) {
    const candidate = createEditingCandidateDraft(ctx, deltas);
    return {
      applied: false,
      reason: 'scope-expansion-required',
      outsideScope: outside,
      candidate,
      acknowledgePersisted: () => removeWorktree(services, ctx.repoRoot, ctx.worktreeRoot),
    };
  }

  if (deltas.length === 0) {
    await removeWorktree(services, ctx.repoRoot, ctx.worktreeRoot);
    return { applied: true };
  }

  try {
    await withRepoApplyLock(services, ctx.commonDir, async () => {
      await assertCandidateBaseline(services, ctx.repoRoot, ctx.capabilities, deltas, 'worker delta path(s) diverged');
      await applyDeltaPlan(services, ctx.repoRoot, deltas);
    });
  } catch (error) {
    const reason = `apply-failed: ${errorMessage(error)}`;
    const recovery = await preserveRecovery(services, ctx, reason).catch((recoveryError) => ({
      path: undefined,
      complete: false,
      error: errorMessage(recoveryError),
    }));
    if (recovery.complete) await removeWorktree(services, ctx.repoRoot, ctx.worktreeRoot);
    throw new Error(
      `Failed to apply editing subagent changes to the workspace: ${errorMessage(error)}` +
      (recovery.path === undefined ? '' : ` (recovery data preserved at ${recovery.path})`),
    );
  }

  await removeWorktree(services, ctx.repoRoot, ctx.worktreeRoot);
  return { applied: true };
}

async function finishWithRecovery(
  services: SubagentWorktreeServices,
  ctx: WorktreeContext,
  reason: string,
): Promise<SubagentWorktreeFinishResult> {
  const recovery = await preserveRecovery(services, ctx, reason).catch((error) => {
    logWarn(services, 'subagent worktree: failed to preserve recovery data', {
      worktreeRoot: ctx.worktreeRoot,
      error: errorMessage(error),
    });
    return undefined;
  });
  if (recovery?.complete) await removeWorktree(services, ctx.repoRoot, ctx.worktreeRoot);
  return {
    applied: false,
    reason,
    recoveryPath: recovery?.path,
  };
}

async function collectDeltas(
  services: SubagentWorktreeServices,
  ctx: WorktreeContext,
): Promise<Delta[]> {
  const [workerUntracked, workerChanged] = await Promise.all([
    services.git.untrackedPaths(ctx.worktreeRoot),
    services.git.diffChangedPaths(ctx.worktreeRoot),
  ]);
  const candidateInputs = [...ctx.candidates, ...workerUntracked, ...workerChanged];
  const candidates = canonicalizePathSet(candidateInputs);
  await assertSafePathSet(services, ctx.worktreeRoot, candidates);
  const workerFinal = await snapshotPaths(services, ctx.worktreeRoot, candidates);
  const deltas: Delta[] = [];
  for (const relPath of candidates) {
    const before = ctx.baseline.get(relPath) ?? await captureHeadPath(services, ctx.worktreeRoot, relPath);
    const after = workerFinal.get(relPath)!;
    if (!snapshotsEqual(before, after)) deltas.push({ relPath, before, after });
  }
  return deltas.sort((left, right) => (left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0));
}

function createEditingCandidateDraft(ctx: WorktreeContext, deltas: readonly Delta[]): EditingCandidateDraft {
  const paths: EditingCandidatePath[] = deltas.map((delta) => ({
    ...delta,
    classification: isPathInScope(delta.relPath, ctx.scope)
      ? 'in_scope'
      : 'scope_expansion_requested',
  }));
  const requestedScope = canonicalizePathSet([
    ...ctx.scope,
    ...paths
      .filter((path) => path.classification === 'scope_expansion_requested')
      .map((path) => path.relPath),
  ]);
  const draft = {
    version: 1 as const,
    candidateHash: '',
    repoRoot: ctx.repoRoot,
    commonDir: ctx.commonDir,
    headCommit: ctx.headCommit,
    scope: ctx.scope,
    requestedScope,
    paths,
  };
  return { ...draft, candidateHash: candidateDigest(draft) };
}

function candidateDigest(candidate: Omit<EditingCandidateDraft, 'candidateHash'>): string {
  return createHash('sha256').update(JSON.stringify({
    version: candidate.version,
    repoRoot: candidate.repoRoot,
    commonDir: candidate.commonDir,
    headCommit: candidate.headCommit,
    scope: candidate.scope,
    requestedScope: candidate.requestedScope,
    paths: candidate.paths.map((path) => ({
      relPath: path.relPath,
      classification: path.classification,
      before: path.before.state,
      after: path.after.state,
    })),
  })).digest('hex');
}

export function assertSubagentWorktreeCandidateIntegrity(
  candidate: EditingCandidateDraft,
): void {
  const { candidateHash, ...unsigned } = candidate;
  if (candidateDigest(unsigned) !== candidateHash) throw new Error('candidate_corrupt: manifest hash mismatch');
  const canonicalPaths = canonicalizePathSet(candidate.paths.map((path) => path.relPath));
  if (canonicalPaths.some((path) => isSecretPath(path))) {
    throw new Error('candidate_corrupt: secret path is not allowed');
  }
  if (JSON.stringify(canonicalPaths) !== JSON.stringify(candidate.paths.map((path) => path.relPath))) {
    throw new Error('candidate_corrupt: paths are not canonical and sorted');
  }
  for (const path of candidate.paths) {
    for (const [side, snapshot] of [['before', path.before], ['after', path.after]] as const) {
      if (snapshot.state.kind !== 'regular') continue;
      if (snapshot.payload === undefined || digest(snapshot.payload) !== snapshot.state.sha256) {
        throw new Error(`candidate_corrupt: ${path.relPath} ${side} payload hash mismatch`);
      }
    }
  }
}

async function assertCandidateBaseline(
  services: SubagentWorktreeServices,
  repoRoot: string,
  capabilities: Capabilities,
  deltas: readonly Delta[],
  reason: string,
): Promise<void> {
  if (!capabilities.stateMaterialization) throw new Error('backend does not support safe POSIX state materialization');
  for (const delta of deltas) {
    await assertSafeExistingAncestors(services, repoRoot, delta.relPath);
  }
  for (const delta of deltas) {
    const current = await capturePath(services, pathe.join(repoRoot, delta.relPath));
    if (!snapshotsEqual(current, delta.before)) throw new Error(`${reason}: ${delta.relPath}`);
  }
}

export async function applySubagentWorktreeCandidate(
  services: SubagentWorktreeServices,
  candidate: EditingCandidateDraft,
  approvedScope: readonly string[],
): Promise<{ readonly applied: true }> {
  assertSubagentWorktreeCandidateIntegrity(candidate);
  const normalizedScope = normalizeScope(approvedScope);
  if (JSON.stringify(normalizedScope) !== JSON.stringify(candidate.requestedScope)) {
    throw new Error('candidate_identity_mismatch: requested scope does not match');
  }
  for (const path of candidate.paths) {
    if (!isPathInScope(path.relPath, normalizedScope)) {
      throw new Error(`candidate_identity_mismatch: approved scope excludes ${path.relPath}`);
    }
  }
  const capabilities = getCapabilities();
  const deltas: Delta[] = candidate.paths.map(({ relPath, before, after }) => ({ relPath, before, after }));
  await withRepoApplyLock(services, candidate.commonDir, async () => {
    await assertCandidateBaseline(services, candidate.repoRoot, capabilities, deltas, 'candidate_path_diverged');
    await applyDeltaPlan(services, candidate.repoRoot, deltas);
  });
  return { applied: true };
}
async function applyDeltaPlan(
  services: SubagentWorktreeServices,
  repoRoot: string,
  deltas: readonly Delta[],
): Promise<void> {
  const stageRoot = pathe.join(repoRoot, `.kimi-code-subagent-apply-${randomId()}`);
  const staged = new Map<string, string>();
  await services.fs.mkdir(stageRoot, { recursive: false }).catch(() => {
    throw new Error(`unable to create staging directory ${stageRoot}`);
  });
  try {
    for (const delta of deltas) {
      if (delta.after.state.kind !== 'regular') continue;
      if (delta.after.payload === undefined) throw new Error(`missing worker payload for ${delta.relPath}`);
      const stagedPath = pathe.join(stageRoot, 'after', delta.relPath);
      await services.fs.mkdir(pathe.dirname(stagedPath), { recursive: true });
      await services.fs.writeBytes(stagedPath, delta.after.payload);
      await runCommand(services, ['chmod', '--', modeArgument(delta.after.state.mode), stagedPath]);
      staged.set(delta.relPath, stagedPath);
    }
    await services.fs.writeText(pathe.join(stageRoot, 'journal.json'), `${JSON.stringify({
      version: 1,
      paths: deltas.map((delta) => delta.relPath),
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`);

    const completed: Delta[] = [];
    let operation = 0;
    try {
      for (const delta of deltas) {
        operation += 1;
        if (testApplyFailureAt === operation) throw new Error(`test-injected apply failure at operation ${operation}`);
        await assertSafeExistingAncestors(services, repoRoot, delta.relPath);
        if (delta.after.state.kind === 'symlink') assertSafeSymlinkTarget(repoRoot, delta.relPath, delta.after.state.target);
        const current = await capturePath(services, pathe.join(repoRoot, delta.relPath));
        if (!snapshotsEqual(current, delta.before)) throw new Error(`worker delta path(s) diverged: ${delta.relPath}`);
        await materializeState(services, repoRoot, delta.relPath, delta.after, staged.get(delta.relPath));
        const final = await capturePath(services, pathe.join(repoRoot, delta.relPath));
        if (!snapshotsEqual(final, delta.after)) throw new Error(`postcondition failed for ${delta.relPath}`);
        completed.push(delta);
      }
      for (const delta of deltas) {
        const final = await capturePath(services, pathe.join(repoRoot, delta.relPath));
        if (!snapshotsEqual(final, delta.after)) throw new Error(`postcondition failed for ${delta.relPath}`);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const delta of completed.reverse()) {
        try {
          await guardedRollback(services, repoRoot, delta);
        } catch (rollbackError) {
          rollbackErrors.push(`${delta.relPath}: ${errorMessage(rollbackError)}`);
        }
      }
      if (rollbackErrors.length > 0) throw new Error(`${errorMessage(error)}; guarded rollback incomplete: ${rollbackErrors.join('; ')}`);
      throw error;
    }
  } finally {
    await removeTree(services, stageRoot).catch(() => {});
  }
}

function assertSafeSymlinkTarget(repoRoot: string, relPath: string, target: string): void {
  if (pathe.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target)) {
    throw new Error(`unsafe symlink target at ${relPath}: absolute targets are not applied`);
  }
  const resolved = pathe.normalize(pathe.join(pathe.dirname(pathe.join(repoRoot, relPath)), target));
  const rootPrefix = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  if (resolved !== repoRoot && !resolved.startsWith(rootPrefix)) {
    throw new Error(`unsafe symlink target at ${relPath}: escapes the repository`);
  }
}

async function guardedRollback(
  services: SubagentWorktreeServices,
  repoRoot: string,
  delta: Delta,
): Promise<void> {
  await assertSafeAncestors(services, repoRoot, delta.relPath);
  const current = await capturePath(services, pathe.join(repoRoot, delta.relPath));
  if (!snapshotsEqual(current, delta.after)) {
    throw new Error('refusing to overwrite an entry changed after this transaction');
  }
  await materializeState(services, repoRoot, delta.relPath, delta.before, undefined);
  const restored = await capturePath(services, pathe.join(repoRoot, delta.relPath));
  if (!snapshotsEqual(restored, delta.before)) throw new Error('rollback postcondition failed');
}

async function preserveRecovery(
  services: SubagentWorktreeServices,
  ctx: WorktreeContext,
  reason: string,
): Promise<RecoveryResult> {
  const errors: string[] = [];
  let deltas: Delta[] = [];
  try {
    deltas = await collectDeltas(services, ctx);
  } catch (error) {
    errors.push(`delta snapshot: ${errorMessage(error)}`);
    const fallback = await snapshotPaths(services, ctx.worktreeRoot, [...ctx.candidates]);
    for (const relPath of [...ctx.candidates].sort()) {
      const before = ctx.baseline.get(relPath)!;
      const after = fallback.get(relPath)!;
      if (!snapshotsEqual(before, after)) deltas.push({ relPath, before, after });
    }
  }

  await services.fs.mkdir(ctx.recoveryDir, { recursive: true });
  for (const delta of deltas) {
    await writeRecoveryPayload(services, ctx.recoveryDir, 'baseline', delta.relPath, delta.before, errors);
    await writeRecoveryPayload(services, ctx.recoveryDir, 'worker-final', delta.relPath, delta.after, errors);
    if (delta.before.state.kind === 'unreadable') errors.push(`baseline ${delta.relPath}: ${delta.before.state.error}`);
    if (delta.after.state.kind === 'unreadable') errors.push(`worker-final ${delta.relPath}: ${delta.after.state.error}`);
  }
  const complete = errors.length === 0;
  const manifest = {
    version: 2,
    reason,
    headCommit: ctx.headCommit,
    scope: ctx.scope,
    savedAt: new Date().toISOString(),
    complete,
    retainedWorktree: !complete,
    worktreeRoot: ctx.worktreeRoot,
    capabilities: ctx.capabilities,
    errors,
    deltaPaths: deltas.map((delta) => delta.relPath),
    deletedPaths: deltas.filter((delta) => delta.after.state.kind === 'absent').map((delta) => delta.relPath),
    deltas: deltas.map((delta) => ({
      path: delta.relPath,
      baseline: delta.before.state,
      workerFinal: delta.after.state,
    })),
  };
  await services.fs.writeText(pathe.join(ctx.recoveryDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { path: ctx.recoveryDir, complete };
}

async function writeRecoveryPayload(
  services: SubagentWorktreeServices,
  recoveryDir: string,
  side: 'baseline' | 'worker-final',
  relPath: string,
  snapshot: PathSnapshot,
  errors: string[],
): Promise<void> {
  if (snapshot.state.kind !== 'regular') return;
  if (snapshot.payload === undefined) {
    errors.push(`missing ${side} payload for ${relPath}`);
    return;
  }
  try {
    const destination = pathe.join(recoveryDir, side, relPath);
    await services.fs.mkdir(pathe.dirname(destination), { recursive: true });
    await services.fs.writeBytes(destination, snapshot.payload);
  } catch (error) {
    errors.push(`failed to save ${side} payload for ${relPath}: ${errorMessage(error)}`);
  }
}

async function materializeState(
  services: SubagentWorktreeServices,
  root: string,
  relPath: string,
  snapshot: PathSnapshot,
  stagedRegularPath: string | undefined,
): Promise<void> {
  await ensureSafeParentDirectories(services, root, relPath);
  if (snapshot.state.kind === 'unreadable' || snapshot.state.kind === 'special') {
    throw new Error(`cannot safely materialize ${snapshot.state.kind} state at ${relPath}`);
  }
  const destination = pathe.join(root, relPath);
  const current = await capturePath(services, destination);
  if (snapshotsEqual(current, snapshot)) return;
  if (snapshot.state.kind === 'absent') {
    if (current.state.kind !== 'absent') await removeEntry(services, destination, current.state);
    return;
  }
  if (snapshot.state.kind === 'directory') {
    if (current.state.kind !== 'absent') await removeEntry(services, destination, current.state);
    await runCommand(services, ['mkdir', '--', destination]);
    await runCommand(services, ['chmod', '--', modeArgument(snapshot.state.mode), destination]);
    return;
  }
  if (current.state.kind !== 'absent') await removeEntry(services, destination, current.state);
  if (snapshot.state.kind === 'regular') {
    const source = stagedRegularPath;
    if (source === undefined) {
      if (snapshot.payload === undefined) throw new Error(`missing payload for ${relPath}`);
      const temporary = pathe.join(pathe.dirname(destination), `.${pathe.basename(destination)}.kimi-${randomId()}`);
      await services.fs.writeBytes(temporary, snapshot.payload);
      await runCommand(services, ['chmod', '--', modeArgument(snapshot.state.mode), temporary]);
      const published = await runCommand(services, ['ln', '--', temporary, destination], false);
      await runCommand(services, ['rm', '-f', '--', temporary]);
      if (!published.ok) throw new Error(`unable to publish ${relPath}: ${published.stderr}`);
      return;
    }
    const published = await runCommand(services, ['ln', '--', source, destination], false);
    if (!published.ok) throw new Error(`unable to publish ${relPath}: ${published.stderr}`);
    return;
  }
  const linked = await runCommand(services, ['ln', '-s', '--', snapshot.state.target, destination], false);
  if (!linked.ok) throw new Error(`unable to create symlink ${relPath}: ${linked.stderr}`);
  await runCommand(services, ['chmod', '-h', '--', modeArgument(snapshot.state.mode), destination], false);
}

async function removeEntry(services: SubagentWorktreeServices, path: string, state: PathState): Promise<void> {
  if (state.kind === 'directory') {
    await runCommand(services, ['rmdir', '--', path], false).then(async (result) => {
      if (!result.ok) await runCommand(services, ['rm', '-rf', '--', path]);
    });
    return;
  }
  await runCommand(services, ['rm', '-f', '--', path]);
}

async function snapshotPaths(
  services: SubagentWorktreeServices,
  root: string,
  paths: readonly string[],
): Promise<Map<string, PathSnapshot>> {
  const snapshots = new Map<string, PathSnapshot>();
  for (const relPath of paths) snapshots.set(relPath, await capturePath(services, pathe.join(root, relPath)));
  return snapshots;
}

/**
 * Reconstructs the `before` state of a clean tracked path from its HEAD blob.
 * Used at finish time for paths the worker changed but that were clean at
 * acquire time (and therefore never snapshotted into the baseline). Returns
 * `absent` for paths unknown to HEAD, `unreadable` for anything unsupported
 * (e.g. submodule gitlinks) so callers fail closed.
 */
async function captureHeadPath(
  services: SubagentWorktreeServices,
  cwd: string,
  relPath: string,
): Promise<PathSnapshot> {
  const entry: GitHeadEntry = await services.git.headEntry(cwd, relPath);
  if (entry.kind === 'unreadable') return { state: { kind: 'unreadable', error: entry.error } };
  if (entry.kind === 'absent') return { state: { kind: 'absent' } };
  if (entry.kind === 'symlink') {
    return { state: { kind: 'symlink', mode: 0o120777, target: entry.target } };
  }
  return { state: { kind: 'regular', mode: entry.mode, sha256: digest(entry.blob) }, payload: entry.blob };
}

async function capturePath(services: SubagentWorktreeServices, path: string): Promise<PathSnapshot> {
  let stat: HostFileStat;
  try {
    stat = await services.fs.lstat(path);
  } catch (error) {
    if (isMissing(error)) return { state: { kind: 'absent' } };
    return { state: { kind: 'unreadable', error: errorMessage(error) } };
  }
  if (stat.isSymbolicLink === true) {
    const link = await runCommand(services, ['readlink', '--', path], false);
    if (!link.ok) return { state: { kind: 'unreadable', error: `readlink: ${link.stderr || 'failed'}` } };
    return { state: { kind: 'symlink', mode: 0o120777, target: link.stdout.replace(/\n$/, '') } };
  }
  if (stat.isDirectory) return { state: { kind: 'directory', mode: await captureMode(services, path) } };
  if (!stat.isFile) return { state: { kind: 'special', mode: 0 } };
  const mode = await captureMode(services, path);
  try {
    const payload = await services.fs.readBytes(path);
    return { state: { kind: 'regular', mode, sha256: digest(payload) }, payload };
  } catch (error) {
    return { state: { kind: 'unreadable', error: errorMessage(error) } };
  }
}

async function captureMode(services: SubagentWorktreeServices, path: string): Promise<number> {
  const res = await runCommand(services, ['stat', '-c', '%f', '--', path], false);
  if (!res.ok) return 0o100644;
  const parsed = parseInt(res.stdout.trim(), 16);
  return Number.isNaN(parsed) ? 0o100644 : parsed;
}

function assertReadableSnapshots(snapshots: ReadonlyMap<string, PathSnapshot>): void {
  for (const [path, snapshot] of snapshots) {
    if (snapshot.state.kind === 'unreadable' || snapshot.state.kind === 'special') {
      throw new Error(`unsafe source state at ${path}: ${snapshot.state.kind}`);
    }
  }
}

async function acquisitionCandidates(
  services: SubagentWorktreeServices,
  repoRoot: string,
): Promise<string[]> {
  const [changed, untracked] = await Promise.all([
    services.git.diffChangedPaths(repoRoot),
    listSafeUntracked(services, repoRoot),
  ]);
  return canonicalizePathSet([...changed, ...untracked]);
}

function canonicalizePathSet(rawPaths: readonly string[]): string[] {
  const byCanonical = new Map<string, string>();
  for (const rawPath of rawPaths) {
    const canonical = canonicalRelativePath(rawPath);
    const previous = byCanonical.get(canonical);
    if (previous !== undefined && previous !== rawPath) {
      throw new Error(`canonical path collision: ${previous} and ${rawPath}`);
    }
    byCanonical.set(canonical, rawPath);
  }
  const paths = [...byCanonical.keys()].sort();
  for (let index = 1; index < paths.length; index += 1) {
    if (paths[index]!.startsWith(`${paths[index - 1]!}/`)) {
      throw new Error(`path and child path cannot both be materialized: ${paths[index - 1]} and ${paths[index]}`);
    }
  }
  return paths;
}

function canonicalRelativePath(rawPath: string): string {
  if (rawPath.includes('\0') || pathe.isAbsolute(rawPath)) throw new Error(`unsafe absolute path: ${rawPath}`);
  const normalized = normalizePath(rawPath).replaceAll('\\', '/');
  if (!isCanonicalRelativePath(normalized) || normalized === '.git' || normalized.startsWith('.git/')) {
    throw new Error(`unsafe repository-relative path: ${rawPath}`);
  }
  return normalized;
}

function isCanonicalRelativePath(path: string): boolean {
  return path.length > 0 && path !== '.' && !path.startsWith('/') && !path.startsWith('../') && path !== '..' &&
    !path.split('/').some((part) => part.length === 0 || part === '.' || part === '..');
}

async function assertSafePathSet(
  services: SubagentWorktreeServices,
  root: string,
  paths: readonly string[],
): Promise<void> {
  const canonical = canonicalizePathSet(paths);
  for (const relPath of canonical) await assertSafeAncestors(services, root, relPath);
}

async function assertSafeAncestors(
  services: SubagentWorktreeServices,
  root: string,
  relPath: string,
): Promise<void> {
  const canonical = canonicalRelativePath(relPath);
  let cursor = root;
  const parts = canonical.split('/');
  for (const part of parts.slice(0, -1)) {
    cursor = pathe.join(cursor, part);
    const snapshot = await capturePath(services, cursor);
    if (snapshot.state.kind !== 'directory') {
      throw new Error(`unsafe non-directory ancestor for ${canonical}: ${part} is ${snapshot.state.kind}`);
    }
  }
}

async function assertSafeExistingAncestors(
  services: SubagentWorktreeServices,
  root: string,
  relPath: string,
): Promise<void> {
  const canonical = canonicalRelativePath(relPath);
  let cursor = root;
  for (const part of canonical.split('/').slice(0, -1)) {
    cursor = pathe.join(cursor, part);
    const snapshot = await capturePath(services, cursor);
    if (snapshot.state.kind === 'absent') return;
    if (snapshot.state.kind !== 'directory') {
      throw new Error(`unsafe non-directory ancestor for ${canonical}: ${part} is ${snapshot.state.kind}`);
    }
  }
}

async function ensureSafeParentDirectories(
  services: SubagentWorktreeServices,
  root: string,
  relPath: string,
): Promise<void> {
  const canonical = canonicalRelativePath(relPath);
  let cursor = root;
  for (const part of canonical.split('/').slice(0, -1)) {
    cursor = pathe.join(cursor, part);
    const snapshot = await capturePath(services, cursor);
    if (snapshot.state.kind === 'absent') {
      await runCommand(services, ['mkdir', '--', cursor]);
      continue;
    }
    if (snapshot.state.kind !== 'directory') {
      throw new Error(`unsafe non-directory ancestor for ${canonical}: ${part} is ${snapshot.state.kind}`);
    }
  }
}

async function withRepoApplyLock<T>(
  services: SubagentWorktreeServices,
  commonDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = repoApplyQueues.get(commonDir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => current);
  repoApplyQueues.set(commonDir, queued);
  await previous.catch(() => {});
  try {
    return await withFilesystemLock(services, commonDir, action);
  } finally {
    release();
    if (repoApplyQueues.get(commonDir) === queued) repoApplyQueues.delete(commonDir);
  }
}

async function withFilesystemLock<T>(
  services: SubagentWorktreeServices,
  commonDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockDir = pathe.join(commonDir, 'kimi-code-subagent-apply.lock');
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
  while (true) {
    const created = await runCommand(services, ['mkdir', '--', lockDir], false);
    if (created.ok) break;
    if (Date.now() >= deadline) throw new Error(`filesystem repository lock is held at ${lockDir}`);
    await delay(25);
  }
  try {
    await services.fs.writeText(pathe.join(lockDir, 'owner.json'), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    return await action();
  } finally {
    await runCommand(services, ['rm', '-f', '--', pathe.join(lockDir, 'owner.json')], false);
    await runCommand(services, ['rmdir', '--', lockDir], false);
  }
}

function getCapabilities(): Capabilities {
  const posix = process.platform !== 'win32';
  return { posix, stateMaterialization: posix, symlink: posix };
}

async function resolveIsolationRoot(
  services: SubagentWorktreeServices,
  initialRepoRoot: string,
  rawScope: readonly string[] | undefined,
): Promise<IsolationRootResolution | null> {
  const scope = normalizeScope(rawScope);
  const nestedRepos = await findNestedRepos(services, initialRepoRoot);
  if (scope.length === 0) {
    if (nestedRepos.length === 1 && (await services.git.trackedPaths(initialRepoRoot)).length === 0) {
      return { repoRoot: nestedRepos[0]!, scope: ['**/*'] };
    }
    return { repoRoot: initialRepoRoot, scope };
  }
  const nestedCandidates = new Set<string>();
  for (const nestedRoot of nestedRepos) {
    const prefix = normalizePath(pathe.relative(initialRepoRoot, nestedRoot));
    if (scope.some((entry) => scopeTouchesNestedRoot(entry, prefix))) nestedCandidates.add(nestedRoot);
  }
  if (nestedCandidates.size === 0) return { repoRoot: initialRepoRoot, scope };
  if (nestedCandidates.size !== 1) return null;
  const repoRoot = [...nestedCandidates][0]!;
  const prefix = normalizePath(pathe.relative(initialRepoRoot, repoRoot));
  const translatedScope = scope
    .filter((entry) => entry === prefix || entry.startsWith(`${prefix}/`))
    .map((entry) => entry === prefix ? '**/*' : entry.slice(prefix.length + 1));
  return translatedScope.length === 0 ? null : { repoRoot, scope: translatedScope };
}

async function findNestedRepos(
  services: SubagentWorktreeServices,
  outerRoot: string,
): Promise<string[]> {
  let entries: readonly HostDirEntry[];
  try {
    entries = await services.fs.readdir(outerRoot);
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const entry of entries) {
    const path = pathe.join(outerRoot, entry.name);
    const stat = await capturePath(services, path);
    if (stat.state.kind !== 'directory') continue;
    const nested = await services.git.repoInfo(path);
    if (nested === null || nested.repoRoot === outerRoot) continue;
    const relative = normalizePath(pathe.relative(outerRoot, nested.repoRoot));
    if (isCanonicalRelativePath(relative)) candidates.push(nested.repoRoot);
  }
  return [...new Set(candidates)];
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function normalizeScope(scope: readonly string[] | undefined): readonly string[] {
  return scope === undefined ? [] : scope.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function scopeTouchesNestedRoot(scope: string, prefix: string): boolean {
  const normalized = normalizePath(scope);
  return normalized === prefix || normalized.startsWith(`${prefix}/`) ||
    (normalized.includes('*') && normalized.slice(0, normalized.search(/[?*[\]{}]/)).replace(/\/$/, '') === prefix);
}

function isPathInScope(relPath: string, scope: readonly string[]): boolean {
  return scope.some((entry) => relPath === entry || relPath.startsWith(`${entry}/`) ||
    pathGlobMatch(relPath, entry) || pathGlobMatch(relPath, `${entry}/**`));
}

function isSecretPath(relPath: string): boolean {
  return relPath === '.git' || relPath.startsWith('.git/') ||
    SECRET_PATH_PATTERNS.some((pattern) => pathGlobMatch(relPath, pattern));
}

async function listSafeUntracked(
  services: SubagentWorktreeServices,
  cwd: string,
): Promise<string[]> {
  const paths: string[] = [];
  for (const relPath of await services.git.untrackedPaths(cwd)) {
    if (relPath.length === 0 || isSecretPath(relPath)) continue;
    const state = await capturePath(services, pathe.join(cwd, relPath));
    if (state.state.kind === 'regular' || state.state.kind === 'symlink') paths.push(relPath);
  }
  return paths;
}

async function removeWorktree(
  services: SubagentWorktreeServices,
  repoRoot: string,
  worktreeRoot: string,
): Promise<void> {
  await services.git.removeWorktree(repoRoot, worktreeRoot);
}

async function removeTree(services: SubagentWorktreeServices, path: string): Promise<void> {
  await runCommand(services, ['rm', '-rf', '--', path]);
}

async function runCommand(
  services: SubagentWorktreeServices,
  args: readonly string[],
  throwOnFailure = true,
): Promise<CommandResult> {
  let proc: IHostProcess;
  try {
    proc = await services.proc.spawn(args[0]!, args.slice(1));
  } catch (error) {
    const result = { ok: false, exitCode: null, stdout: '', stderr: errorMessage(error) };
    if (throwOnFailure) throw new Error(`${args[0]} failed: ${result.stderr}`);
    return result;
  }
  const bytesResult = await collectProcess(proc, args.join(' '));
  const result: CommandResult = { ...bytesResult, stdout: bytesResult.stdout.toString('utf8') };
  if (!result.ok && throwOnFailure) throw new Error(`${args[0]} failed: ${result.stderr}`);
  return result;
}

async function collectProcess(proc: IHostProcess, description: string): Promise<CommandBytesResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.all([collectStream(proc.stdout), collectStream(proc.stderr), proc.wait()]);
  work.catch(() => {});
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} timed out`)), GIT_TIMEOUT_MS);
    });
    const [stdout, stderr, exitCode] = await Promise.race([work, timeout]);
    return { ok: exitCode === 0, exitCode, stdout, stderr: stderr.toString('utf8') };
  } catch (error) {
    try { await proc.kill('SIGKILL'); } catch { /* process is already gone */ }
    await work.catch(() => {});
    return { ok: false, exitCode: null, stdout: Buffer.alloc(0), stderr: errorMessage(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    proc.dispose();
  }
}

async function collectStream(stream: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function modeArgument(mode: number): string {
  return (mode & 0o7777).toString(8);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'os.fs.not_found';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshotsEqual(left: PathSnapshot, right: PathSnapshot): boolean {
  return stateEqual(left.state, right.state);
}

function stateEqual(left: PathState, right: PathState): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'regular':
      return left.sha256 === (right as typeof left).sha256 &&
        (left.mode & 0o170000) === ((right as typeof left).mode & 0o170000) &&
        (left.mode & 0o100) === ((right as typeof left).mode & 0o100);
    case 'symlink':
      return left.target === (right as typeof left).target;
    case 'absent':
    case 'special':
      return true;
    case 'directory':
      return left.mode === (right as typeof left).mode;
    case 'unreadable':
      return left.error === (right as typeof left).error;
  }
}

function snapshotMapsEqual(
  left: ReadonlyMap<string, PathSnapshot>,
  right: ReadonlyMap<string, PathSnapshot>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [path, snapshot] of left) {
    const other = right.get(path);
    if (other === undefined || !snapshotsEqual(snapshot, other)) return false;
  }
  return true;
}

function logWarn(services: SubagentWorktreeServices, message: string, data: Record<string, unknown>): void {
  services.log.warn(message, data);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
