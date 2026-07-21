import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Kaos } from '@moonshot-ai/kaos';

import type {
  AssetArtifactManifest,
  AssetPipelineRun,
  AssetPromotionRecord,
  AssetProvenance,
  AssetReview,
} from './types';

export type AssetPromotionManifest = AssetPromotionRecord;

export interface AssetPromotionRuntime {
  readonly kaos: Kaos;
  readonly cwd: string;
}

export interface AssetPromotionResult {
  readonly manifest: AssetPromotionManifest;
  readonly state: 'promoted' | 'reused-identical';
}

function safeFormalTarget(path: string): string {
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  if (
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    !normalized.startsWith('assets/') ||
    normalized === 'assets/_staging' ||
    normalized.startsWith('assets/_staging/')
  ) {
    throw new Error('Asset promotion target must be a safe formal project path outside staging.');
  }
  return normalized;
}

function latestUserDecision(run: AssetPipelineRun, artifactId: string): AssetReview | undefined {
  for (let index = run.reviews.length - 1; index >= 0; index -= 1) {
    const review = run.reviews[index];
    if (review?.reviewer === 'user' && review.artifactId === artifactId) return review;
  }
  return undefined;
}

function promotionProvenance(
  run: AssetPipelineRun,
  artifact: AssetArtifactManifest,
): readonly AssetProvenance[] {
  const candidate = artifact.candidateId === undefined
    ? undefined
    : run.candidates.find((entry) => entry.id === artifact.candidateId);
  const provenance = [...(candidate?.provenance ?? []), ...(artifact.provenance ?? [])];
  if (provenance.length === 0) {
    throw new Error(`Asset artifact "${artifact.id}" has no promotion provenance.`);
  }
  if (provenance.some((entry) => entry.transferability === 'prohibited' || entry.transferability === 'unknown')) {
    throw new Error(`Asset artifact "${artifact.id}" has non-transferable promotion provenance.`);
  }
  if (provenance.some((entry) => entry.license === undefined || entry.license === null || entry.license.trim().length === 0)) {
    throw new Error(`Asset artifact "${artifact.id}" has promotion provenance without a license record.`);
  }
  return provenance;
}

export async function promoteAssetArtifact(
  run: AssetPipelineRun,
  artifactId: string,
  runtime: AssetPromotionRuntime,
  options: { readonly existingTarget?: 'error' | 'reuse-identical' } = {},
  verifiedAt = new Date().toISOString(),
): Promise<AssetPromotionResult> {
  const artifact = run.artifacts.find((entry) => entry.id === artifactId);
  if (artifact === undefined) throw new Error(`Unknown asset artifact "${artifactId}".`);
  const item = run.bom.find((entry) => entry.id === artifact.bomItemId);
  if (item === undefined) throw new Error(`Asset artifact "${artifactId}" targets an unknown BOM item.`);
  const targetPath = safeFormalTarget(item.targetPath);
  const capability = runtime.kaos.transactionalFiles;
  if (capability === undefined) throw new Error('Asset promotion is unavailable: backend lacks transactional file capability.');
  const source = posix.isAbsolute(artifact.stagingPath) ? artifact.stagingPath : posix.join(runtime.cwd, artifact.stagingPath);
  const target = posix.isAbsolute(targetPath) ? targetPath : posix.join(runtime.cwd, targetPath);
  const sourceStat = await capability.validateComponents(runtime.cwd, source);
  if (sourceStat.leaf?.kind !== 'regular') throw new Error('Asset promotion source must be a regular file.');
  const reader = await capability.openReadNoFollow(source);
  const hash = createHash('sha256');
  try {
    for await (const chunk of reader.chunks()) hash.update(chunk);
  } finally {
    await reader.close();
  }
  const sourceSha256 = hash.digest('hex');
  if (sourceSha256 !== artifact.sha256) throw new Error('Asset promotion source bytes do not match the verified artifact checksum.');
  const targetParent = target.slice(0, target.lastIndexOf('/'));
  await runtime.kaos.mkdir(targetParent, { parents: true, existOk: true });
  const targetState = await capability.validateComponents(runtime.cwd, target, { allowMissingLeaf: true });
  if (targetState.leaf !== null) {
    if (options.existingTarget !== 'reuse-identical' || targetState.leaf.kind !== 'regular') throw new Error('Asset promotion target already exists.');
    const targetReader = await capability.openReadNoFollow(target);
    const targetHash = createHash('sha256');
    try { for await (const chunk of targetReader.chunks()) targetHash.update(chunk); } finally { await targetReader.close(); }
    if (targetHash.digest('hex') !== sourceSha256) throw new Error('Asset promotion target exists with different bytes.');
    return { manifest: createAssetPromotionManifest(run, artifactId, targetPath, sourceSha256, verifiedAt), state: 'reused-identical' };
  }
  const temporary = await capability.createExclusiveNoFollow(`${target}.kimi-tmp-${run.runId}`, { mode: 0o644 });
  try {
    const sourceReader = await capability.openReadNoFollow(source);
    try { for await (const chunk of sourceReader.chunks()) await temporary.write(chunk); } finally { await sourceReader.close(); }
    await temporary.sync();
    await temporary.close();
    await capability.publishNoReplace(temporary, target);
    await capability.syncDirectory(targetParent);
  } catch (error) {
    await temporary.close().catch(() => undefined);
    await capability.unlink(temporary.path).catch(() => undefined);
    throw error;
  }
  return { manifest: createAssetPromotionManifest(run, artifactId, targetPath, sourceSha256, verifiedAt), state: 'promoted' };
}

