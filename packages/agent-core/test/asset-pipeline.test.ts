import { describe, expect, it } from 'vitest';

import {
  assetInspectionCapability,
  assetStagingPath,
  canTransitionAssetPipeline,
  createAssetCleanupPlan,
  createAssetExecutionEnvelope,
  createAssetPipelineRun,
  createAssetPromotionManifest,
  createKimiAssetReview,
  hashAssetPipelineRun,
  REQUIRED_GAME_ASSET_CATEGORIES,
  selectAssetBomMilestone,
  transitionAssetPipeline,
  unavailableProviderOperation,
  validateAssetBom,
  validateAssetCandidate,
  type AssetArtifactManifest,
  type AssetBomItem,
  type AssetCandidate,
  type AssetCandidateExecutionPolicy,
  type AssetPipelineRun,
} from '../src/asset-pipeline';

const bom: AssetBomItem[] = REQUIRED_GAME_ASSET_CATEGORIES.map((category, index) => ({
  id: `${category}-asset`,
  category,
  purpose: `${category} production asset`,
  quantity: 1,
  priority: index < 3 ? 'critical' : 'medium',
  specification: `Production-ready ${category} asset`,
  targetPath: `assets/${category}/${category}-asset`,
  acceptanceRubric: [`meets ${category} art direction`, 'has documented provenance'],
  sourceStrategy: category === '2d' ? 'dreamina' : 'public_search',
  milestone: index < 5 ? 'vertical-slice' : 'later',
}));

const candidates: AssetCandidate[] = [{
  id: 'icon-candidate',
  bomItemId: 'icon-asset',
  title: 'Licensed icon',
  sourceUrl: 'https://example.test/icon.png',
  provider: 'public-web',
  format: 'png',
  sizeBytes: 1024,
  estimatedCost: { currency: 'USD', amount: 0 },
  risk: [],
  provenance: [{
    source: 'https://example.test/icon.png',
    license: 'CC0-1.0',
    attribution: 'Example author',
    transferability: 'allowed',
  }],
}];

const policy: AssetCandidateExecutionPolicy = {
  candidateId: 'icon-candidate',
  operationKind: 'public_download',
  allowedDomains: ['example.test'],
  allowedLicenses: ['CC0-1.0'],
  maxTotalSizeBytes: 64 * 1024,
  allowedExtensions: ['png'],
  allowedMimeTypes: ['image/png'],
  checksum: { mode: 'record_actual' },
};

const confirmation = {
  runId: 'asset-run-1',
  candidateIds: ['icon-candidate'],
  approvedBy: 'user' as const,
  approvedAt: '2026-07-20T00:00:00.000Z',
  quantityLimit: 1,
  costLimit: { currency: 'USD', max: 0 },
  direction: 'Use the confirmed clean sci-fi direction.',
};

const artifact: AssetArtifactManifest = {
  id: 'artifact-1',
  candidateId: 'icon-candidate',
  bomItemId: 'icon-asset',
  stagingPath: 'assets/_staging/asset-run-1/icon-asset/icon-candidate.png',
  sha256: 'a'.repeat(64),
  mimeType: 'image/png',
  sizeBytes: 1024,
  metadata: { width: 64, height: 64 },
  previewPaths: ['assets/_staging/asset-run-1/icon-asset/icon-candidate-preview.png'],
  provider: 'public-web',
};

function run(patch: Partial<Omit<AssetPipelineRun, 'state' | 'createdAt' | 'updatedAt'>> = {}) {
  return createAssetPipelineRun({
    runId: 'asset-run-1',
    bom,
    candidates: [],
    operations: [],
    artifacts: [],
    reviews: [],
    promotions: [],
    referencesHash: 'ref-hash',
    ...patch,
  }, '2026-07-20T00:00:00.000Z');
}

