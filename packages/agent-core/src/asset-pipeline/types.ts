export type AssetCategory =
  | '2d'
  | 'ui'
  | 'icon'
  | 'font'
  | '3d'
  | 'texture'
  | 'material'
  | 'animation'
  | 'vfx'
  | 'video'
  | 'music'
  | 'ambience'
  | 'sfx'
  | 'voice';

export type AssetPipelineState =
  | 'bom_draft'
  | 'bom_confirmed'
  | 'candidates_discovered'
  | 'candidates_confirmed'
  | 'staging_downloaded_or_generated'
  | 'kimi_pre_reviewed'
  | 'user_review_pending'
  | 'promoted'
  | 'rejected'
  | 'deferred'
  | 'unavailable'
  | 'cancelled';

export type AssetSourceStrategy = 'public_search' | 'dreamina' | 'local_import' | 'mixed';
export type AssetReviewDecision = 'promote' | 'reject' | 'defer' | 'needs_user_review';
export type AssetTransferability = 'allowed' | 'conditional' | 'prohibited' | 'unknown';
export type AssetInspectionCapability = 'direct-media' | 'preview-and-metadata' | 'metadata-only' | 'unavailable';
export type AssetProviderOperationKind = 'public_download' | 'local_import' | 'generation';
export type AssetProviderOperationState = 'planned' | 'confirmed' | 'completed' | 'failed' | 'unavailable' | 'cancelled';

export interface AssetBomItem {
  readonly id: string;
  readonly category: AssetCategory;
  readonly purpose: string;
  readonly context?: string;
  readonly quantity: number;
  readonly priority: 'critical' | 'high' | 'medium' | 'low';
  readonly specification: string;
  readonly targetPath: string;
  readonly acceptanceRubric: readonly string[];
  readonly sourceStrategy: AssetSourceStrategy;
  readonly budget?: { readonly currency: string; readonly max: number };
  readonly milestone?: string;
}

export interface AssetProvenance {
  readonly source: string;
  readonly location?: string;
  readonly accessedAt?: string;
  readonly license?: string | null;
  readonly attribution?: string;
  readonly transferability: AssetTransferability;
}

export interface AssetCandidate {
  readonly id: string;
  readonly bomItemId: string;
  readonly title: string;
  readonly sourceUrl?: string;
  readonly provider: string;
  readonly format?: string;
  readonly sizeBytes?: number;
  readonly previewPath?: string;
  readonly estimatedCost?: { readonly currency: string; readonly amount: number };
  readonly risk: readonly string[];
  readonly provenance: readonly AssetProvenance[];
}

export interface AssetBatchConfirmation {
  readonly runId: string;
  readonly candidateIds: readonly string[];
  readonly approvedBy: 'user';
  readonly approvedAt: string;
  readonly quantityLimit: number;
  readonly costLimit?: { readonly currency: string; readonly max: number };
  readonly direction?: string;
}

export interface AssetProviderOperation {
  readonly id: string;
  readonly kind: AssetProviderOperationKind;
  readonly provider: string;
  readonly candidateId?: string;
  readonly bomItemId: string;
  readonly state: AssetProviderOperationState;
  readonly stagingPath: string;
  readonly model?: string;
  readonly promptRef?: string;
  readonly rawResponseRef?: string;
  readonly error?: string;
  readonly actualCost?: { readonly currency: string; readonly amount: number };
  readonly finalSourceUrls?: readonly string[];
}

export type AssetChecksumPolicy =
  | { readonly mode: 'expected'; readonly sha256: string }
  | { readonly mode: 'record_actual' };

export interface AssetCandidateExecutionPolicy {
  readonly candidateId: string;
  readonly operationKind: AssetProviderOperationKind;
  readonly allowedDomains: readonly string[];
  readonly allowedLicenses: readonly string[];
  readonly maxTotalSizeBytes: number;
  readonly allowedExtensions: readonly string[];
  readonly allowedMimeTypes: readonly string[];
  readonly checksum: AssetChecksumPolicy;
}

