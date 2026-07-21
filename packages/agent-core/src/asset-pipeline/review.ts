import type {
  AssetArtifactManifest,
  AssetBomItem,
  AssetInspectionCapability,
  AssetReview,
  AssetReviewDecision,
} from './types';

const DIRECT_IMAGE_CATEGORIES = new Set(['2d', 'ui', 'icon', 'texture', 'material', 'vfx']);
const PREVIEW_REQUIRED_CATEGORIES = new Set(['video', '3d', 'animation', 'music', 'ambience', 'sfx', 'voice']);

export function assetInspectionCapability(
  item: Pick<AssetBomItem, 'category'>,
  artifact: Pick<AssetArtifactManifest, 'mimeType' | 'previewPaths' | 'metadata'>,
): AssetInspectionCapability {
  if (DIRECT_IMAGE_CATEGORIES.has(item.category) && artifact.mimeType.startsWith('image/')) {
    return 'direct-media';
  }
  if (PREVIEW_REQUIRED_CATEGORIES.has(item.category) && artifact.previewPaths.length > 0) {
    return 'preview-and-metadata';
  }
  if (PREVIEW_REQUIRED_CATEGORIES.has(item.category) && Object.keys(artifact.metadata).length > 0) {
    return 'metadata-only';
  }
  return 'unavailable';
}

export function createKimiAssetReview(input: {
  readonly item: AssetBomItem;
  readonly artifact: AssetArtifactManifest;
  readonly requestedDecision: AssetReviewDecision;
  readonly score?: number;
  readonly classification?: string;
  readonly issues?: readonly string[];
  readonly evidence?: readonly string[];
  readonly reviewedAt?: string;
}): AssetReview {
  const capability = assetInspectionCapability(input.item, input.artifact);
  const cannotDirectlyAccept = capability === 'metadata-only' || capability === 'unavailable';
  const decision = cannotDirectlyAccept && input.requestedDecision === 'promote'
    ? 'needs_user_review'
    : input.requestedDecision;
  const issues = [
    ...(input.issues ?? []),
    ...(cannotDirectlyAccept ? ['Kimi cannot directly inspect this asset format; user review is required.'] : []),
  ];
  return {
    artifactId: input.artifact.id,
    reviewer: 'kimi',
    inspectionCapability: capability,
    decision,
    score: input.score,
    classification: input.classification,
    issues,
    evidence: input.evidence ?? [],
    reviewedAt: input.reviewedAt ?? new Date().toISOString(),
  };
}
