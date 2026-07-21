import type {
  ReferenceAuditPlan,
  ReferenceAuditProvenance,
  ReferenceAuditResult,
  ReferenceAuditWorkerReport,
} from './types';

function validateProvenance(
  provenance: readonly ReferenceAuditProvenance[],
  description: string,
): void {
  if (provenance.length === 0 || provenance.some((item) => item.source.trim().length === 0)) {
    throw new Error(`${description} requires non-empty source provenance.`);
  }
}

function validateReport(
  plan: ReferenceAuditPlan,
  report: ReferenceAuditWorkerReport,
): void {
  const track = plan.tracks.find((candidate) => candidate.id === report.trackId)!;
  const allowedReferenceIds = new Set(track.referenceIds);

  if (
    report.claims.length === 0 &&
    report.unknowns.length === 0 &&
    report.licenseNotes.length === 0
  ) {
    throw new Error(
      `Reference audit report for track "${report.trackId}" must contain evidence or an explicit unknown.`,
    );
  }

  for (const claim of report.claims) {
    if (claim.claim.trim().length === 0) {
      throw new Error(`Reference audit claim in track "${report.trackId}" is empty.`);
    }
    validateProvenance(claim.provenance, `Reference audit claim in track "${report.trackId}"`);
    if (claim.referenceId !== undefined && !allowedReferenceIds.has(claim.referenceId)) {
      throw new Error(
        `Reference audit claim in track "${report.trackId}" targets unknown reference "${claim.referenceId}".`,
      );
    }
  }

  for (const contradiction of report.contradictions) {
    if (
      contradiction.claimIndexes.length === 0 ||
      contradiction.claimIndexes.some(
        (claimIndex) => !Number.isInteger(claimIndex) || claimIndex < 0 || claimIndex >= report.claims.length,
      )
    ) {
      throw new Error(
        `Reference audit contradiction in track "${report.trackId}" has an invalid claim index.`,
      );
    }
  }

  for (const unknown of report.unknowns) {
    if (unknown.referenceId !== undefined && !allowedReferenceIds.has(unknown.referenceId)) {
      throw new Error(
        `Reference audit unknown in track "${report.trackId}" targets unknown reference "${unknown.referenceId}".`,
      );
    }
  }

  for (const note of report.licenseNotes) {
    validateProvenance(note.evidence, `Reference audit license note in track "${report.trackId}"`);
  }
}

export function assembleReferenceAuditResult(
  plan: ReferenceAuditPlan,
  reports: readonly ReferenceAuditWorkerReport[],
): ReferenceAuditResult {
  const planTrackIds = plan.tracks.map((track) => track.id);
  const expectedTrackIds = new Set(planTrackIds);
  if (expectedTrackIds.size !== planTrackIds.length) {
    throw new Error('Reference audit plan contains duplicate track ids.');
  }
  const seenTrackIds = new Set<string>();

  for (const report of reports) {
    if (!expectedTrackIds.has(report.trackId)) {
      throw new Error(`Reference audit report targets unknown track "${report.trackId}".`);
    }
    if (seenTrackIds.has(report.trackId)) {
      throw new Error(`Reference audit contains duplicate report for track "${report.trackId}".`);
    }
    seenTrackIds.add(report.trackId);
    validateReport(plan, report);
  }

  const missingTrackIds = plan.tracks
    .map((track) => track.id)
    .filter((trackId) => !seenTrackIds.has(trackId));
  if (missingTrackIds.length > 0) {
    throw new Error(`Reference audit is incomplete; missing reports for: ${missingTrackIds.join(', ')}.`);
  }

  let claimOffset = 0;
  const contradictions = reports.flatMap((report) => {
    const rebased = report.contradictions.map((contradiction) => ({
      ...contradiction,
      claimIndexes: contradiction.claimIndexes.map((claimIndex) => claimIndex + claimOffset),
    }));
    claimOffset += report.claims.length;
    return rebased;
  });

  return {
    intensity: plan.classification.intensity,
    references: plan.references,
    tracks: plan.tracks,
    reports,
    claims: reports.flatMap((report) => report.claims),
    contradictions,
    unknowns: reports.flatMap((report) => report.unknowns),
    licenseNotes: reports.flatMap((report) => report.licenseNotes),
  };
}
