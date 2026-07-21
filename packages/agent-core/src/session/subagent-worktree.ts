import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import * as pathe from 'pathe';

import { log } from '../logging/logger';
import { pathGlobMatch } from '../tools/support/path-glob-match';

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
  readonly payload?: Buffer;
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

let testApplyFailureAt: number | undefined;

/** Test-only failure injection. It is deliberately not wired to user configuration. */
export const __testing = {
  failApplyAt(operation: number | undefined): void {
    testApplyFailureAt = operation;
  },
};

export async function acquireSubagentWorktree(
  kaos: Kaos,
  repoCwd: string,
  options: SubagentWorktreeOptions = {},
): Promise<SubagentWorktreeHandle | null> {
  const capabilities = getCapabilities(kaos);
  if (!capabilities.stateMaterialization) return null;

  const initialRepoRoot = await gitStdout(kaos, repoCwd, ['rev-parse', '--show-toplevel']);
  if (initialRepoRoot === null) return null;
  const rootResolution = await resolveIsolationRoot(kaos, initialRepoRoot, options.scope);
  if (rootResolution === null) return null;
  const repoRoot = rootResolution.repoRoot;
  const effectiveCwd = repoRoot === initialRepoRoot ? repoCwd : repoRoot;
  const headCommit = await gitStdout(kaos, effectiveCwd, ['rev-parse', 'HEAD']);
  if (headCommit === null) return null;

  const commonDirRaw = await gitStdout(kaos, effectiveCwd, ['rev-parse', '--git-common-dir']);
  const commonDir = commonDirRaw === null
    ? pathe.join(repoRoot, '.git')
    : pathe.isAbsolute(commonDirRaw) ? commonDirRaw : pathe.resolve(effectiveCwd, commonDirRaw);
  const id = randomId();
  const worktreeRoot = pathe.join(commonDir, 'kimi-code-subagent-worktrees', id);
  const recoveryDir = pathe.join(commonDir, 'kimi-code-subagent-recovery', id);

  let candidates: string[];
  let baseline: Map<string, PathSnapshot>;
  try {
    candidates = await acquisitionCandidates(kaos, repoRoot);
    await assertSafePathSet(kaos, repoRoot, candidates);
    baseline = await snapshotPaths(kaos, repoRoot, candidates);
    assertReadableSnapshots(baseline);
  } catch (error) {
    log.warn('subagent worktree: unable to capture a safe source baseline', {
      repoRoot,
      error: errorMessage(error),
    });
    return null;
  }

  await kaos.mkdir(pathe.dirname(worktreeRoot), { parents: true, existOk: true });
  const added = await execGit(kaos, repoRoot, ['worktree', 'add', '--detach', worktreeRoot, headCommit]);
  if (!added.ok) {
    log.warn('subagent worktree: git worktree add failed', { repoRoot, stderr: added.stderr });
    return null;
  }

  try {
    for (const relPath of candidates) {
      await materializeState(kaos, worktreeRoot, relPath, baseline.get(relPath)!, undefined);
    }
    await assertSafePathSet(kaos, worktreeRoot, candidates);
    const seeded = await snapshotPaths(kaos, worktreeRoot, candidates);
    if (!snapshotMapsEqual(baseline, seeded)) throw new Error('seeded filesystem state differs from source baseline');
  } catch (error) {
    await removeWorktree(kaos, repoRoot, worktreeRoot);
    log.warn('subagent worktree: failed to seed isolated filesystem baseline', {
      repoRoot,
      error: errorMessage(error),
    });
    return null;
  }

  const relativeCwd = normalizePath(pathe.relative(repoRoot, repoCwd));
  const childCwd = isCanonicalRelativePath(relativeCwd) ? pathe.join(worktreeRoot, relativeCwd) : worktreeRoot;
  try {
    if (isCanonicalRelativePath(relativeCwd)) await assertSafeAncestors(kaos, worktreeRoot, relativeCwd);
    await kaos.mkdir(childCwd, { parents: true, existOk: true });
  } catch {
    await removeWorktree(kaos, repoRoot, worktreeRoot);
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
  if (outcome.kind === 'discard') {
    await removeWorktree(kaos, ctx.repoRoot, ctx.worktreeRoot);
    return {
      applied: false,
      reason: outcome.reason ?? 'discarded',
    };
  }
  if (outcome.kind === 'incomplete') {
    return finishWithRecovery(kaos, ctx, outcome.reason ?? 'incomplete');
  }

  let deltas: Delta[];
  try {
    deltas = await collectDeltas(kaos, ctx);
  } catch (error) {
    return finishWithRecovery(kaos, ctx, `snapshot-failed: ${errorMessage(error)}`);
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
      acknowledgePersisted: () => removeWorktree(kaos, ctx.repoRoot, ctx.worktreeRoot),
    };
  }

  if (deltas.length === 0) {
    await removeWorktree(kaos, ctx.repoRoot, ctx.worktreeRoot);
    return { applied: true };
  }

  try {
    await withRepoApplyLock(kaos, ctx.commonDir, async () => {
      await assertCandidateBaseline(kaos, ctx.repoRoot, ctx.capabilities, deltas, 'worker delta path(s) diverged');
      await applyDeltaPlan(kaos, ctx.repoRoot, deltas);
    });
  } catch (error) {
    const reason = `apply-failed: ${errorMessage(error)}`;
    const recovery = await preserveRecovery(kaos, ctx, reason).catch((recoveryError) => ({
      path: undefined,
      complete: false,
      error: errorMessage(recoveryError),
    }));
    if (recovery.complete) await removeWorktree(kaos, ctx.repoRoot, ctx.worktreeRoot);
    throw new Error(
      `Failed to apply editing subagent changes to the workspace: ${errorMessage(error)}` +
      (recovery.path === undefined ? '' : ` (recovery data preserved at ${recovery.path})`),
    );
  }

  await removeWorktree(kaos, ctx.repoRoot, ctx.worktreeRoot);
  return { applied: true };
}

