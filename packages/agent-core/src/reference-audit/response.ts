import type {
  ReferenceAuditClaim,
  ReferenceAuditContradiction,
  ReferenceAuditLicenseNote,
  ReferenceAuditPlan,
  ReferenceAuditUnknown,
  ReferenceAuditWorkerReport,
} from './types';

export type ReferenceAuditReportNormalization =
  | {
      readonly status: 'completed';
      readonly rawResponse: string;
      readonly report: ReferenceAuditWorkerReport;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function provenance(value: unknown): ReferenceAuditWorkerReport['claims'][number]['provenance'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.flatMap((item) => {
    const record = asRecord(item);
    const source = stringValue(record?.['source']);
    if (source === undefined) return [];
    const location = stringValue(record?.['location']);
    const accessedAt = stringValue(record?.['accessed_at']) ?? stringValue(record?.['accessedAt']);
    return [{ source, location, accessedAt }];
  });
  return result;
}

function parseClaims(value: unknown): { items: ReferenceAuditClaim[]; missing: string[] } {
  if (!Array.isArray(value)) return { items: [], missing: ['claims'] };
  const missing: string[] = [];
  const items: ReferenceAuditClaim[] = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    const claim = stringValue(record?.['claim']);
    const kind = record?.['kind'];
    const evidence = provenance(record?.['provenance']);
    if (claim === undefined) missing.push(`claims[${index}].claim`);
    if (kind !== 'evidence' && kind !== 'inference') missing.push(`claims[${index}].kind`);
    if (evidence === undefined || evidence.length === 0) missing.push(`claims[${index}].provenance`);
    if (claim !== undefined && (kind === 'evidence' || kind === 'inference') && evidence !== undefined && evidence.length > 0) {
      const referenceId = stringValue(record?.['reference_id']) ?? stringValue(record?.['referenceId']);
      items.push({ claim, kind, referenceId, provenance: evidence });
    }
  });
  return { items, missing };
}

function parseContradictions(value: unknown): { items: ReferenceAuditContradiction[]; missing: string[] } {
  if (!Array.isArray(value)) return { items: [], missing: ['contradictions'] };
  const missing: string[] = [];
  const items: ReferenceAuditContradiction[] = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    const description = stringValue(record?.['description']);
    const claimIndexes = Array.isArray(record?.['claim_indexes'])
      ? record?.['claim_indexes']
      : record?.['claimIndexes'];
    if (description === undefined) missing.push(`contradictions[${index}].description`);
    if (!Array.isArray(claimIndexes) || claimIndexes.length === 0 || claimIndexes.some((candidate) => !Number.isInteger(candidate))) {
      missing.push(`contradictions[${index}].claim_indexes`);
    }
    if (description !== undefined && Array.isArray(claimIndexes) && claimIndexes.length > 0 && claimIndexes.every((candidate) => Number.isInteger(candidate))) {
      items.push({ description, claimIndexes: claimIndexes as number[] });
    }
  });
  return { items, missing };
}

function parseUnknowns(value: unknown): { items: ReferenceAuditUnknown[]; missing: string[] } {
  if (!Array.isArray(value)) return { items: [], missing: ['unknowns'] };
  const missing: string[] = [];
  const items: ReferenceAuditUnknown[] = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    const question = stringValue(record?.['question']);
    const reason = record?.['reason'];
    if (question === undefined) missing.push(`unknowns[${index}].question`);
    if (reason !== 'inaccessible' && reason !== 'missing-evidence' && reason !== 'conflicting-evidence') {
      missing.push(`unknowns[${index}].reason`);
    }
    if (question !== undefined && (reason === 'inaccessible' || reason === 'missing-evidence' || reason === 'conflicting-evidence')) {
      items.push({ question, reason, referenceId: stringValue(record?.['reference_id']) ?? stringValue(record?.['referenceId']) });
    }
  });
  return { items, missing };
}

