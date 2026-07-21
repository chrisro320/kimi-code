import type { AgoraPacketInput, AgoraPeerPacket, AgoraPeerRoutes } from './types';

export const DEFAULT_AGORA_PEER_ROUTES: AgoraPeerRoutes = {
  claude: { backend: 'claude-code', modelOverride: 'Opus 4.8' },
  grok: { backend: 'kimi', modelOverride: 'kimicode-grok-4.5' },
};

export function buildAgoraPeerPacket(
  input: AgoraPacketInput,
  peerRoutes: AgoraPeerRoutes = DEFAULT_AGORA_PEER_ROUTES,
): AgoraPeerPacket {
  if (input.packetRevision < 1) throw new Error('Agora packet revision must be at least 1.');
  if (input.exactQuestion.trim().length === 0) throw new Error('Agora packet requires an exact question.');
  if (input.dissatisfactionOrUncertainty.trim().length === 0) {
    throw new Error('Agora packet requires the user dissatisfaction or uncertainty.');
  }

  const qualityDeficiencies = [...(input.qualityDeficiencies ?? [])];
  const failedOrMissingValidation = [...(input.failedOrMissingValidation ?? [])];
  if (input.recovery) {
    if (input.priorCoderResultOrDiff?.trim().length !== undefined && input.priorCoderResultOrDiff.trim().length === 0) {
      throw new Error('Agora recovery requires a non-empty prior coder result or diff.');
    }
    if (input.priorCoderResultOrDiff === undefined) {
      throw new Error('Agora recovery requires a prior coder result or diff.');
    }
    if (qualityDeficiencies.length === 0) {
      throw new Error('Agora recovery requires concrete quality deficiencies.');
    }
    if (failedOrMissingValidation.length === 0) {
      throw new Error('Agora recovery requires failed or missing validation evidence.');
    }
  }

  return {
    runId: input.runId,
    round: 1,
    mode: input.mode,
    userGoal: input.userGoal,
    exactQuestion: input.exactQuestion,
    desiredDecision: input.desiredDecision,
    projectState: input.projectState,
    dissatisfactionOrUncertainty: input.dissatisfactionOrUncertainty,
    currentArtifactOrDiff: input.currentArtifactOrDiff,
    expectedResultOrAcceptanceCriteria: input.expectedResultOrAcceptanceCriteria,
    actualResultOrCurrentProposal: input.actualResultOrCurrentProposal,
    relevantEvidence: [...(input.relevantEvidence ?? [])],
    validationSignals: [...(input.validationSignals ?? [])],
    constraints: [...(input.constraints ?? [])],
    userPrioritiesAndTradeoffs: [...(input.userPrioritiesAndTradeoffs ?? [])],
    qualityDeficiencies,
    failedOrMissingValidation,
    priorCoderResultOrDiff: input.priorCoderResultOrDiff,
    hostRoute: input.recovery ? 'coder-ex' : 'coder',
    routeUpgrade: input.recovery ? 'coder_to_coder-ex' : 'none',
    peerRoutes,
    packetRevision: input.packetRevision,
    redactionSummary: input.redactionSummary,
  };
}