describe('asset BOM', () => {
  it('requires every game-development asset family before confirmation', () => {
    expect(validateAssetBom(bom)).toEqual({ complete: true, missingCategories: [], issues: [] });
    const incomplete = bom.filter((item) => item.category !== 'voice' && item.category !== 'video');
    expect(validateAssetBom(incomplete)).toMatchObject({ complete: false, missingCategories: ['video', 'voice'] });
    expect(() => transitionAssetPipeline(run({ bom: incomplete }), 'bom_confirmed')).toThrow('missing video');
  });

  it('keeps the full BOM while selecting a milestone execution slice', () => {
    const selected = selectAssetBomMilestone(bom, 'vertical-slice');
    expect(selected).not.toHaveLength(bom.length);
    expect(selected.every((item) => item.milestone === 'vertical-slice')).toBe(true);
    expect(() => selectAssetBomMilestone(bom, 'missing')).toThrow('has no BOM items');
  });
});

describe('asset candidate and staging safety', () => {
  it('requires auditable transferable provenance before confirmation', () => {
    expect(validateAssetCandidate(candidates[0]!)).toEqual([]);
    expect(validateAssetCandidate({
      ...candidates[0]!,
      provenance: [{ source: 'unknown', transferability: 'unknown' }],
    })).toContain('candidate transferability is unknown');
  });

  it('rejects unknown candidate costs when the user set a bounded cost limit', () => {
    const unknownCost = { ...candidates[0]!, estimatedCost: undefined };
    expect(() => createAssetExecutionEnvelope({
      runId: 'asset-run-1',
      bom,
      candidates: [unknownCost],
      policies: [policy],
      confirmation,
    })).toThrow('unknown cost');
  });

  it('creates a bounded frontend-artist envelope that cannot promote', () => {
    const envelope = createAssetExecutionEnvelope({ runId: 'asset-run-1', bom, candidates, policies: [policy], confirmation });
    expect(envelope).toMatchObject({
      profileName: 'frontend-artist',
      direction: confirmation.direction,
      mayPromote: false,
      items: [{ stagingPath: 'assets/_staging/asset-run-1/icon-asset/icon-candidate.png' }],
    });
  });

  it('confines operations and exact cleanup to one run staging root', () => {
    expect(assetStagingPath('asset-run-1', 'models/ship.glb')).toBe('assets/_staging/asset-run-1/models/ship.glb');
    expect(() => assetStagingPath('asset-run-1', '../formal/ship.glb')).toThrow('escapes');
    const operation = {
      id: 'download-1',
      kind: 'public_download' as const,
      provider: 'public-web',
      candidateId: 'icon-candidate',
      bomItemId: 'icon-asset',
      state: 'completed' as const,
      stagingPath: artifact.stagingPath,
    };
    expect(createAssetCleanupPlan(run({ operations: [operation], artifacts: [artifact] }))).toEqual({
      runId: 'asset-run-1',
      stagingRoot: 'assets/_staging/asset-run-1',
      exactPaths: [artifact.stagingPath, ...artifact.previewPaths].sort(),
      requiresConfirmation: true,
    });
  });

  it('reports unavailable generation providers explicitly', () => {
    expect(unavailableProviderOperation({
      runId: 'asset-run-1',
      id: 'dreamina-1',
      bomItemId: '2d-asset',
      provider: 'dreamina',
      reason: 'provider adapter not configured',
    })).toMatchObject({ state: 'unavailable', error: 'provider adapter not configured' });
  });
});

