import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAssetExecutionEnvelope, hashAssetBatchConfirmation, parseAssetWorkerManifest, verifyAssetWorkerManifest, type AssetBomItem, type AssetCandidate, type AssetCandidateExecutionPolicy } from '../src/asset-pipeline';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const bom: AssetBomItem[] = [{ id: 'icon-asset', category: 'icon', purpose: 'icon', quantity: 1, priority: 'high', specification: 'png', targetPath: 'assets/icon.png', acceptanceRubric: ['valid'], sourceStrategy: 'public_search' }];
const candidate: AssetCandidate = { id: 'candidate-1', bomItemId: 'icon-asset', title: 'icon', sourceUrl: 'https://example.test/icon.png', provider: 'public-web', format: 'png', estimatedCost: { currency: 'USD', amount: 0 }, risk: [], provenance: [{ source: 'https://example.test/icon.png', license: 'CC0', transferability: 'allowed' }] };
const policy: AssetCandidateExecutionPolicy = { candidateId: candidate.id, operationKind: 'public_download', allowedDomains: ['example.test'], allowedLicenses: ['CC0'], maxTotalSizeBytes: 1024, allowedExtensions: ['png'], allowedMimeTypes: ['image/png'], checksum: { mode: 'record_actual' } };
const confirmation = { runId: 'run-1', candidateIds: [candidate.id], approvedBy: 'user' as const, approvedAt: '2026-07-20T00:00:00.000Z', quantityLimit: 1, costLimit: { currency: 'USD', max: 0 } };
const hash = hashAssetBatchConfirmation({ runId: 'run-1', candidates: [candidate], confirmation, policies: [policy] });
const envelope = createAssetExecutionEnvelope({ runId: 'run-1', bom, candidates: [candidate], policies: [policy], confirmation });
const path = envelope.items[0]!.stagingPath;
const sha = createHash('sha256').update(png).digest('hex');
function manifest(checksum = sha) { return { schemaVersion: 1 as const, runId: 'run-1', confirmationHash: hash, operations: [{ id: 'op-1', candidateId: candidate.id, bomItemId: 'icon-asset', kind: 'public_download' as const, provider: 'public-web', state: 'completed' as const, stagingPath: path }], artifacts: [{ id: 'art-1', candidateId: candidate.id, bomItemId: 'icon-asset', stagingPath: path, sha256: checksum, mimeType: 'image/png', sizeBytes: png.byteLength, metadata: {}, previewPaths: [] }] }; }
function runtime(extra = false) {
  const directory = { stMode: 0o040755, stIno: 1, stDev: 1, stNlink: 1, stUid: 0, stGid: 0, stSize: 0, stAtime: 0, stMtime: 0, stCtime: 0 };
  const file = { ...directory, stMode: 0o100644, stIno: 2, stSize: png.byteLength };
  return { cwd: '/workspace', kaos: {
    stat: vi.fn(async (value: string) => value.endsWith('.png') || value.endsWith('.extra') ? file : directory),
    readBytes: vi.fn(async () => png),
    mkdir: vi.fn(),
    iterdir: async function* (value: string) {
      if (value.endsWith('/run-1')) yield '/workspace/assets/_staging/run-1/icon-asset';
      if (value.endsWith('/icon-asset')) { yield `/workspace/${path}`; if (extra) yield `/workspace/${path}.extra`; }
    },
  } };
}

describe('asset worker manifest hardening', () => {
  it('strictly rejects markdown, prose, unknown keys, and oversized responses', () => {
    const raw = JSON.stringify(manifest());
    expect(() => parseAssetWorkerManifest(`\`\`\`json\n${raw}\n\`\`\``)).toThrow(/one JSON object/);
    expect(() => parseAssetWorkerManifest(`result: ${raw}`)).toThrow(/one JSON object/);
    expect(() => parseAssetWorkerManifest(JSON.stringify({ ...manifest(), unknown: true }))).toThrow(/strict schema/);
    expect(() => parseAssetWorkerManifest('x'.repeat(256 * 1024 + 1))).toThrow(/exceeds/);
  });

  it('redacts secrets and persists only an audit hash plus redacted JSON', () => {
    const value = manifest();
    const withSecret = {
      ...value,
      operations: value.operations.map((operation) => ({
        ...operation,
        error: 'token=sk-abcdefghijklmnopqrstuvwxyz0123456789',
      })),
    };
    const parsed = parseAssetWorkerManifest(JSON.stringify(withSecret));
    expect(parsed.audit.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.audit.redactedJson).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(parsed.audit.redactedJson).toContain('[REDACTED]');
  });

  it('re-reads bytes through Kaos and returns normalized measured results', async () => {
    const parsed = parseAssetWorkerManifest(JSON.stringify(manifest()));
    const result = await verifyAssetWorkerManifest({ manifest: parsed.manifest, envelope, policies: [policy], confirmationHash: hash, runtime: runtime() });
    expect(result.status).toBe('completed');
    expect(result.artifacts).toEqual([expect.objectContaining({ sha256: sha, mimeType: 'image/png', sizeBytes: png.byteLength, provider: 'public-web' })]);
  });

  it('fails the whole batch on checksum mismatch or unmanifested files', async () => {
    const bad = parseAssetWorkerManifest(JSON.stringify(manifest('a'.repeat(64))));
    const checksum = await verifyAssetWorkerManifest({ manifest: bad.manifest, envelope, policies: [policy], confirmationHash: hash, runtime: runtime() });
    expect(checksum).toMatchObject({ status: 'failed', artifacts: [] });
    expect(checksum.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CHECKSUM_MISMATCH' })]));
    const good = parseAssetWorkerManifest(JSON.stringify(manifest()));
    const extra = await verifyAssetWorkerManifest({ manifest: good.manifest, envelope, policies: [policy], confirmationHash: hash, runtime: runtime(true) });
    expect(extra).toMatchObject({ status: 'failed', artifacts: [] });
    expect(extra.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNMANIFESTED_FILE' })]));
  });

  it('binds exact policy fields into the approval hash', () => {
    const changed = hashAssetBatchConfirmation({ runId: 'run-1', candidates: [candidate], confirmation, policies: [{ ...policy, maxTotalSizeBytes: 2048 }] });
    expect(changed).not.toBe(hash);
  });
});
