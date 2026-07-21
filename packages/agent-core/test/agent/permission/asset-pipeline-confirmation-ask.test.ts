import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import type { PermissionPolicyContext } from '../../../src/agent/permission';
import { AssetPipelineConfirmationAskPermissionPolicy } from '../../../src/agent/permission/policies/asset-pipeline-confirmation-ask';
import { hashAssetBatchConfirmation, type AssetCandidateExecutionPolicy } from '../../../src/asset-pipeline';
import { ToolAccesses } from '../../../src/loop';

const candidate = {
  id: 'candidate-1',
  bomItemId: 'icon-asset',
  title: 'Icon',
  provider: 'public-web',
  sourceUrl: 'https://example.test/icon.png',
  format: 'png',
  estimatedCost: { currency: 'USD', amount: 0 },
  risk: [],
  provenance: [{ source: 'https://example.test/icon.png', license: 'CC0', transferability: 'allowed' as const }],
};
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
const confirmation = {
  runId: 'run-1',
  candidateIds: ['candidate-1'],
  approvedBy: 'user' as const,
  approvedAt: '2026-07-20T00:00:00.000Z',
  quantityLimit: 1,
  costLimit: { currency: 'USD', max: 0 },
  direction: 'clean survival icon',
};

function context(action = 'prepare_execution'): PermissionPolicyContext {
  const args = {
    action,
    run_id: 'run-1',
    candidates: [candidate],
    confirmation,
    candidate_policies: [executionPolicy],
  };
  return {
    turnId: '0',
    stepNumber: 1,
    signal: new AbortController().signal,
    llm: {},
    args,
    toolCall: {
      type: 'function',
      id: 'call-assets',
      name: 'AssetPipeline',
      arguments: JSON.stringify(args),
    } satisfies ToolCall,
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: 'AssetPipeline',
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

function policy(withApproval = true) {
  return new AssetPipelineConfirmationAskPermissionPolicy({
    rpc: withApproval ? { requestApproval: async () => ({ decision: 'approved' as const }) } : undefined,
  } as never);
}

describe('AssetPipelineConfirmationAskPermissionPolicy', () => {
  it('ignores non-execution actions and unrelated tools', () => {
    expect(policy().evaluate(context('validate_bom'))).toBeUndefined();
    const other = context();
    expect(policy().evaluate({ ...other, toolCall: { ...other.toolCall, name: 'Bash' } })).toBeUndefined();
  });

  it('fails closed without an approval surface', () => {
    expect(policy(false).evaluate(context())).toMatchObject({
      kind: 'deny',
      message: expect.stringContaining('interactive user approval surface'),
    });
  });

  it('binds approval metadata to the exact candidate snapshot and limits', () => {
    const result = policy().evaluate(context());
    if (result?.kind !== 'ask') throw new Error('expected ask');
    expect(result.resolveApproval?.({ decision: 'approved' })).toEqual({
      kind: 'approve',
      executionMetadata: {
        assetBatchConfirmed: true,
        assetBatchConfirmationHash: hashAssetBatchConfirmation({
          runId: 'run-1',
          candidates: [candidate],
          confirmation,
          policies: [executionPolicy],
        }),
      },
    });
    expect(result.resolveApproval?.({ decision: 'rejected' })).toBeUndefined();
  });
});
