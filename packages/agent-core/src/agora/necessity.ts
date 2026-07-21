import type {
  AgoraNecessityDecision,
  AgoraNecessitySignals,
  AgoraSignalLevel,
} from './types';

const LEVEL_SCORE: Readonly<Record<AgoraSignalLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

function signalSummary(signals: AgoraNecessitySignals): string {
  return [
    `impact=${signals.impactIfWrong}`,
    `uncertainty=${signals.uncertaintyOrDisagreement}`,
    `information_gain=${signals.expectedInformationGain}`,
    `cost_latency=${signals.incrementalCostLatency}`,
  ].join(', ');
}

export function evaluateAgoraNecessity(
  signals: AgoraNecessitySignals,
  options: { readonly forceAfterDecline?: boolean } = {},
): AgoraNecessityDecision {
  const valueScore =
    LEVEL_SCORE[signals.impactIfWrong] +
    LEVEL_SCORE[signals.uncertaintyOrDisagreement] +
    LEVEL_SCORE[signals.expectedInformationGain];
  const costScore = LEVEL_SCORE[signals.incrementalCostLatency];

  let outcome: AgoraNecessityDecision['outcome'];
  let explanation: string;
  let normalWorkflowRecommendation: string;

  if (
    (valueScore <= 2 && costScore >= 1) ||
    (valueScore <= 3 && costScore === 2)
  ) {
    outcome = 'declined';
    explanation = `Agora is disproportionate for the current evidence (${signalSummary(signals)}).`;
    normalWorkflowRecommendation =
      signals.uncertaintyOrDisagreement === 'low'
        ? 'Continue with the normal single-agent workflow and decisive evidence already available.'
        : 'Clarify scope or gather one targeted piece of evidence before reconsidering Agora.';
  } else if (valueScore >= 5 && LEVEL_SCORE[signals.expectedInformationGain] >= 1) {
    outcome = 'recommended';
    explanation = `Independent verification is likely to reduce material risk (${signalSummary(signals)}).`;
    normalWorkflowRecommendation =
      'If Agora is not used, add a focused read-only review before consequential action.';
  } else {
    outcome = 'allowed_on_request';
    explanation = `Agora is valid but not clearly necessary (${signalSummary(signals)}).`;
    normalWorkflowRecommendation =
      'The normal workflow remains acceptable if the user prefers lower cost and latency.';
  }

  const forcedByUser = outcome === 'declined' && options.forceAfterDecline === true;
  return { outcome, signals, explanation, normalWorkflowRecommendation, forcedByUser };
}