function parseLicenseNotes(value: unknown): { items: ReferenceAuditLicenseNote[]; missing: string[] } {
  if (!Array.isArray(value)) return { items: [], missing: ['license_notes'] };
  const missing: string[] = [];
  const items: ReferenceAuditLicenseNote[] = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    const subject = stringValue(record?.['subject']);
    const licenseValue = record?.['license'];
    const license = licenseValue === null ? null : stringValue(licenseValue);
    const transferability = record?.['transferability'];
    const evidence = provenance(record?.['evidence']);
    if (subject === undefined) missing.push(`license_notes[${index}].subject`);
    if (licenseValue !== null && license === undefined) missing.push(`license_notes[${index}].license`);
    if (!['allowed', 'conditional', 'prohibited', 'unknown'].includes(String(transferability))) {
      missing.push(`license_notes[${index}].transferability`);
    }
    if (evidence === undefined || evidence.length === 0) missing.push(`license_notes[${index}].evidence`);
    if (subject !== undefined && (licenseValue === null || license !== undefined) && ['allowed', 'conditional', 'prohibited', 'unknown'].includes(String(transferability)) && evidence !== undefined && evidence.length > 0) {
      items.push({ subject, license: licenseValue === null ? null : license!, transferability: transferability as ReferenceAuditLicenseNote['transferability'], evidence });
    }
  });
  return { items, missing };
}

export function normalizeReferenceAuditReport(
  plan: ReferenceAuditPlan,
  trackId: string,
  rawResponse: string,
): ReferenceAuditReportNormalization {
  const raw = rawResponse.trim();
  if (raw.length === 0) return { status: 'unavailable', rawResponse, reason: 'empty worker response' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'repair_required', rawResponse, missing: ['valid JSON object'] };
  }
  const record = asRecord(parsed);
  if (record === undefined) return { status: 'repair_required', rawResponse, missing: ['JSON object'] };
  const responseTrackId = stringValue(record['track_id']) ?? stringValue(record['trackId']);
  const missing: string[] = [];
  if (responseTrackId === undefined) missing.push('track_id');
  if (responseTrackId !== undefined && responseTrackId !== trackId) missing.push(`track_id=${trackId}`);
  const track = plan.tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined) return { status: 'unavailable', rawResponse, reason: `unknown track ${trackId}` };
  const claims = parseClaims(record['claims']);
  const contradictions = parseContradictions(record['contradictions']);
  const unknowns = parseUnknowns(record['unknowns']);
  const licenseNotes = parseLicenseNotes(record['license_notes'] ?? record['licenseNotes']);
  missing.push(...claims.missing, ...contradictions.missing, ...unknowns.missing, ...licenseNotes.missing);
  if (claims.items.length === 0 && unknowns.items.length === 0 && licenseNotes.items.length === 0) {
    missing.push('claims, unknowns, or license_notes');
  }
  for (const claim of claims.items) {
    if (claim.referenceId !== undefined && !track.referenceIds.includes(claim.referenceId)) {
      missing.push(`claims.reference_id=${claim.referenceId}`);
    }
  }
  for (const unknown of unknowns.items) {
    if (unknown.referenceId !== undefined && !track.referenceIds.includes(unknown.referenceId)) {
      missing.push(`unknowns.reference_id=${unknown.referenceId}`);
    }
  }
  const claimCount = claims.items.length;
  for (const contradiction of contradictions.items) {
    if (contradiction.claimIndexes.some((index) => index < 0 || index >= claimCount)) missing.push('contradictions.claim_indexes in range');
  }
  if (missing.length > 0) return { status: 'repair_required', rawResponse, missing: [...new Set(missing)] };
  return {
    status: 'completed',
    rawResponse,
    report: {
      trackId,
      claims: claims.items,
      contradictions: contradictions.items,
      unknowns: unknowns.items,
      licenseNotes: licenseNotes.items,
    },
  };
}
