import { describe, expect, it, vi } from 'vitest';

import { hashAssetBatchConfirmation, REQUIRED_GAME_ASSET_CATEGORIES, type AssetCandidateExecutionPolicy } from '../src/asset-pipeline';
import { AssetPipelineTool } from '../src/tools/builtin/collaboration/asset-pipeline';

const executionPolicy: AssetCandidateExecutionPolicy = {
  candidateId: 'candidate-1',
  operationKind: 'public_download',
  allowedDomains: ['example.test'],
  allowedLicenses: ['CC0'],
  maxTotalSizeBytes: 64 * 1024,
  allowedExtensions: ['png'],
  allowedMimeTypes: ['image/png'],
  checksum: { mode: 'record_actual' },
};

const bom = REQUIRED_GAME_ASSET_CATEGORIES.map((category) => ({
  id: `${category}-asset`,
  category,
  purpose: `${category} asset`,
  quantity: 1,
  priority: 'medium' as const,
  specification: `Production ${category}`,
  targetPath: `assets/${category}/asset`,
  acceptanceRubric: ['matches direction'],
  sourceStrategy: 'public_search' as const,
}));

async function execute(
  args: Parameters<AssetPipelineTool['resolveExecution']>[0],
  tool = new AssetPipelineTool(),
  metadata?: Record<string, unknown>,
) {
  const execution = tool.resolveExecution(args);
  if ('isError' in execution && execution.isError === true) throw new Error(execution.message);
  return execution.execute({
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    metadata,
    signal: new AbortController().signal,
  });
}

describe('AssetPipelineTool', () => {
  it('validates the complete BOM without side effects', async () => {
    const result = await execute({ action: 'validate_bom', run_id: 'run-1', bom });
    expect(JSON.parse(result.output as string)).toMatchObject({ validation: { complete: true } });
  });

  it('requires permission-bound user confirmation and dispatches one bounded internal frontend-artist', async () => {
    const candidate = {
      id: 'candidate-1',
      bomItemId: 'icon-asset',
      title: 'Icon',
      sourceUrl: 'https://example.test/icon.png',
      provider: 'public-web',
      format: 'png',
      estimatedCost: { currency: 'USD', amount: 0 },
      risk: [],
      provenance: [{ source: 'https://example.test/icon.png', license: 'CC0', transferability: 'allowed' as const }],
    };
    const confirmation = {
      runId: 'run-1',
      candidateIds: ['candidate-1'],
      approvedBy: 'user' as const,
      approvedAt: '2026-07-20T00:00:00.000Z',
      quantityLimit: 1,
      costLimit: { currency: 'USD', max: 0 },
    };
    const args = {
      action: 'prepare_execution' as const,
      run_id: 'run-1',
      bom,
      candidates: [candidate],
      confirmation,
      candidate_policies: [executionPolicy] as Parameters<AssetPipelineTool['resolveExecution']>[0]['candidate_policies'],
    };
    const blocked = await execute(args);
    expect(blocked).toMatchObject({ isError: true });
    expect(blocked.output).toContain('interactive user approval');

    const confirmationHash = hashAssetBatchConfirmation({
      runId: 'run-1',
      candidates: [candidate],
      confirmation,
      policies: [executionPolicy],
    });
    const runQueued = vi.fn(async (tasks: readonly unknown[]) => [{
      task: tasks[0],
      agentId: 'artist-1',
      status: 'completed' as const,
      result: JSON.stringify({
        schemaVersion: 1,
        runId: 'run-1',
        confirmationHash,
        operations: [{
          id: 'operation-1',
          candidateId: 'candidate-1',
          bomItemId: 'icon-asset',
          kind: 'public_download',
          provider: 'public-web',
          state: 'unavailable',
          stagingPath: 'assets/_staging/run-1/icon-asset/candidate-1.png',
          error: 'provider unavailable',
        }],
        artifacts: [],
      }),
    }]);
    const directoryStat = { stMode: 0o040755, stIno: 1, stDev: 1, stNlink: 1, stUid: 0, stGid: 0, stSize: 0, stAtime: 0, stMtime: 0, stCtime: 0 };
    const runtime = {
      cwd: '/workspace',
      kaos: {
        stat: vi.fn(async () => directoryStat),
        readBytes: vi.fn(),
        iterdir: async function* () {},
        mkdir: vi.fn(),
      },
    };
    const ready = await execute(
      args,
      new AssetPipelineTool({ runQueued } as never, undefined, runtime as never),
      { assetBatchConfirmed: true, assetBatchConfirmationHash: confirmationHash },
    );
    const output = JSON.parse(ready.output as string);
    expect(output.execution).toMatchObject({ status: 'unavailable', artifacts: [] });
    expect(ready.isError).toBe(true);
    expect(output).not.toHaveProperty('agentId');
    expect(output).not.toHaveProperty('result');
    expect(runQueued).toHaveBeenCalledWith([
      expect.objectContaining({
        profileName: 'frontend-artist',
        enforceDispatch: true,
        dispatch: expect.objectContaining({
          internalOnly: true,
          scope: ['assets/_staging/run-1/**'],
          allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'ReadMediaFile', 'Skill'],
        }),
      }),
    ]);
  });

  it('runs read-only candidate discovery and persists raw plus normalized artifacts', async () => {
    const runQueued = vi.fn(async (tasks: readonly { data: { item: { id: string } } }[]) => tasks.map((task) => ({
      task,
      status: 'completed' as const,
      result: JSON.stringify({
        candidates: [{
          id: `${task.data.item.id}-candidate`,
          bomItemId: task.data.item.id,
          title: 'Licensed candidate',
          provider: 'public-web',
          sourceUrl: 'https://example.test/asset.png',
          risk: [],
          provenance: [{
            source: 'https://example.test/asset.png',
            license: 'CC0-1.0',
            transferability: 'allowed',
          }],
        }],
      }),
    })));
    const records = { logRecord: vi.fn() };
    const tool = new AssetPipelineTool({ runQueued } as never, records as never);

    const result = await execute({ action: 'discover_candidates', run_id: 'run-1', bom }, tool);
    const output = JSON.parse(result.output as string);

    expect(output.fallbackRequired).toBe(false);
    expect(output.candidates).toHaveLength(bom.length);
    expect(runQueued).toHaveBeenCalledTimes(1);
    expect(records.logRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'asset_pipeline.run',
      action: 'discover_candidates',
      terminalState: 'completed',
      candidates: expect.any(Array),
      rawDiscoveryResponses: expect.arrayContaining([
        expect.objectContaining({ status: 'completed', response: expect.any(String) }),
      ]),
    }));
  });

  it('returns a main-model fallback packet when discovery has no subagent host', async () => {
    const result = await execute({ action: 'discover_candidates', run_id: 'run-1', bom });
    const output = JSON.parse(result.output as string);

    expect(output.fallbackRequired).toBe(true);
    expect(output.fallbackPolicy).toContain('main-model fallback');
    expect(output.fallbackItems).toHaveLength(bom.length);
  });
});
