import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalKaos } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it } from 'vitest';

import { promoteAssetArtifact, type AssetPipelineRun } from '../src/asset-pipeline';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function run(bytes: Buffer): AssetPipelineRun {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    runId: 'promotion-run',
    state: 'user_review_pending',
    bom: [{ id: 'icon', category: 'icon', purpose: 'icon', quantity: 1, priority: 'high', specification: 'png icon', targetPath: 'assets/icons/icon.bin', acceptanceRubric: ['approved'], sourceStrategy: 'public_search' }],
    candidates: [{ id: 'candidate', bomItemId: 'icon', title: 'icon', provider: 'local', risk: [], provenance: [{ source: 'test', license: 'CC0-1.0', transferability: 'allowed' }] }],
    operations: [],
    artifacts: [{ id: 'artifact', candidateId: 'candidate', bomItemId: 'icon', stagingPath: 'assets/_staging/promotion-run/icon.bin', sha256, mimeType: 'application/octet-stream', sizeBytes: bytes.length, metadata: {}, previewPaths: [], provenance: [{ source: 'test', license: 'CC0-1.0', transferability: 'allowed' }] }],
    reviews: [{ artifactId: 'artifact', reviewer: 'user', decision: 'promote', issues: [], evidence: ['approved'], reviewedAt: '2026-07-20T00:00:00.000Z' }],
    promotions: [],
    referencesHash: 'a'.repeat(64),
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}

describe('asset promotion transaction', () => {
  it('publishes verified staged bytes without replacing an existing target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asset-promotion-'));
    roots.push(root);
    const bytes = Buffer.from('verified asset bytes');
    await mkdir(join(root, 'assets/_staging/promotion-run'), { recursive: true });
    await writeFile(join(root, 'assets/_staging/promotion-run/icon.bin'), bytes);
    const kaos = (await LocalKaos.create()).withCwd(root);

    const promoted = await promoteAssetArtifact(run(bytes), 'artifact', { kaos, cwd: root });
    expect(promoted.state).toBe('promoted');
    await expect(readFile(join(root, 'assets/icons/icon.bin'))).resolves.toEqual(bytes);

    await expect(promoteAssetArtifact(run(bytes), 'artifact', { kaos, cwd: root })).rejects.toThrow('already exists');
    const reused = await promoteAssetArtifact(run(bytes), 'artifact', { kaos, cwd: root }, { existingTarget: 'reuse-identical' });
    expect(reused.state).toBe('reused-identical');
  });

  it('fails closed when the backend lacks transactional file capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asset-promotion-'));
    roots.push(root);
    const bytes = Buffer.from('asset');
    const kaos = { transactionalFiles: undefined } as unknown as Awaited<ReturnType<typeof LocalKaos.create>>;
    await expect(promoteAssetArtifact(run(bytes), 'artifact', { kaos, cwd: root })).rejects.toThrow('lacks transactional file capability');
  });
});
