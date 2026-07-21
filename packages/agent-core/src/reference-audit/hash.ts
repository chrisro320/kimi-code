import { createHash } from 'node:crypto';

import type { ReferenceAuditPlan, ReferenceAuditResult, ReferenceDescriptor } from './types';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function hashReferenceSet(references: readonly ReferenceDescriptor[]): string {
  return sha256([...references].toSorted((a, b) => a.id.localeCompare(b.id)));
}

export function hashReferenceAuditPlan(plan: ReferenceAuditPlan): string {
  return sha256({
    intensity: plan.classification.intensity,
    references: plan.references.map((reference) => reference.id).toSorted(),
    tracks: plan.tracks.map((track) => ({
      id: track.id,
      workflowRole: track.workflowRole,
      referenceIds: [...track.referenceIds].toSorted(),
      dimensions: [...track.dimensions].toSorted(),
    })).toSorted((a, b) => a.id.localeCompare(b.id)),
  });
}

export function hashReferenceAuditResult(result: ReferenceAuditResult): string {
  return sha256({
    intensity: result.intensity,
    references: result.references,
    tracks: result.tracks,
    reports: result.reports,
    claims: result.claims,
    contradictions: result.contradictions,
    unknowns: result.unknowns,
    licenseNotes: result.licenseNotes,
  });
}
