import type { AgoraPeerPosition, AgoraPeerResponse } from './types';

export type AgoraPeerNormalization =
  | {
      readonly status: 'completed';
      readonly rawResponse: string;
      readonly response: AgoraPeerResponse;
    }
  | {
      readonly status: 'repair_required';
      readonly rawResponse: string;
      readonly missing: readonly string[];
    }
  | {
      readonly status: 'unavailable';
      readonly rawResponse: string;
      readonly reason: string;
    };

const POSITIONS = new Set<AgoraPeerPosition>([
  'support',
  'oppose',
  'conditional',
  'unable_to_determine',
]);

/**
 * Parse the deliberately small heading contract returned by external peers.
 * Raw text is always retained; malformed output never becomes agreement.
 */
export function normalizeAgoraPeerResponse(
  peer: string,
  rawResponse: string,
): AgoraPeerNormalization {
  const raw = rawResponse.trim();
  if (raw.length === 0) {
    return { status: 'unavailable', rawResponse, reason: 'empty peer response' };
  }
  const fields = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^(position|answer|evidence|assumptions|risks|confidence|dissent)\s*:\s*(.*)$/i.exec(line.trim());
    if (match) fields.set(match[1]!.toLowerCase(), match[2]!.trim());
  }
  const required = ['position', 'answer', 'evidence', 'assumptions', 'risks', 'confidence'];
  const missing = required.filter((key) => (fields.get(key) ?? '').length === 0);
  const position = fields.get('position') as AgoraPeerPosition | undefined;
  if (position === undefined || !POSITIONS.has(position)) missing.push('position');
  const confidence = fields.get('confidence');
  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') missing.push('confidence');
  if (missing.length > 0) return { status: 'repair_required', rawResponse, missing: [...new Set(missing)] };

  const list = (key: string): readonly string[] =>
    (fields.get(key) ?? '')
      .split(/\s*;\s*|\s*,\s*/)
      .map((item) => item.trim())
      .filter(Boolean);
  return {
    status: 'completed',
    rawResponse,
    response: {
      peer,
      position: position!,
      answer: fields.get('answer')!,
      evidence: list('evidence'),
      assumptions: list('assumptions'),
      risks: list('risks'),
      confidence: confidence as 'low' | 'medium' | 'high',
      dissent: fields.get('dissent') || undefined,
    },
  };
}
