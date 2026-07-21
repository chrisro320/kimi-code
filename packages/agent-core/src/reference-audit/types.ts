export type ReferenceAuditIntensity = 'standard' | 'deep' | 'targeted';

export type ReferenceKind =
  | 'product'
  | 'project'
  | 'repository'
  | 'link'
  | 'media';

export type ReferenceRole = 'behavioral' | 'visual' | 'technical' | 'mixed';

export interface ReferenceDescriptor {
  readonly id: string;
  readonly label: string;
  readonly kind: ReferenceKind;
  readonly role: ReferenceRole;
  readonly location?: string;
  readonly trivial?: boolean;
}

export type ReferenceAuditDimension =
  | 'behavior-and-structure'
  | 'gameplay-and-system-loops'
  | 'world-progression-and-economy'
  | 'player-ux'
  | 'visual-media'
  | 'public-technical-facts'
  | 'open-source-analogues'
  | 'license-and-transferability';

export type ReferenceAuditWorkflowRole = 'source-explore' | 'public-research';

export interface ReferenceAuditRequest {
  readonly references: readonly ReferenceDescriptor[];
  readonly crossProductMashup?: boolean;
  readonly jointlyDefineTarget?: boolean;
  readonly explicitNarrowQuestion?: string;
  readonly requestedIntensity?: ReferenceAuditIntensity;
}

export interface ReferenceAuditSkip {
  readonly triggered: false;
  readonly reason: string;
}

export interface StandardOrDeepReferenceAuditClassification {
  readonly triggered: true;
  readonly intensity: 'standard' | 'deep';
  readonly reason: string;
  readonly narrowQuestion?: never;
}

export interface TargetedReferenceAuditClassification {
  readonly triggered: true;
  readonly intensity: 'targeted';
  readonly reason: string;
  readonly narrowQuestion: string;
}

export type ReferenceAuditClassification =
  | StandardOrDeepReferenceAuditClassification
  | TargetedReferenceAuditClassification;

export type ReferenceAuditDecision = ReferenceAuditSkip | ReferenceAuditClassification;

export interface ReferenceAuditWorkerTrack {
  readonly id: string;
  readonly label: string;
  readonly workflowRole: ReferenceAuditWorkflowRole;
  readonly subagentType: 'explore';
  readonly referenceIds: readonly string[];
  readonly dimensions: readonly ReferenceAuditDimension[];
  readonly prompt: string;
}

export interface ReferenceAuditPlan {
  readonly classification: ReferenceAuditClassification;
  readonly references: readonly ReferenceDescriptor[];
  readonly tracks: readonly ReferenceAuditWorkerTrack[];
}

export type ReferenceAuditClaimKind = 'evidence' | 'inference';

export interface ReferenceAuditProvenance {
  readonly source: string;
  readonly location?: string;
  readonly accessedAt?: string;
}

export interface ReferenceAuditClaim {
  readonly claim: string;
  readonly kind: ReferenceAuditClaimKind;
  readonly referenceId?: string;
  readonly provenance: readonly ReferenceAuditProvenance[];
}

export interface ReferenceAuditContradiction {
  readonly description: string;
  readonly claimIndexes: readonly number[];
}

export interface ReferenceAuditUnknown {
  readonly question: string;
  readonly reason: 'inaccessible' | 'missing-evidence' | 'conflicting-evidence';
  readonly referenceId?: string;
}

export interface ReferenceAuditLicenseNote {
  readonly subject: string;
  readonly license: string | null;
  readonly transferability: 'allowed' | 'conditional' | 'prohibited' | 'unknown';
  readonly evidence: readonly ReferenceAuditProvenance[];
}

export interface ReferenceAuditWorkerReport {
  readonly trackId: string;
  readonly claims: readonly ReferenceAuditClaim[];
  readonly contradictions: readonly ReferenceAuditContradiction[];
  readonly unknowns: readonly ReferenceAuditUnknown[];
  readonly licenseNotes: readonly ReferenceAuditLicenseNote[];
}

export interface ReferenceAuditResult {
  readonly intensity: ReferenceAuditIntensity;
  readonly references: readonly ReferenceDescriptor[];
  readonly tracks: readonly ReferenceAuditWorkerTrack[];
  readonly reports: readonly ReferenceAuditWorkerReport[];
  readonly claims: readonly ReferenceAuditClaim[];
  readonly contradictions: readonly ReferenceAuditContradiction[];
  readonly unknowns: readonly ReferenceAuditUnknown[];
  readonly licenseNotes: readonly ReferenceAuditLicenseNote[];
}
