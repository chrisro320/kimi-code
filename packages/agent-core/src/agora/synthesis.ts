import type {
  AgoraPeerPosition,
  AgoraSynthesisInput,
  AgoraSynthesisResult,
} from './types';

function meaningfulPositions(input: AgoraSynthesisInput): readonly AgoraPeerPosition[] {
  return input.peerResponses
    .filter((response) => response.position !== 'unable_to_determine')
    .map((response) => response.position);
}

export function synthesizeAgoraDecision(input: AgoraSynthesisInput): AgoraSynthesisResult {
  const positions = meaningfulPositions(input);
  const disagreements: string[] = [];
  const hostConflictsWithAllPeers =
    positions.length >= 2 && positions.every((position) => position !== input.hostPosition);
  const peerPositions = new Set(positions);

  if (peerPositions.size > 1) {
    disagreements.push('Configured Agora peers do not agree on the recommended position.');
  }
  if (hostConflictsWithAllPeers) {
    disagreements.push('The host baseline conflicts with every usable peer position.');
  }

  if (input.mode === 'acceptance' && !input.acceptanceCriteriaConfirmed) {
    return {
      status: 'needs_acceptance_definition',
      claims: input.claims,
      disagreements,
      confidence: 'low',
      nextEvidenceStep: 'Confirm sufficient acceptance criteria with the user before labeling the result accepted or rejected.',
    };
  }

  if (hostConflictsWithAllPeers && input.targetedEvidenceResolvedConflict !== true) {
    return {
      status: 'needs_evidence',
      claims: input.claims,
      disagreements,
      confidence: 'low',
      nextEvidenceStep: 'Gather one targeted, reproducible piece of evidence that distinguishes the host and peer hypotheses.',
    };
  }

  if (peerPositions.size > 1 && input.targetedEvidenceResolvedConflict !== true) {
    return {
      status: 'unresolved',
      claims: input.claims,
      disagreements,
      confidence: 'low',
      nextEvidenceStep: 'Preserve the disagreement and let the user choose the next evidence-gathering step.',
    };
  }

  const usefulResponses = input.peerResponses.filter(
    (response) => response.position !== 'unable_to_determine' && response.evidence.length > 0,
  );
  return {
    status: 'actionable',
    claims: input.claims,
    disagreements,
    confidence: usefulResponses.length >= 2 ? 'high' : usefulResponses.length === 1 ? 'medium' : 'low',
  };
}
