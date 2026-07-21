import { describe, expect, it, vi } from 'vitest';

import {
  ASSET_DISCOVERY_TIMEOUT_MS,
  buildAssetCandidateDiscoveryTasks,
  normalizeAssetCandidateDiscoveryResponse,
  runAssetCandidateDiscovery,
  type AssetBomItem,
} from '../src/asset-pipeline';

const items: AssetBomItem[] = [
  {
    id: 'public-icon',
    category: 'icon',
    purpose: 'Licensed public icon',
    quantity: 1,
    priority: 'high',
    specification: '64px transparent PNG',
    targetPath: 'assets/icon/public-icon.png',
    acceptanceRubric: ['matches art direction'],
    sourceStrategy: 'public_search',
  },
  {
    id: 'local-model',
    category: '3d',
    purpose: 'Existing local model',
    quantity: 1,
    priority: 'medium',
    specification: 'glTF model',
    targetPath: 'assets/3d/local-model.glb',
    acceptanceRubric: ['opens without errors'],
    sourceStrategy: 'local_import',
  },
  {
    id: 'generated-key-art',
    category: '2d',
    purpose: 'Generated key art',
    quantity: 1,
    priority: 'medium',
    specification: '4k key art',
    targetPath: 'assets/2d/key-art.png',
    acceptanceRubric: ['matches direction'],
    sourceStrategy: 'dreamina',
  },
];

function response(itemId: string) {
  return JSON.stringify({
    candidates: [{
      id: `${itemId}-candidate`,
      bomItemId: itemId,
      title: `${itemId} candidate`,
      provider: 'public-web',
      sourceUrl: 'https://example.test/asset',
      format: 'png',
      sizeBytes: 1024,
      estimatedCost: { currency: 'USD', amount: 0 },
      risk: [],
      provenance: [{
        source: 'https://example.test/asset',
        license: 'CC0-1.0',
        attribution: 'Example author',
        transferability: 'allowed',
      }],
    }],
  });
}

describe('asset candidate discovery', () => {
  it('dispatches read-only workers and never sends Dreamina generation to discovery', () => {
    const tasks = buildAssetCandidateDiscoveryTasks('run-1', items, 'parent-1');

    expect(tasks.map((task) => task.data.item.id)).toEqual(['public-icon', 'local-model']);
    for (const task of tasks) {
      expect(task).toMatchObject({
        profileName: 'explore',
        runInBackground: false,
        timeout: ASSET_DISCOVERY_TIMEOUT_MS,
        enforceDispatch: true,
        dispatch: {
          readOnly: true,
          discardChanges: true,
          internalOnly: true,
        },
      });
      expect(task.dispatch?.workCard?.forbiddenScope).toEqual(['**/*']);
    }
    expect(tasks[0]?.dispatch?.allowedTools).toEqual([
      'Read', 'Grep', 'Glob', 'ReadMediaFile', 'WebSearch', 'FetchURL',
    ]);
    expect(tasks[1]?.dispatch?.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'ReadMediaFile']);
  });

  it('rejects malformed or unsafe candidate responses instead of repairing or guessing', () => {
    expect(normalizeAssetCandidateDiscoveryResponse('public-icon', '{bad')).toEqual({
      candidates: [],
      reason: 'worker response is not valid JSON',
    });
    expect(normalizeAssetCandidateDiscoveryResponse('public-icon', JSON.stringify({
      candidates: [{
        id: 'candidate',
        bomItemId: 'public-icon',
        title: 'Unknown-license icon',
        provider: 'web',
        risk: [],
        provenance: [{ source: 'unknown', transferability: 'unknown' }],
      }],
    }))).toMatchObject({ candidates: [], reason: expect.stringContaining('invalid or unsafe') });
  });

  it('returns each unavailable worker as an explicit fallback item', async () => {
    const runQueued = vi.fn(async (tasks: ReturnType<typeof buildAssetCandidateDiscoveryTasks>) => tasks.map((task, index) => ({
      task,
      status: index === 0 ? 'completed' as const : 'failed' as const,
      result: index === 0 ? response(task.data.item.id) : undefined,
      error: index === 0 ? undefined : 'provider quota exhausted',
    })));

    const results = await runAssetCandidateDiscovery(
      { runQueued } as never,
      'run-1',
      items,
      'parent-1',
    );

    expect(results[0]).toMatchObject({ status: 'completed', candidates: [{ id: 'public-icon-candidate' }] });
    expect(results[1]).toMatchObject({ status: 'unavailable', reason: 'provider quota exhausted', candidates: [] });
  });
});
