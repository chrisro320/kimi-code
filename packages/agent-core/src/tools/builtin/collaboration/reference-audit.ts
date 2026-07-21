import { z } from 'zod';

import type { Agent } from '../../../agent';
import type { BuiltinTool } from '../../../agent/tool';
import { isAbortError } from '../../../loop/errors';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import {
  assembleReferenceAuditTrackResults,
  buildReferenceAuditPlan,
  classifyReferenceAudit,
  hashReferenceAuditPlan,
  hashReferenceAuditResult,
  hashReferenceSet,
  runReferenceAuditTracks,
  type ReferenceAuditRequest,
} from '../../../reference-audit';
import { redactUntrustedRaw, redactUntrustedValue } from '../../../security/redaction';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';

const ReferenceAuditRouteSchema = z.object({
  backend: z.literal('kimi'),
  model: z.string().trim().min(1).optional(),
});

const ReferenceDescriptorSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  kind: z.enum(['product', 'project', 'repository', 'link', 'media']),
  role: z.enum(['behavioral', 'visual', 'technical', 'mixed']),
  location: z.string().trim().min(1).optional(),
  trivial: z.boolean().optional(),
});

export const ReferenceAuditToolInputSchema = z.object({
  references: z.array(ReferenceDescriptorSchema),
  cross_product_mashup: z.boolean().optional(),
  jointly_define_target: z.boolean().optional(),
  explicit_narrow_question: z.string().trim().min(1).optional(),
  requested_intensity: z.enum(['standard', 'deep', 'targeted']).optional(),
  role_routes: z.object({
    source_explore: ReferenceAuditRouteSchema.optional(),
    public_research: ReferenceAuditRouteSchema.optional(),
  }).optional(),
});

export type ReferenceAuditToolInput = z.infer<typeof ReferenceAuditToolInputSchema>;

/**
 * Explicit reference/prior-art audit primitive. It only classifies, plans,
 * dispatches read-only tracks, and returns the assembled audit — it never
 * materializes Trellis tasks or edits the workspace itself.
 */
