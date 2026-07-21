import { validateAssetBom } from './bom';
import { isAssetStagingPath, validateBatchConfirmation, validateProviderOperation } from './safety';
import type { AssetPipelineRun, AssetPipelineState, AssetPromotionRecord } from './types';

const TRANSITIONS: Readonly<Record<AssetPipelineState, readonly AssetPipelineState[]>> = {
  bom_draft: ['bom_confirmed', 'cancelled'],
  bom_confirmed: ['candidates_discovered', 'cancelled'],
  candidates_discovered: ['candidates_confirmed', 'cancelled'],
  candidates_confirmed: ['staging_downloaded_or_generated', 'unavailable', 'cancelled'],
  staging_downloaded_or_generated: ['kimi_pre_reviewed', 'unavailable', 'cancelled'],
  kimi_pre_reviewed: ['user_review_pending', 'unavailable', 'cancelled'],
  user_review_pending: ['promoted', 'rejected', 'deferred', 'unavailable', 'cancelled'],
  promoted: [],
  rejected: [],
  deferred: [],
  unavailable: [],
  cancelled: [],
};

export function canTransitionAssetPipeline(from: AssetPipelineState, to: AssetPipelineState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionAssetPipeline(run: AssetPipelineRun, next: AssetPipelineState, now = new Date().toISOString()): AssetPipelineRun {
  if (!canTransitionAssetPipeline(run.state, next)) {
    throw new Error(`Invalid asset pipeline transition: ${run.state} -> ${next}.`);
  }
  if (next === 'bom_confirmed') {
    const validation = validateAssetBom(run.bom);
    if (!validation.complete) {
      throw new Error(`Asset pipeline cannot confirm an incomplete BOM: ${[
        ...validation.missingCategories.map((category) => `missing ${category}`),
        ...validation.issues,
      ].join('; ')}.`);
    }
  }
  if (next === 'candidates_confirmed') {
    if (run.batchConfirmation === undefined) {
      throw new Error('Asset pipeline candidates require explicit user batch confirmation.');
    }
    validateBatchConfirmation(run, run.batchConfirmation);
  }
  if (next === 'staging_downloaded_or_generated') {
    if (run.batchConfirmation === undefined) {
      throw new Error('Asset pipeline cannot stage assets without user batch confirmation.');
    }
    if (run.operations.length === 0 || run.operations.some((operation) => operation.state !== 'completed')) {
      throw new Error('Asset pipeline staging requires completed provider operations.');
    }
    for (const operation of run.operations) validateProviderOperation(run.runId, operation);
    if (run.artifacts.length === 0 || run.artifacts.some((artifact) => !isAssetStagingPath(run.runId, artifact.stagingPath))) {
      throw new Error('Asset pipeline artifacts must exist only under the run staging directory.');
    }
  }
  if (next === 'kimi_pre_reviewed') {
    const reviewed = new Set(run.reviews.filter((review) => review.reviewer === 'kimi').map((review) => review.artifactId));
    if (run.artifacts.some((artifact) => !reviewed.has(artifact.id))) {
      throw new Error('Asset pipeline requires a Kimi pre-review for every staged artifact.');
    }
  }
  if (next === 'promoted') {
    const userReviews = new Map(run.reviews.filter((review) => review.reviewer === 'user').map((review) => [review.artifactId, review]));
    if (run.artifacts.length === 0 || run.artifacts.some((artifact) => userReviews.get(artifact.id)?.decision !== 'promote')) {
      throw new Error('Asset pipeline cannot promote without an explicit user promote decision for every artifact.');
    }
    const promotions = new Map(run.promotions.map((promotion) => [promotion.artifactId, promotion]));
    for (const artifact of run.artifacts) {
      const promotion = promotions.get(artifact.id);
      if (promotion === undefined) {
        throw new Error(`Asset pipeline cannot promote artifact "${artifact.id}" without a verified promotion manifest.`);
      }
      validatePromotionRecord(run, artifact.id, promotion);
    }
  }
  return { ...run, state: next, updatedAt: now };
}

function validatePromotionRecord(
  run: AssetPipelineRun,
  artifactId: string,
  promotion: AssetPromotionRecord,
): void {
  const artifact = run.artifacts.find((entry) => entry.id === artifactId)!;
  const item = run.bom.find((entry) => entry.id === artifact.bomItemId);
  if (
    promotion.runId !== run.runId ||
    promotion.bomItemId !== artifact.bomItemId ||
    promotion.fromStagingPath !== artifact.stagingPath ||
    promotion.targetPath !== item?.targetPath
  ) {
    throw new Error(`Asset promotion manifest for "${artifactId}" does not match the run, artifact, or BOM target.`);
  }
  if (
    !/^[a-f0-9]{64}$/.test(promotion.sourceSha256) ||
    !/^[a-f0-9]{64}$/.test(promotion.targetSha256) ||
    promotion.sourceSha256 !== artifact.sha256 ||
    promotion.targetSha256 !== artifact.sha256
  ) {
    throw new Error(`Asset promotion manifest for "${artifactId}" does not prove byte-identical staged and target checksums.`);
  }
  if (
    promotion.userDecision.reviewer !== 'user' ||
    promotion.userDecision.decision !== 'promote' ||
    promotion.userDecision.artifactId !== artifactId
  ) {
    throw new Error(`Asset promotion manifest for "${artifactId}" lacks matching user decision provenance.`);
  }
  if (
    promotion.provenance.length === 0 ||
    promotion.licenses.length === 0 ||
    promotion.provenance.some((entry) =>
      entry.transferability === 'prohibited' ||
      entry.transferability === 'unknown' ||
      entry.license === undefined ||
      entry.license === null ||
      entry.license.trim().length === 0
    )
  ) {
    throw new Error(`Asset promotion manifest for "${artifactId}" lacks transferable license provenance.`);
  }
}

export function createAssetPipelineRun(input: Omit<AssetPipelineRun, 'state' | 'createdAt' | 'updatedAt'>, now = new Date().toISOString()): AssetPipelineRun {
  if (input.runId.trim().length === 0) throw new Error('Asset pipeline run requires a run id.');
  if (input.bom.length === 0) throw new Error('Asset pipeline BOM cannot be empty.');
  const validation = validateAssetBom(input.bom);
  if (validation.issues.length > 0) {
    throw new Error(`Asset pipeline BOM is invalid: ${validation.issues.join('; ')}.`);
  }
  for (const operation of input.operations) validateProviderOperation(input.runId, operation);
  if (new Set(input.promotions.map((promotion) => promotion.artifactId)).size !== input.promotions.length) {
    throw new Error('Asset pipeline promotion manifests contain duplicate artifact ids.');
  }
  for (const artifact of input.artifacts) {
    if (!isAssetStagingPath(input.runId, artifact.stagingPath)) {
      throw new Error(`Asset artifact "${artifact.id}" is outside the run staging directory.`);
    }
  }
  return { ...input, state: 'bom_draft', createdAt: now, updatedAt: now };
}