export function createAssetPromotionManifest(
  run: AssetPipelineRun,
  artifactId: string,
  targetPath: string,
  targetSha256: string,
  verifiedAt = new Date().toISOString(),
): AssetPromotionManifest {
  if (run.state !== 'user_review_pending') {
    throw new Error('Asset promotion manifests require a user-review-pending pipeline run.');
  }
  const artifact = run.artifacts.find((entry) => entry.id === artifactId);
  if (artifact === undefined) throw new Error(`Unknown asset artifact "${artifactId}".`);
  const item = run.bom.find((entry) => entry.id === artifact.bomItemId);
  if (item === undefined) throw new Error(`Asset artifact "${artifactId}" targets an unknown BOM item.`);
  const normalizedTarget = safeFormalTarget(targetPath);
  if (normalizedTarget !== safeFormalTarget(item.targetPath)) {
    throw new Error(`Asset artifact "${artifactId}" may only promote to its confirmed BOM target path.`);
  }
  const userDecision = latestUserDecision(run, artifactId);
  if (userDecision?.decision !== 'promote') {
    throw new Error(`Asset artifact "${artifactId}" lacks an authoritative user promote decision.`);
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error(`Asset artifact "${artifactId}" has an invalid source checksum.`);
  }
  if (!/^[a-f0-9]{64}$/.test(targetSha256)) {
    throw new Error(`Asset artifact "${artifactId}" has an invalid target checksum.`);
  }
  if (targetSha256 !== artifact.sha256) {
    throw new Error(`Asset artifact "${artifactId}" target checksum does not match staged bytes.`);
  }
  const provenance = promotionProvenance(run, artifact);
  return {
    runId: run.runId,
    artifactId: artifact.id,
    bomItemId: artifact.bomItemId,
    fromStagingPath: artifact.stagingPath,
    targetPath: normalizedTarget,
    sourceSha256: artifact.sha256,
    targetSha256,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    provider: artifact.provider,
    model: artifact.model,
    promptRef: artifact.promptRef,
    provenance,
    licenses: [...new Set(provenance.map((entry) => entry.license!))].sort(),
    attributions: [...new Set(provenance.flatMap((entry) => entry.attribution === undefined ? [] : [entry.attribution]))].sort(),
    userDecision,
    verifiedAt,
  };
}