describe('asset review and state gates', () => {
  it('does not let Kimi directly approve unsupported audio/3D inspection', () => {
    const audioItem = bom.find((item) => item.category === 'music')!;
    const audioArtifact = { ...artifact, id: 'music-1', bomItemId: audioItem.id, mimeType: 'audio/ogg', previewPaths: [] };
    expect(assetInspectionCapability(audioItem, audioArtifact)).toBe('metadata-only');
    expect(createKimiAssetReview({
      item: audioItem,
      artifact: audioArtifact,
      requestedDecision: 'promote',
      reviewedAt: '2026-07-20T00:00:00.000Z',
    })).toMatchObject({
      decision: 'needs_user_review',
      inspectionCapability: 'metadata-only',
      issues: [expect.stringContaining('user review is required')],
    });
  });

  it('requires confirmation before side effects and user review before promotion', () => {
    let current = run();
    expect(current.state).toBe('bom_draft');
    expect(canTransitionAssetPipeline('bom_draft', 'staging_downloaded_or_generated')).toBe(false);
    current = transitionAssetPipeline(current, 'bom_confirmed');
    current = transitionAssetPipeline({ ...current, candidates }, 'candidates_discovered');
    expect(() => transitionAssetPipeline(current, 'candidates_confirmed')).toThrow('batch confirmation');
    current = transitionAssetPipeline({ ...current, batchConfirmation: confirmation }, 'candidates_confirmed');

    const operation = {
      id: 'download-1',
      kind: 'public_download' as const,
      provider: 'public-web',
      candidateId: 'icon-candidate',
      bomItemId: 'icon-asset',
      state: 'completed' as const,
      stagingPath: artifact.stagingPath,
    };
    current = transitionAssetPipeline({ ...current, operations: [operation], artifacts: [artifact] }, 'staging_downloaded_or_generated');
    const kimiReview = createKimiAssetReview({
      item: bom.find((item) => item.id === artifact.bomItemId)!,
      artifact,
      requestedDecision: 'needs_user_review',
      reviewedAt: '2026-07-20T00:00:00.000Z',
    });
    current = transitionAssetPipeline({ ...current, reviews: [kimiReview] }, 'kimi_pre_reviewed');
    current = transitionAssetPipeline(current, 'user_review_pending');
    expect(() => transitionAssetPipeline(current, 'promoted')).toThrow('user promote decision');
    current = {
      ...current,
      reviews: [...current.reviews, {
        artifactId: artifact.id,
        reviewer: 'user',
        decision: 'promote',
        issues: [],
        evidence: ['User accepted the staged preview.'],
        reviewedAt: '2026-07-20T00:05:00.000Z',
      }],
    };
    expect(() => transitionAssetPipeline(current, 'promoted')).toThrow('verified promotion manifest');
    const promotion = createAssetPromotionManifest(
      current,
      artifact.id,
      'assets/icon/icon-asset',
      artifact.sha256,
      '2026-07-20T00:06:00.000Z',
    );
    expect(promotion).toMatchObject({
      runId: 'asset-run-1',
      artifactId: artifact.id,
      fromStagingPath: artifact.stagingPath,
      targetPath: 'assets/icon/icon-asset',
      sourceSha256: artifact.sha256,
      targetSha256: artifact.sha256,
      licenses: ['CC0-1.0'],
      attributions: ['Example author'],
      userDecision: { reviewer: 'user', decision: 'promote' },
    });
    expect(() => createAssetPromotionManifest(current, artifact.id, artifact.stagingPath, artifact.sha256)).toThrow('outside staging');
    expect(() => createAssetPromotionManifest(current, artifact.id, 'assets/icon/other', artifact.sha256)).toThrow('confirmed BOM target');
    expect(() => createAssetPromotionManifest(current, artifact.id, 'assets/icon/icon-asset', 'b'.repeat(64))).toThrow('does not match staged bytes');
    current = transitionAssetPipeline({ ...current, promotions: [promotion] }, 'promoted');
    expect(current.state).toBe('promoted');
  });

  it('hashes confirmation, operations, manifests, and reviews deterministically', () => {
    const first = run({ candidates, batchConfirmation: confirmation });
    expect(hashAssetPipelineRun(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashAssetPipelineRun(first)).not.toBe(hashAssetPipelineRun({ ...first, operations: [unavailableProviderOperation({
      runId: 'asset-run-1', id: 'op-1', bomItemId: '2d-asset', provider: 'dreamina', reason: 'offline',
    })] }));
  });
});