export type AssetExecutionErrorCode = 'WORKER_UNAVAILABLE' | 'RESPONSE_TOO_LARGE' | 'INVALID_JSON' | 'SCHEMA_INVALID' | 'CONFIRMATION_MISMATCH' | 'UNEXPECTED_CANDIDATE' | 'DUPLICATE_ID' | 'DUPLICATE_PATH' | 'QUANTITY_EXCEEDED' | 'COST_REQUIRED' | 'COST_UNKNOWN' | 'COST_CURRENCY_MISMATCH' | 'COST_EXCEEDED' | 'DOMAIN_DENIED' | 'LICENSE_DENIED' | 'PATH_MISMATCH' | 'PATH_ESCAPE' | 'SYMLINK_REJECTED' | 'NON_REGULAR_FILE' | 'HARDLINK_REJECTED' | 'FILE_MISSING' | 'FILE_CHANGED_DURING_VERIFY' | 'UNMANIFESTED_FILE' | 'SIZE_EXCEEDED' | 'SIZE_MISMATCH' | 'EXTENSION_DENIED' | 'MIME_UNVERIFIED' | 'MIME_MISMATCH' | 'CHECKSUM_MISMATCH' | 'PROVIDER_UNAVAILABLE';

export interface AssetExecutionIssue { readonly code: AssetExecutionErrorCode; readonly candidateId?: string; readonly path?: string; readonly message: string; }

export interface VerifiedAssetExecutionResult {
  readonly runId: string;
  readonly confirmationHash: string;
  readonly status: 'completed' | 'partial' | 'unavailable' | 'failed';
  readonly operations: readonly AssetProviderOperation[];
  readonly artifacts: readonly AssetArtifactManifest[];
  readonly issues: readonly AssetExecutionIssue[];
  readonly counts: { readonly confirmed: number; readonly completed: number; readonly unavailable: number; readonly failed: number; readonly artifacts: number };
  readonly cost: { readonly currency: string; readonly limit: number; readonly reported: number; readonly fullyVerified: boolean };
}

export interface AssetArtifactManifest {
  readonly id: string;
  readonly candidateId?: string;
  readonly bomItemId: string;
  readonly stagingPath: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly previewPaths: readonly string[];
  readonly provider?: string;
  readonly model?: string;
  readonly promptRef?: string;
  readonly provenance?: readonly AssetProvenance[];
}

export interface AssetReview {
  readonly artifactId: string;
  readonly reviewer: 'kimi' | 'user';
  readonly inspectionCapability?: AssetInspectionCapability;
  readonly decision: AssetReviewDecision;
  readonly score?: number;
  readonly classification?: string;
  readonly issues: readonly string[];
  readonly evidence: readonly string[];
  readonly reviewedAt: string;
}

export interface AssetPromotionRecord {
  readonly runId: string;
  readonly artifactId: string;
  readonly bomItemId: string;
  readonly fromStagingPath: string;
  readonly targetPath: string;
  readonly sourceSha256: string;
  readonly targetSha256: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly provider?: string;
  readonly model?: string;
  readonly promptRef?: string;
  readonly provenance: readonly AssetProvenance[];
  readonly licenses: readonly string[];
  readonly attributions: readonly string[];
  readonly userDecision: AssetReview;
  readonly verifiedAt: string;
}

export interface AssetPipelineRun {
  readonly runId: string;
  readonly state: AssetPipelineState;
  readonly bom: readonly AssetBomItem[];
  readonly candidates: readonly AssetCandidate[];
  readonly batchConfirmation?: AssetBatchConfirmation;
  readonly operations: readonly AssetProviderOperation[];
  readonly artifacts: readonly AssetArtifactManifest[];
  readonly reviews: readonly AssetReview[];
  readonly promotions: readonly AssetPromotionRecord[];
  readonly referencesHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
