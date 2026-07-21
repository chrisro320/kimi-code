import type { Agent } from '../..';
import { hashAssetBatchConfirmation, type AssetBatchConfirmation, type AssetCandidate, type AssetCandidateExecutionPolicy } from '../../../asset-pipeline';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
interface AssetPipelinePermissionArgs { readonly action?: unknown; readonly run_id?: unknown; readonly candidates?: unknown; readonly confirmation?: unknown; readonly candidate_policies?: unknown; }
export class AssetPipelineConfirmationAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'asset-pipeline-confirmation-ask';
  constructor(private readonly agent: Agent) {}
  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'AssetPipeline') return;
    const args = context.args as AssetPipelinePermissionArgs | undefined;
    if (args?.action !== 'prepare_execution') return;
    if (this.agent.rpc?.requestApproval === undefined) return { kind: 'deny', message: 'Asset execution requires an interactive user approval surface; this session cannot confirm the batch.' };
    if (typeof args.run_id !== 'string' || !Array.isArray(args.candidates) || !Array.isArray(args.candidate_policies) || args.confirmation === null || typeof args.confirmation !== 'object') return { kind: 'deny', message: 'Asset execution requires a complete candidate batch, execution policies, and confirmation packet before approval.' };
    let confirmationHash: string;
    try { confirmationHash = hashAssetBatchConfirmation({ runId: args.run_id, candidates: args.candidates as readonly AssetCandidate[], confirmation: args.confirmation as AssetBatchConfirmation, policies: args.candidate_policies as readonly AssetCandidateExecutionPolicy[] }); } catch (error) { return { kind: 'deny', message: `Asset execution confirmation packet is invalid: ${error instanceof Error ? error.message : String(error)}` }; }
    return { kind: 'ask', resolveApproval: (response) => response.decision === 'approved' ? { kind: 'approve', executionMetadata: { assetBatchConfirmed: true, assetBatchConfirmationHash: confirmationHash } } : undefined };
  }
}