async function finishWithRecovery(
  kaos: Kaos,
  ctx: WorktreeContext,
  reason: string,
): Promise<SubagentWorktreeFinishResult> {
  const recovery = await preserveRecovery(kaos, ctx, reason).catch((error) => {
    log.warn('subagent worktree: failed to preserve recovery data', { worktreeRoot: ctx.worktreeRoot, error: errorMessage(error) });
    return undefined;
  });
  if (recovery?.complete) await removeWorktree(kaos, ctx.repoRoot, ctx.worktreeRoot);
  return {
    applied: false,
    reason,
    recoveryPath: recovery?.path,
  };
}

async function collectDeltas(kaos: Kaos, ctx: WorktreeContext): Promise<Delta[]> {
  const workerUntracked = await listSafeUntracked(kaos, ctx.worktreeRoot);
  const candidateInputs = [...ctx.candidates, ...workerUntracked];
  const candidates = canonicalizePathSet(candidateInputs);
  await assertSafePathSet(kaos, ctx.worktreeRoot, candidates);
  const workerFinal = await snapshotPaths(kaos, ctx.worktreeRoot, candidates);
  const deltas: Delta[] = [];
  for (const relPath of candidates) {
    const before = ctx.baseline.get(relPath) ?? { state: { kind: 'absent' } };
    const after = workerFinal.get(relPath)!;
    if (!snapshotsEqual(before, after)) deltas.push({ relPath, before, after });
  }
  return deltas.sort((left, right) => left.relPath.localeCompare(right.relPath));
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
  kaos: Kaos,
  repoRoot: string,
  capabilities: Capabilities,
  deltas: readonly Delta[],
  reason: string,
): Promise<void> {
  if (!capabilities.stateMaterialization) throw new Error('backend does not support safe POSIX state materialization');
  for (const delta of deltas) {
    await assertSafeExistingAncestors(kaos, repoRoot, delta.relPath);
  }
  for (const delta of deltas) {
    const current = await capturePath(kaos, pathe.join(repoRoot, delta.relPath));
    if (!snapshotsEqual(current, delta.before)) throw new Error(`${reason}: ${delta.relPath}`);
  }
}

