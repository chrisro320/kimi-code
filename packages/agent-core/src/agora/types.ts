export type AgoraMode = 'planning' | 'acceptance';

export type AgoraNecessityOutcome = 'recommended' | 'allowed_on_request' | 'declined';

import type { AgoraLifecyclePhase } from './lifecycle';
export type { AgoraLifecyclePhase };

export type AgoraSignalLevel = 'low' | 'medium' | 'high';

export interface AgoraNecessitySignals {
  readonly impactIfWrong: AgoraSignalLevel;
  readonly uncertaintyOrDisagreement: AgoraSignalLevel;
  readonly expectedInformationGain: AgoraSignalLevel;
  readonly incrementalCostLatency: AgoraSignalLevel;
}

export interface AgoraNecessityDecision {
  readonly outcome: AgoraNecessityOutcome;
  readonly signals: AgoraNecessitySignals;
  readonly explanation: string;
  readonly normalWorkflowRecommendation: string;
  readonly forcedByUser: boolean;
}

export interface AgoraHostInitialView {
  readonly position: string;
  readonly evidence: readonly string[];
  readonly assumptions: readonly string[];
  readonly confidence: 'low' | 'medium' | 'high';
  readonly strongestCounterexample?: string;
}

export interface AgoraPeerRoute {
  readonly backend: string;
  readonly modelOverride?: string;
  /** Existing runtime-validated read-only profile; defaults to agora-peer. */
  readonly profileName?: string;
  /** Optional UI label; the stable map key remains the peer identity. */
  readonly displayName?: string;
  readonly role?: string;
}

/** Configurable Agora roster. Keys are stable peer ids, not hard-coded vendors. */
export type AgoraPeerRoutes = Readonly<Record<string, AgoraPeerRoute>>;

export interface AgoraPacketInput {
  readonly runId: string;
  readonly mode: AgoraMode;
  readonly userGoal: string;
  readonly exactQuestion: string;
  readonly desiredDecision: string;
  readonly projectState: string;
  readonly dissatisfactionOrUncertainty: string;
  readonly hostInitialView: AgoraHostInitialView;
  readonly currentArtifactOrDiff?: string;
  readonly expectedResultOrAcceptanceCriteria?: string;
  readonly actualResultOrCurrentProposal?: string;
  readonly relevantEvidence?: readonly string[];
  readonly validationSignals?: readonly string[];
  readonly constraints?: readonly string[];
  readonly userPrioritiesAndTradeoffs?: readonly string[];
  readonly qualityDeficiencies?: readonly string[];
  readonly failedOrMissingValidation?: readonly string[];
  readonly priorCoderResultOrDiff?: string;
  readonly packetRevision: number;
  readonly redactionSummary: string;
  readonly recovery: boolean;
}

export interface AgoraPeerPacket {
  readonly runId: string;
  readonly round: 1;
  readonly mode: AgoraMode;
  readonly userGoal: string;
  readonly exactQuestion: string;
  readonly desiredDecision: string;
  readonly projectState: string;
  readonly dissatisfactionOrUncertainty: string;
  readonly currentArtifactOrDiff?: string;
  readonly expectedResultOrAcceptanceCriteria?: string;
  readonly actualResultOrCurrentProposal?: string;
  readonly relevantEvidence: readonly string[];
  readonly validationSignals: readonly string[];
  readonly constraints: readonly string[];
  readonly userPrioritiesAndTradeoffs: readonly string[];
  readonly qualityDeficiencies: readonly string[];
  readonly failedOrMissingValidation: readonly string[];
  readonly priorCoderResultOrDiff?: string;
  readonly hostRoute: 'coder' | 'coder-ex';
  readonly routeUpgrade: 'none' | 'coder_to_coder-ex';
  readonly peerRoutes: AgoraPeerRoutes;
  readonly packetRevision: number;
  readonly redactionSummary: string;
}

export type AgoraPeerPosition = 'support' | 'oppose' | 'conditional' | 'unable_to_determine';

export interface AgoraPeerResponse {
  readonly peer: string;
  readonly position: AgoraPeerPosition;
  readonly answer: string;
  readonly evidence: readonly string[];
  readonly assumptions: readonly string[];
  readonly risks: readonly string[];
  readonly confidence: 'low' | 'medium' | 'high';
  readonly dissent?: string;
}

export type AgoraClaimSource = 'user' | 'host' | 'claude' | 'grok' | `peer:${string}` | 'synthesis_inference';

export interface AgoraClaim {
  readonly source: AgoraClaimSource;
  readonly claim: string;
  readonly evidence: readonly string[];
}

export type AgoraDecisionStatus =
  | 'actionable'
  | 'needs_evidence'
  | 'needs_acceptance_definition'
  | 'unresolved';

export interface AgoraSynthesisInput {
  readonly mode: AgoraMode;
  readonly hostPosition: AgoraPeerPosition;
  readonly peerResponses: readonly AgoraPeerResponse[];
  readonly claims: readonly AgoraClaim[];
  readonly acceptanceCriteriaConfirmed: boolean;
  readonly targetedEvidenceResolvedConflict?: boolean;
}

export interface AgoraSynthesisResult {
  readonly status: AgoraDecisionStatus;
  readonly claims: readonly AgoraClaim[];
  readonly disagreements: readonly string[];
  readonly confidence: 'low' | 'medium' | 'high';
  readonly nextEvidenceStep?: string;
}

export type AgoraPhase = AgoraLifecyclePhase;

export interface AgoraRunState {
  readonly runId: string;
  readonly mode: AgoraMode;
  readonly phase: AgoraPhase;
  readonly forcedByUser: boolean;
  readonly contractRepairs: Readonly<Record<string, number>>;
  readonly temporaryOverrides: Readonly<Record<string, 'active' | 'disposed'>>;
  /** @deprecated compatibility projection for the historical Claude default. */
  readonly claudeModelOverride?: 'active' | 'disposed';
}
