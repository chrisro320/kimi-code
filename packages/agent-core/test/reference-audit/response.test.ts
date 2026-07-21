import { describe, expect, it } from 'vitest';

import {
  buildReferenceAuditPlan,
  classifyReferenceAudit,
  hashReferenceAuditPlan,
  hashReferenceSet,
  normalizeReferenceAuditReport,
} from '../../src/reference-audit';

const request = {
  references: [
    { id: 'minecraft', label: 'Minecraft', kind: 'product' as const, role: 'mixed' as const },
    { id: 'nms', label: 'No Man’s Sky', kind: 'product' as const, role: 'mixed' as const },
  ],
  crossProductMashup: true,
};

function plan() {
  const classification = classifyReferenceAudit(request);
  if (!classification.triggered) throw new Error('expected deep audit');
  return buildReferenceAuditPlan(request, classification);
}

describe('normalizeReferenceAuditReport', () => {
  it('normalizes a complete JSON report with nested evidence', () => {
    const current = plan();
    const track = current.tracks[0]!;
    const raw = JSON.stringify({
      track_id: track.id,
      claims: [{
        claim: 'Directly supported fact',
        kind: 'evidence',
        reference_id: track.referenceIds[0],
        provenance: [{ source: 'https://example.test/source', location: 'section 1' }],
      }],
      contradictions: [],
      unknowns: [],
      license_notes: [],
    });
    const result = normalizeReferenceAuditReport(current, track.id, raw);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.report.claims[0]?.provenance[0]?.source).toBe('https://example.test/source');
  });

  it('requests one repair for malformed output and never fabricates fields', () => {
    const current = plan();
    const track = current.tracks[0]!;
    const result = normalizeReferenceAuditReport(current, track.id, '{"track_id":"wrong"}');
    expect(result).toMatchObject({ status: 'repair_required' });
    if (result.status === 'repair_required') expect(result.missing).toContain(`track_id=${track.id}`);
  });

  it('repairs worker data that would violate assembler invariants', () => {
    const current = plan();
    const track = current.tracks[0]!;
    const malformed = JSON.stringify({
      track_id: track.id,
      claims: [{
        claim: 'Direct fact',
        kind: 'evidence',
        reference_id: track.referenceIds[0],
        provenance: [{ source: 'https://example.test/source' }],
      }],
      contradictions: [{ description: 'Empty index set', claim_indexes: [] }],
      unknowns: [{
        question: 'Unknown external reference',
        reason: 'missing-evidence',
        reference_id: 'not-in-this-track',
      }],
      license_notes: [],
    });
    const result = normalizeReferenceAuditReport(current, track.id, malformed);
    expect(result).toMatchObject({ status: 'repair_required' });
    if (result.status === 'repair_required') {
      expect(result.missing).toContain('contradictions[0].claim_indexes');
      expect(result.missing).toContain('unknowns.reference_id=not-in-this-track');
    }
  });

  it('marks empty output unavailable', () => {
    const current = plan();
    expect(normalizeReferenceAuditReport(current, current.tracks[0]!.id, '')).toMatchObject({ status: 'unavailable' });
  });
});

describe('reference audit hashes', () => {
  it('is stable for reference ordering and plan construction', () => {
    const current = plan();
    expect(hashReferenceSet([...request.references].reverse())).toBe(hashReferenceSet(request.references));
    expect(hashReferenceAuditPlan(current)).toMatch(/^[a-f0-9]{64}$/);
  });
});