export class ReferenceAuditTool implements BuiltinTool<ReferenceAuditToolInput> {
  readonly name = 'ReferenceAudit' as const;
  readonly description = [
    'Run a read-only reference/prior-art audit over caller-supplied products, projects, repositories, links, or media.',
    'Classifies whether an audit is material, plans evidence-gathering tracks, dispatches independent read-only subagents per track, and returns claims, contradictions, unknowns, and license notes.',
    'It never edits files, never contacts non-public/restricted systems, and never materializes Trellis tasks itself — the caller decides what to do with the audit.',
  ].join(' ');
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReferenceAuditToolInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly records?: Agent['records'],
  ) {}

  resolveExecution(args: ReferenceAuditToolInput): ToolExecution {
    return {
      description: `Running reference audit across ${args.references.length} reference(s)`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'agent_call',
        agent_name: 'ReferenceAudit',
        prompt: args.explicit_narrow_question ?? `Audit ${args.references.length} reference(s)`,
      },
      approvalRule: this.name,
      execute: (context) => this.execution(args, context),
    };
  }

  private async execution(
    args: ReferenceAuditToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const runId = context.toolCallId;
    const request = toRequest(args);
    let triggered = false;
    try {
      context.signal.throwIfAborted();
      const decision = classifyReferenceAudit(request);
      if (!decision.triggered) {
        this.records?.logRecord({
          type: 'reference_audit.run',
          runId,
          triggered: false,
          reason: decision.reason,
          tracks: [],
          terminalState: 'skipped',
        });
        return { output: JSON.stringify({ triggered: false, reason: decision.reason }) };
      }

      triggered = true;
      const plan = buildReferenceAuditPlan(request, decision);
      const referenceHash = hashReferenceSet(plan.references);
      const safeReferences = redactUntrustedValue(plan.references);
      this.records?.logRecord({ type: 'reference_audit.state', material: true, references: safeReferences as typeof plan.references, referenceHash });
      const trackResults = await runReferenceAuditTracks(
        this.subagentHost,
        plan,
        context.toolCallId,
        context.signal,
        {
          'source-explore': args.role_routes?.source_explore,
          'public-research': args.role_routes?.public_research,
        },
      );
      context.signal.throwIfAborted();
      const assembledResult = assembleReferenceAuditTrackResults(plan, trackResults);
      const result = redactUntrustedValue(assembledResult) as typeof assembledResult;
      const resultHash = hashReferenceAuditResult(result);
      const fallbackTracks = trackResults.flatMap((entry) => {
        if (entry.normalization.status === 'completed') return [];
        const track = plan.tracks.find((candidate) => candidate.id === entry.trackId)!;
        const reason = entry.normalization.status === 'unavailable'
          ? entry.normalization.reason
          : 'track report remained malformed after one contract repair';
        return [{
          trackId: track.id,
          label: track.label,
          workflowRole: track.workflowRole,
          referenceIds: track.referenceIds,
          dimensions: track.dimensions,
          originalPrompt: redactUntrustedValue(track.prompt) as string,
          reason: redactUntrustedValue(reason) as string,
        }];
      });
      this.records?.logRecord({
        type: 'reference_audit.run',
        runId,
        triggered: true,
        intensity: plan.classification.intensity,
        referenceHash,
        planHash: hashReferenceAuditPlan(plan),
        resultHash,
        tracks: trackResults.map((entry) => ({
          trackId: entry.trackId,
          workflowRole: plan.tracks.find((track) => track.id === entry.trackId)!.workflowRole,
          status: entry.normalization.status === 'completed' ? 'completed' as const : 'unavailable' as const,
          repairCount: entry.repairCount,
          reason: entry.normalization.status === 'unavailable' ? entry.normalization.reason : undefined,
        })),
        claimCount: result.claims.length,
        contradictionCount: result.contradictions.length,
        unknownCount: result.unknowns.length,
        licenseNoteCount: result.licenseNotes.length,
        rawResponses: trackResults.map((entry) => {
          const initial = redactUntrustedRaw(entry.initialRawResponse);
          const repair = entry.repairRawResponse === undefined ? undefined : redactUntrustedRaw(entry.repairRawResponse);
          const redactionCount = initial.redactionCount + (repair?.redactionCount ?? 0);
          return {
            trackId: entry.trackId,
            initial: initial.redacted,
            repair: repair?.redacted,
            summary: redactionCount > 0 ? `redacted ${String(redactionCount)} secret pattern(s)` : 'no secrets redacted',
            redactionCount,
            originalSha256: initial.originalSha256,
            redactedSha256: initial.redactedSha256,
          };
        }),
        result: redactUntrustedValue(result) as typeof result,
        terminalState: fallbackTracks.length > 0 ? 'fallback_required' : 'completed',
      });
      return {
        output: JSON.stringify({
          triggered: true,
          fallbackRequired: fallbackTracks.length > 0,
          fallbackPolicy: fallbackTracks.length > 0
            ? 'Main model must cover each missing track with permitted tools, label it main-model fallback, preserve unknowns, and never count it as independent consensus.'
            : undefined,
          fallbackTracks,
          intensity: plan.classification.intensity,
          classificationReason: plan.classification.reason,
          narrowQuestion: plan.classification.intensity === 'targeted' ? plan.classification.narrowQuestion : undefined,
          tracks: trackResults.map((entry) => ({
            trackId: entry.trackId,
            status: entry.normalization.status,
            repairCount: entry.repairCount,
          })),
          result: redactUntrustedValue(result),
        }),
      };
    } catch (error) {
      if (isAbortError(error) || context.signal.aborted) {
        this.records?.logRecord({
          type: 'reference_audit.run',
          runId,
          triggered,
          tracks: [],
          terminalState: 'aborted',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.records?.logRecord({
        type: 'reference_audit.run',
        runId,
        triggered,
        tracks: [],
        terminalState: triggered ? 'fallback_required' : 'failed',
        error: reason,
      });
      if (triggered) {
        return {
          output: JSON.stringify({
            triggered: true,
            fallbackRequired: true,
            fallbackPolicy: 'The audit runtime failed before producing track results. The main model must continue with its permitted tools, label all findings main-model fallback, preserve unknowns, and never count them as independent consensus.',
            fallbackTracks: [{
              trackId: 'audit-runtime',
              label: 'Reference audit runtime',
              workflowRole: 'source-explore',
              referenceIds: args.references.map((reference) => reference.id),
              dimensions: [],
              reason,
            }],
          }),
        };
      }
      return {
        output: `Reference audit unavailable: ${reason}`,
        isError: true,
      };
    }
  }
}

function toRequest(args: ReferenceAuditToolInput): ReferenceAuditRequest {
  return {
    references: args.references,
    crossProductMashup: args.cross_product_mashup,
    jointlyDefineTarget: args.jointly_define_target,
    explicitNarrowQuestion: args.explicit_narrow_question,
    requestedIntensity: args.requested_intensity,
  };
}