export async function applySubagentWorktreeCandidate(
  kaos: Kaos,
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
  const capabilities = getCapabilities(kaos);
  const deltas: Delta[] = candidate.paths.map(({ relPath, before, after }) => ({ relPath, before, after }));
  await withRepoApplyLock(kaos, candidate.commonDir, async () => {
    await assertCandidateBaseline(kaos, candidate.repoRoot, capabilities, deltas, 'candidate_path_diverged');
    await applyDeltaPlan(kaos, candidate.repoRoot, deltas);
  });
  return { applied: true };
}

async function applyDeltaPlan(kaos: Kaos, repoRoot: string, deltas: readonly Delta[]): Promise<void> {
  const stageRoot = pathe.join(repoRoot, `.kimi-code-subagent-apply-${randomId()}`);
  const staged = new Map<string, string>();
  await kaos.mkdir(stageRoot, { parents: false, existOk: false });
  try {
    for (const delta of deltas) {
      if (delta.after.state.kind !== 'regular') continue;
      if (delta.after.payload === undefined) throw new Error(`missing worker payload for ${delta.relPath}`);
      const stagedPath = pathe.join(stageRoot, 'after', delta.relPath);
      await kaos.mkdir(pathe.dirname(stagedPath), { parents: true, existOk: true });
      await kaos.writeBytes(stagedPath, delta.after.payload);
      await runCommand(kaos, ['chmod', '--', modeArgument(delta.after.state.mode), stagedPath]);
      staged.set(delta.relPath, stagedPath);
    }
    await kaos.writeText(pathe.join(stageRoot, 'journal.json'), `${JSON.stringify({
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
        await assertSafeExistingAncestors(kaos, repoRoot, delta.relPath);
        const current = await capturePath(kaos, pathe.join(repoRoot, delta.relPath));
        if (!snapshotsEqual(current, delta.before)) throw new Error(`worker delta path(s) diverged: ${delta.relPath}`);
        await materializeState(kaos, repoRoot, delta.relPath, delta.after, staged.get(delta.relPath));
        const final = await capturePath(kaos, pathe.join(repoRoot, delta.relPath));
        if (!snapshotsEqual(final, delta.after)) throw new Error(`postcondition failed for ${delta.relPath}`);
        completed.push(delta);
      }
      for (const delta of deltas) {
        const final = await capturePath(kaos, pathe.join(repoRoot, delta.relPath));
        if (!snapshotsEqual(final, delta.after)) throw new Error(`postcondition failed for ${delta.relPath}`);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const delta of completed.reverse()) {
        try {
          await guardedRollback(kaos, repoRoot, delta);
        } catch (rollbackError) {
          rollbackErrors.push(`${delta.relPath}: ${errorMessage(rollbackError)}`);
        }
      }
      if (rollbackErrors.length > 0) throw new Error(`${errorMessage(error)}; guarded rollback incomplete: ${rollbackErrors.join('; ')}`);
      throw error;
    }
  } finally {
    await removeTree(kaos, stageRoot).catch(() => {});
  }
}

async function guardedRollback(kaos: Kaos, repoRoot: string, delta: Delta): Promise<void> {
  await assertSafeAncestors(kaos, repoRoot, delta.relPath);
  const current = await capturePath(kaos, pathe.join(repoRoot, delta.relPath));
  if (!snapshotsEqual(current, delta.after)) {
    throw new Error('refusing to overwrite an entry changed after this transaction');
  }
  await materializeState(kaos, repoRoot, delta.relPath, delta.before, undefined);
  const restored = await capturePath(kaos, pathe.join(repoRoot, delta.relPath));
  if (!snapshotsEqual(restored, delta.before)) throw new Error('rollback postcondition failed');
}

async function preserveRecovery(kaos: Kaos, ctx: WorktreeContext, reason: string): Promise<RecoveryResult> {
  const errors: string[] = [];
  let deltas: Delta[] = [];
  try {
    deltas = await collectDeltas(kaos, ctx);
  } catch (error) {
    errors.push(`delta snapshot: ${errorMessage(error)}`);
    const fallback = await snapshotPaths(kaos, ctx.worktreeRoot, [...ctx.candidates]);
    for (const relPath of [...ctx.candidates].sort()) {
      const before = ctx.baseline.get(relPath)!;
      const after = fallback.get(relPath)!;
      if (!snapshotsEqual(before, after)) deltas.push({ relPath, before, after });
    }
  }

  await kaos.mkdir(ctx.recoveryDir, { parents: true, existOk: true });
  for (const delta of deltas) {
    await writeRecoveryPayload(kaos, ctx.recoveryDir, 'baseline', delta.relPath, delta.before, errors);
    await writeRecoveryPayload(kaos, ctx.recoveryDir, 'worker-final', delta.relPath, delta.after, errors);
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
  await kaos.writeText(pathe.join(ctx.recoveryDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { path: ctx.recoveryDir, complete };
}

async function writeRecoveryPayload(
  kaos: Kaos,
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
    await kaos.mkdir(pathe.dirname(destination), { parents: true, existOk: true });
    await kaos.writeBytes(destination, snapshot.payload);
  } catch (error) {
    errors.push(`failed to save ${side} payload for ${relPath}: ${errorMessage(error)}`);
  }
}

async function materializeState(
  kaos: Kaos,
  root: string,
  relPath: string,
  snapshot: PathSnapshot,
  stagedRegularPath: string | undefined,
): Promise<void> {
  await ensureSafeParentDirectories(kaos, root, relPath);
  if (snapshot.state.kind === 'unreadable' || snapshot.state.kind === 'special') {
    throw new Error(`cannot safely materialize ${snapshot.state.kind} state at ${relPath}`);
  }
  const destination = pathe.join(root, relPath);
  const current = await capturePath(kaos, destination);
  if (snapshotsEqual(current, snapshot)) return;
  if (snapshot.state.kind === 'absent') {
    if (current.state.kind !== 'absent') await removeEntry(kaos, destination, current.state);
    return;
  }
  if (snapshot.state.kind === 'directory') {
    if (current.state.kind !== 'absent') await removeEntry(kaos, destination, current.state);
    await runCommand(kaos, ['mkdir', '--', destination]);
    await runCommand(kaos, ['chmod', '--', modeArgument(snapshot.state.mode), destination]);
    return;
  }
  if (current.state.kind !== 'absent') await removeEntry(kaos, destination, current.state);
  if (snapshot.state.kind === 'regular') {
    const source = stagedRegularPath;
    if (source === undefined) {
      if (snapshot.payload === undefined) throw new Error(`missing payload for ${relPath}`);
      const temporary = pathe.join(pathe.dirname(destination), `.${pathe.basename(destination)}.kimi-${randomId()}`);
      await kaos.writeBytes(temporary, snapshot.payload);
      await runCommand(kaos, ['chmod', '--', modeArgument(snapshot.state.mode), temporary]);
      const published = await runCommand(kaos, ['ln', '--', temporary, destination], false);
      await runCommand(kaos, ['rm', '-f', '--', temporary]);
      if (!published.ok) throw new Error(`unable to publish ${relPath}: ${published.stderr}`);
      return;
    }
    const published = await runCommand(kaos, ['ln', '--', source, destination], false);
    if (!published.ok) throw new Error(`unable to publish ${relPath}: ${published.stderr}`);
    return;
  }
  const linked = await runCommand(kaos, ['ln', '-s', '--', snapshot.state.target, destination], false);
  if (!linked.ok) throw new Error(`unable to create symlink ${relPath}: ${linked.stderr}`);
  await runCommand(kaos, ['chmod', '-h', '--', modeArgument(snapshot.state.mode), destination], false);
}

async function removeEntry(kaos: Kaos, path: string, state: PathState): Promise<void> {
  if (state.kind === 'directory') {
    await runCommand(kaos, ['rmdir', '--', path], false).then(async (result) => {
      if (!result.ok) await runCommand(kaos, ['rm', '-rf', '--', path]);
    });
    return;
  }
  await runCommand(kaos, ['rm', '-f', '--', path]);
}

async function snapshotPaths(kaos: Kaos, root: string, paths: readonly string[]): Promise<Map<string, PathSnapshot>> {
  const snapshots = new Map<string, PathSnapshot>();
  for (const relPath of paths) snapshots.set(relPath, await capturePath(kaos, pathe.join(root, relPath)));
  return snapshots;
}

async function capturePath(kaos: Kaos, path: string): Promise<PathSnapshot> {
  let stat;
  try {
    stat = await kaos.stat(path, { followSymlinks: false });
  } catch (error) {
    if (isMissing(error)) return { state: { kind: 'absent' } };
    return { state: { kind: 'unreadable', error: errorMessage(error) } };
  }
  const mode = stat.stMode;
  const type = mode & 0o170000;
  if (type === 0o040000) return { state: { kind: 'directory', mode } };
  if (type === 0o120000) {
    const link = await runCommand(kaos, ['readlink', '--', path], false);
    if (!link.ok) return { state: { kind: 'unreadable', error: `readlink: ${link.stderr || 'failed'}` } };
    return { state: { kind: 'symlink', mode, target: link.stdout.replace(/\n$/, '') } };
  }
  if (type !== 0o100000) return { state: { kind: 'special', mode } };
  try {
    const payload = await kaos.readBytes(path);
    const rechecked = await kaos.stat(path, { followSymlinks: false });
    if (rechecked.stMode !== mode || (rechecked.stMode & 0o170000) !== 0o100000) {
      return { state: { kind: 'unreadable', error: 'entry changed while being captured' } };
    }
    return { state: { kind: 'regular', mode, sha256: digest(payload) }, payload };
  } catch (error) {
    return { state: { kind: 'unreadable', error: errorMessage(error) } };
  }
}

function snapshotsEqual(left: PathSnapshot, right: PathSnapshot): boolean {
  return JSON.stringify(left.state) === JSON.stringify(right.state);
}

function snapshotMapsEqual(left: ReadonlyMap<string, PathSnapshot>, right: ReadonlyMap<string, PathSnapshot>): boolean {
  if (left.size !== right.size) return false;
  for (const [path, state] of left) {
    const other = right.get(path);
    if (other === undefined || !snapshotsEqual(state, other)) return false;
  }
  return true;
}

function assertReadableSnapshots(snapshots: ReadonlyMap<string, PathSnapshot>): void {
  for (const [path, snapshot] of snapshots) {
    if (snapshot.state.kind === 'unreadable' || snapshot.state.kind === 'special') {
      throw new Error(`unsafe source state at ${path}: ${snapshot.state.kind}`);
    }
  }
}

async function acquisitionCandidates(kaos: Kaos, repoRoot: string): Promise<string[]> {
  const [tracked, changed, untracked] = await Promise.all([
    listTracked(kaos, repoRoot),
    gitDiffChangedPaths(kaos, repoRoot),
    listSafeUntracked(kaos, repoRoot),
  ]);
  return canonicalizePathSet([...tracked, ...changed, ...untracked]);
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

async function assertSafePathSet(kaos: Kaos, root: string, paths: readonly string[]): Promise<void> {
  const canonical = canonicalizePathSet(paths);
  for (const relPath of canonical) await assertSafeAncestors(kaos, root, relPath);
}

async function assertSafeAncestors(kaos: Kaos, root: string, relPath: string): Promise<void> {
  const canonical = canonicalRelativePath(relPath);
  let cursor = root;
  const parts = canonical.split('/');
  for (const part of parts.slice(0, -1)) {
    cursor = pathe.join(cursor, part);
    const snapshot = await capturePath(kaos, cursor);
    if (snapshot.state.kind !== 'directory') {
      throw new Error(`unsafe non-directory ancestor for ${canonical}: ${part} is ${snapshot.state.kind}`);
    }
  }
}

async function assertSafeExistingAncestors(kaos: Kaos, root: string, relPath: string): Promise<void> {
  const canonical = canonicalRelativePath(relPath);
  let cursor = root;
  for (const part of canonical.split('/').slice(0, -1)) {
    cursor = pathe.join(cursor, part);
    const snapshot = await capturePath(kaos, cursor);
    if (snapshot.state.kind === 'absent') return;
    if (snapshot.state.kind !== 'directory') {
      throw new Error(`unsafe non-directory ancestor for ${canonical}: ${part} is ${snapshot.state.kind}`);
    }
  }
}

async function ensureSafeParentDirectories(kaos: Kaos, root: string, relPath: string): Promise<void> {
  const canonical = canonicalRelativePath(relPath);
  let cursor = root;
  for (const part of canonical.split('/').slice(0, -1)) {
    cursor = pathe.join(cursor, part);
    const snapshot = await capturePath(kaos, cursor);
    if (snapshot.state.kind === 'absent') {
      await runCommand(kaos, ['mkdir', '--', cursor]);
      continue;
    }
    if (snapshot.state.kind !== 'directory') {
      throw new Error(`unsafe non-directory ancestor for ${canonical}: ${part} is ${snapshot.state.kind}`);
    }
  }
}

async function withRepoApplyLock<T>(kaos: Kaos, commonDir: string, action: () => Promise<T>): Promise<T> {
  const previous = repoApplyQueues.get(commonDir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => current);
  repoApplyQueues.set(commonDir, queued);
  await previous.catch(() => {});
  try {
    return await withFilesystemLock(kaos, commonDir, action);
  } finally {
    release();
    if (repoApplyQueues.get(commonDir) === queued) repoApplyQueues.delete(commonDir);
  }
}

async function withFilesystemLock<T>(kaos: Kaos, commonDir: string, action: () => Promise<T>): Promise<T> {
  const lockDir = pathe.join(commonDir, 'kimi-code-subagent-apply.lock');
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
  while (true) {
    const created = await runCommand(kaos, ['mkdir', '--', lockDir], false);
    if (created.ok) break;
    if (Date.now() >= deadline) throw new Error(`filesystem repository lock is held at ${lockDir}`);
    await delay(25);
  }
  try {
    await kaos.writeText(pathe.join(lockDir, 'owner.json'), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    return await action();
  } finally {
    await runCommand(kaos, ['rm', '-f', '--', pathe.join(lockDir, 'owner.json')], false);
    await runCommand(kaos, ['rmdir', '--', lockDir], false);
  }
}

function getCapabilities(kaos: Kaos): Capabilities {
  const posix = kaos.pathClass() === 'posix';
  return { posix, stateMaterialization: posix, symlink: posix };
}

async function resolveIsolationRoot(
  kaos: Kaos,
  initialRepoRoot: string,
  rawScope: readonly string[] | undefined,
): Promise<IsolationRootResolution | null> {
  const scope = normalizeScope(rawScope);
  const nestedRepos = await findNestedRepos(kaos, initialRepoRoot);
  if (scope.length === 0) {
    if (nestedRepos.length === 1 && (await listTracked(kaos, initialRepoRoot)).length === 0) {
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

async function findNestedRepos(kaos: Kaos, outerRoot: string): Promise<string[]> {
  const entries: string[] = [];
  try {
    for await (const entry of kaos.iterdir(outerRoot)) entries.push(entry);
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const entry of entries) {
    const path = pathe.isAbsolute(entry) ? entry : pathe.join(outerRoot, entry);
    const stat = await capturePath(kaos, path);
    if (stat.state.kind !== 'directory') continue;
    const nestedRoot = await gitStdout(kaos, path, ['rev-parse', '--show-toplevel']);
    if (nestedRoot === null || nestedRoot === outerRoot) continue;
    const relative = normalizePath(pathe.relative(outerRoot, nestedRoot));
    if (isCanonicalRelativePath(relative)) candidates.push(nestedRoot);
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

async function listTracked(kaos: Kaos, cwd: string): Promise<string[]> {
  const result = await execGit(kaos, cwd, ['ls-files', '-z']);
  return result.ok ? result.stdout.split('\0').filter(Boolean) : [];
}

async function listSafeUntracked(kaos: Kaos, cwd: string): Promise<string[]> {
  const result = await execGit(kaos, cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!result.ok) return [];
  const paths: string[] = [];
  for (const record of result.stdout.split('\0')) {
    if (!record.startsWith('?? ')) continue;
    const relPath = record.slice(3);
    if (relPath.length === 0 || isSecretPath(relPath)) continue;
    const state = await capturePath(kaos, pathe.join(cwd, relPath));
    if (state.state.kind === 'regular' || state.state.kind === 'symlink') paths.push(relPath);
  }
  return paths;
}

async function gitDiffChangedPaths(kaos: Kaos, cwd: string): Promise<string[]> {
  const result = await execGit(kaos, cwd, ['diff', '--name-status', '-z', 'HEAD']);
  if (!result.ok) return [];
  const tokens = result.stdout.split('\0').filter(Boolean);
  const paths = new Set<string>();
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index++] ?? '';
    const count = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    for (let offset = 0; offset < count && index < tokens.length; offset += 1) {
      const path = tokens[index++];
      if (path !== undefined) paths.add(path);
    }
  }
  return [...paths];
}

async function removeWorktree(kaos: Kaos, repoRoot: string, worktreeRoot: string): Promise<void> {
  const result = await execGit(kaos, repoRoot, ['worktree', 'remove', '--force', worktreeRoot]);
  if (!result.ok) {
    log.warn('subagent worktree: git worktree remove failed, pruning instead', { repoRoot, worktreeRoot, stderr: result.stderr });
    await execGit(kaos, repoRoot, ['worktree', 'prune']);
  }
}

async function removeTree(kaos: Kaos, path: string): Promise<void> {
  await runCommand(kaos, ['rm', '-rf', '--', path]);
}

async function runCommand(kaos: Kaos, args: readonly string[], throwOnFailure = true): Promise<GitExecResult> {
  let proc: KaosProcess;
  try {
    proc = await kaos.exec(...args);
  } catch (error) {
    const result = { ok: false, exitCode: null, stdout: '', stderr: errorMessage(error) };
    if (throwOnFailure) throw new Error(`${args[0]} failed: ${result.stderr}`);
    return result;
  }
  const result = await collectProcess(proc, args.join(' '));
  if (!result.ok && throwOnFailure) throw new Error(`${args[0]} failed: ${result.stderr}`);
  return result;
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

async function execGit(kaos: Kaos, cwd: string, args: readonly string[], stdin?: string): Promise<GitExecResult> {
  let proc: KaosProcess;
  try {
    proc = await kaos.exec('git', '-C', cwd, ...args);
  } catch (error) {
    return { ok: false, exitCode: null, stdout: '', stderr: errorMessage(error) };
  }
  proc.stdin.on('error', () => {});
  try {
    proc.stdin.write(stdin ?? '');
    proc.stdin.end();
  } catch {
    // stdin may already be closed by a short-lived process.
  }
  return collectProcess(proc, `git ${args.join(' ')}`);
}

async function collectProcess(proc: KaosProcess, description: string): Promise<GitExecResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.all([collectStream(proc.stdout), collectStream(proc.stderr), proc.wait()]);
  work.catch(() => {});
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} timed out`)), GIT_TIMEOUT_MS);
    });
    const [stdout, stderr, exitCode] = await Promise.race([work, timeout]);
    return { ok: exitCode === 0, exitCode, stdout, stderr };
  } catch (error) {
    try { await proc.kill('SIGKILL'); } catch { /* process is already gone */ }
    await work.catch(() => {});
    return { ok: false, exitCode: null, stdout: '', stderr: errorMessage(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { await proc.dispose(); } catch { /* best effort */ }
  }
}

async function collectStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString('utf8');
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function modeArgument(mode: number): string {
  return (mode & 0o7777).toString(8);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
