import { z } from 'zod';

import type { SwarmMode } from '../../../agent/swarm';
import { isEditingCapableProfile } from '../../../agent/dispatch/profile';
import type { DispatchWorkCard } from '../../../agent/dispatch/controller';
import { normalizeScopeList, scopesOverlap } from '../../../agent/dispatch/scope';
import type { Agent } from '../../../agent';
import type { BuiltinTool } from '../../../agent/tool';
import { requireReferenceAuditForEditing } from '../../../reference-audit';
import type { ResolvedAgentProfile } from '../../../profile';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  type QueuedSubagentTask,
  type SessionSubagentHost,
} from '../../../session/subagent-host';
import { isExternalSubagentId } from '../../../session/subagent-routing';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import AGENT_SWARM_DESCRIPTION from './agent-swarm.md?raw';

const DEFAULT_SUBAGENT_TYPE = 'coder';
const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
const MAX_AGENT_SWARM_SUBAGENTS = 128;

export const AgentSwarmToolInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .describe('Short description for the whole swarm.'),
    subagent_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.',
      ),
    model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Model alias used for item-based new spawns only. Resume entries ignore this parameter and align to the parent agent\'s current model when they continue.',
      ),
    prompt_template: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
      ),
    items: z
      .array(z.string().trim().min(1))
      .max(MAX_AGENT_SWARM_SUBAGENTS)
      .optional()
      .describe(
        `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent.`,
      ),
    resume_agent_ids: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .optional()
      .describe(
        'Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.',
      ),
    item_dispatch: z
      .record(
        z.string(),
        z.object({
          reference_dependent: z.boolean().optional(),
          reference_override_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
          rationale: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe('Why this item is delegated instead of done directly.'),
          scope: z
            .array(z.string().trim().min(1))
            .optional()
            .describe(
              'Workspace-relative files/directories/globs this item may change. Required for an editing subagent_type; must not overlap another item\'s scope.',
            ),
          work_card: z
            .object({
              id: z.string().trim().min(1),
              title: z.string().trim().min(1),
              goal: z.string().trim().min(1),
              dependencies: z.array(z.string().trim().min(1)).optional(),
              acceptance: z.string().trim().min(1),
              forbidden_scope: z.array(z.string().trim().min(1)).optional(),
              route_override: z
                .object({
                  backend: z.string().trim().min(1),
                  model: z.string().trim().min(1).optional(),
                })
                .optional(),
            })
            .optional(),
        }),
      )
      .optional()
      .describe(
        'Optional per-item dispatch metadata keyed by the exact item value, for new item-based spawns only.',
      ),
  })
  .strict();

export type AgentSwarmToolInput = z.infer<typeof AgentSwarmToolInputSchema>;

interface AgentSwarmSpawnSpec {
  readonly kind: 'spawn';
  readonly index: number;
  readonly item: string;
  readonly prompt: string;
  readonly dispatch?: {
    readonly rationale?: string;
    readonly scope?: readonly string[];
    readonly workCard?: DispatchWorkCard;
  };
}

interface AgentSwarmResumeSpec {
  readonly kind: 'resume';
  readonly index: number;
  readonly agentId: string;
  readonly item?: string;
  readonly prompt: string;
}

type AgentSwarmSpec = AgentSwarmSpawnSpec | AgentSwarmResumeSpec;

interface SwarmRunResult {
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  readonly resumable?: boolean;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly error?: string;
}

export class AgentSwarmTool implements BuiltinTool<AgentSwarmToolInput> {
  readonly name = 'AgentSwarm' as const;
  readonly description = AGENT_SWARM_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentSwarmToolInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly swarmMode: SwarmMode,
    // `0` = no timeout, preserved on purpose (`0 ?? DEFAULT` stays `0`);
    // SubagentBatch arms no timer for non-positive timeouts.
    private readonly subagentTimeoutMs?: number,
    private readonly subagents?: ResolvedAgentProfile['subagents'],
    private readonly records?: Agent['records'],
  ) {}

  resolveExecution(args: AgentSwarmToolInput): ToolExecution {
    const agentCount = (args.items?.length ?? 0) + Object.keys(args.resume_agent_ids ?? {}).length;
    return {
      accesses: ToolAccesses.all(),
      description: `Launching agent swarm: ${args.description}`,
      display: {
        kind: 'agent_call',
        agent_name: `swarm (${agentCount} subagents)`,
        prompt: args.description,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AgentSwarmToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const referenceDispatches = Object.values(args.item_dispatch ?? {}).filter((dispatch) => dispatch.reference_dependent === true);
      if (referenceDispatches.length > 0) {
        if (this.records === undefined) throw new Error('Reference-dependent editing swarm requires durable agent records.');
        const hashes = new Set(referenceDispatches.map((dispatch) => dispatch.reference_override_hash));
        if (hashes.size > 1) throw new Error('Reference-dependent swarm items must share one approved reference override.');
        requireReferenceAuditForEditing(this.records, referenceDispatches[0]?.reference_override_hash, context.toolCallId);
      }
      this.swarmMode.enter('tool');
      const result = await this.runSwarm(args, context.signal, context.toolCallId);
      return {
        output: result,
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private async runSwarm(
    args: AgentSwarmToolInput,
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<string> {
    const profileName = normalizeOptionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE;
    const specs = createAgentSwarmSpecs(args, (agentId) => this.subagentHost.getSwarmItem(agentId));
    const spawnSpecs = specs.filter((spec): spec is AgentSwarmSpawnSpec => spec.kind === 'spawn');
    validateSpawnDispatch(
      spawnSpecs,
      profileName,
      this.subagents,
      args.subagent_type !== undefined || spawnSpecs.some((spec) => spec.dispatch !== undefined),
    );
    const orderedSpecs = [
      ...specs.filter((spec): spec is AgentSwarmResumeSpec => spec.kind === 'resume'),
      ...orderSpawnSpecsByDependencies(spawnSpecs),
    ];
    const tasks = orderedSpecs.map((spec): QueuedSubagentTask<AgentSwarmSpec> => {
      const descriptionName = spec.kind === 'resume' ? 'resume' : profileName;
      const common = {
        data: spec,
        profileName: spec.kind === 'resume' ? 'subagent' : profileName,
        parentToolCallId: toolCallId,
        prompt: spec.prompt,
        description: childDescription(args.description, spec.index, descriptionName),
        swarmIndex: spec.index,
        runInBackground: false,
        swarmItem: spec.item,
        signal,
        timeout: this.subagentTimeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
      };
      if (spec.kind === 'resume') {
        return {
          ...common,
          kind: 'resume',
          resumeAgentId: spec.agentId,
        };
      }
      return {
        ...common,
        kind: 'spawn',
        modelAlias: args.model,
        dispatch: spec.dispatch,
        enforceDispatch: true,
      };
    });
    const results = await this.subagentHost.runQueued(tasks);
    return renderSwarmResults(results.map(({ task, ...result }) => ({ spec: task.data, ...result })));
  }
}

function createAgentSwarmSpecs(
  args: AgentSwarmToolInput,
  getResumeItem: (agentId: string) => string | undefined,
): AgentSwarmSpec[] {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(([agentId, prompt]) => ({
    agentId: agentId.trim(),
    prompt: prompt.trim(),
  }));
  const items = (args.items ?? []).map((item) => item.trim());
  const itemCount = items.length;
  const resumeCount = resumeEntries.length;
  const totalCount = resumeCount + itemCount;
  if (!hasMinimumAgentSwarmInputs(itemCount, resumeCount)) {
    throw new Error('AgentSwarm requires at least 2 items unless resume_agent_ids is provided.');
  }
  if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error(`AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`);
  }
  const promptTemplate = normalizeOptionalString(args.prompt_template);
  if (items.length > 0 && promptTemplate === undefined) {
    throw new Error('prompt_template is required when items are provided.');
  }
  if (promptTemplate !== undefined && !promptTemplate.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new Error(
      `prompt_template must include the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
    );
  }

  const seenPrompts = new Map<string, number>();
  const specs: AgentSwarmSpec[] = [];
  for (const entry of resumeEntries) {
    specs.push({
      kind: 'resume',
      index: specs.length + 1,
      agentId: entry.agentId,
      item: getResumeItem(entry.agentId),
      prompt: entry.prompt,
    });
  }
  if (items.length > 0) {
    const itemPromptTemplate = promptTemplate!;
    items.forEach((item, index) => {
      const prompt = itemPromptTemplate.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item);
      const previousIndex = seenPrompts.get(prompt);
      if (previousIndex !== undefined) {
        throw new Error(
          `Duplicate subagent prompts from items ${String(previousIndex)} and ${String(index + 1)}. AgentSwarm requires distinct subagents.`,
        );
      }
      seenPrompts.set(prompt, index + 1);
      const itemDispatch = args.item_dispatch?.[item];
      specs.push({
        kind: 'spawn',
        index: specs.length + 1,
        item,
        prompt,
        dispatch:
          itemDispatch === undefined
            ? undefined
            : {
                 rationale: itemDispatch.rationale,
                 scope: itemDispatch.scope,
                 workCard:
                   itemDispatch.work_card === undefined
                     ? undefined
                     : {
                         id: itemDispatch.work_card.id,
                         title: itemDispatch.work_card.title,
                         goal: itemDispatch.work_card.goal,
                         dependencies: itemDispatch.work_card.dependencies,
                         acceptance: itemDispatch.work_card.acceptance,
                         forbiddenScope: itemDispatch.work_card.forbidden_scope,
                         routeOverride: itemDispatch.work_card.route_override,
                       },
               },
      });
    });
  }

  return specs;
}

function orderSpawnSpecsByDependencies(
  specs: readonly AgentSwarmSpawnSpec[],
): AgentSwarmSpawnSpec[] {
  const byCardId = new Map<string, AgentSwarmSpawnSpec>();
  for (const spec of specs) {
    const card = spec.dispatch?.workCard;
    if (card === undefined) continue;
    if (byCardId.has(card.id)) {
      throw new Error(`AgentSwarm contains duplicate work-card id "${card.id}".`);
    }
    byCardId.set(card.id, spec);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: AgentSwarmSpawnSpec[] = [];
  const visit = (spec: AgentSwarmSpawnSpec): void => {
    const card = spec.dispatch?.workCard;
    if (visited.has(spec.item)) return;
    if (card === undefined) {
      visited.add(spec.item);
      ordered.push(spec);
      return;
    }
    if (visiting.has(spec.item)) {
      throw new Error(`AgentSwarm work-card dependency cycle includes "${card.id}".`);
    }
    visiting.add(spec.item);
    for (const dependency of card.dependencies ?? []) {
      const dependencySpec = byCardId.get(dependency);
      if (dependencySpec === undefined) {
        throw new Error(
          `AgentSwarm work-card "${card.id}" references unknown batch dependency "${dependency}".`,
        );
      }
      visit(dependencySpec);
    }
    visiting.delete(spec.item);
    visited.add(spec.item);
    ordered.push(spec);
  };

  for (const spec of specs) visit(spec);
  return ordered;
}

function validateSpawnDispatch(
  specs: readonly AgentSwarmSpawnSpec[],
  profileName: string,
  subagents: ResolvedAgentProfile['subagents'] | undefined,
  enforceScope: boolean,
): void {
  const profile = subagents?.[profileName];
  // Legacy AgentSwarm callers without dispatch metadata keep the historical
  // homogeneous launch contract. New editing dispatches opt into scope checks
  // through item_dispatch; the host still enforces any supplied scope.
  if (profile === undefined || !enforceScope) return;
  const editing = isEditingCapableProfile(profile);
  if (!editing) return;

  const normalizedScopes: Array<{ item: string; scope: readonly string[] }> = [];
  for (const spec of specs) {
    const rawScope = spec.dispatch?.scope ?? [];
    if (rawScope.length === 0) {
      throw new Error(
        `AgentSwarm item "${spec.item}" requires a non-empty scope for editing profile "${profileName}".`,
      );
    }
    const normalized = normalizeScopeList(rawScope);
    if (!normalized.ok) {
      throw new Error(`AgentSwarm item "${spec.item}" has invalid scope: ${normalized.message}`);
    }
    normalizedScopes.push({ item: spec.item, scope: normalized.value });
  }
  for (let i = 0; i < normalizedScopes.length; i += 1) {
    for (let j = i + 1; j < normalizedScopes.length; j += 1) {
      if (scopesOverlap(normalizedScopes[i]!.scope, normalizedScopes[j]!.scope)) {
        throw new Error(
          `AgentSwarm item scopes overlap: "${normalizedScopes[i]!.item}" and "${normalizedScopes[j]!.item}".`,
        );
      }
    }
  }
}

function hasMinimumAgentSwarmInputs(itemCount: number, resumeCount: number): boolean {
  return resumeCount > 0 || itemCount >= 2;
}

function childDescription(swarmDescription: string, index: number, profileName: string): string {
  return `${swarmDescription} #${String(index)} (${profileName})`;
}

function renderSwarmResults(results: readonly SwarmRunResult[]): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const aborted = results.filter((result) => result.status === 'aborted').length;
  const shouldRenderResumeHint = results.some(
    (result) =>
      result.status !== 'completed' &&
      result.agentId !== undefined &&
      (result.resumable === true || !isExternalSubagentId(result.agentId)),
  );
  const lines = [
    '<agent_swarm_result>',
    `<summary>${renderSwarmSummary(completed, failed, aborted)}</summary>`,
  ];

  if (shouldRenderResumeHint) {
    lines.push(
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
    );
  }

  for (const result of results) {
    const agentId = result.agentId === undefined ? '' : ` agent_id="${result.agentId}"`;
    const mode = result.spec.kind === 'resume' ? ' mode="resume"' : '';
    const item = result.spec.item === undefined ? '' : ` item="${escapeXmlAttribute(result.spec.item)}"`;
    const state = result.state === undefined ? '' : ` state="${result.state}"`;
    const body = result.status === 'completed' ? (result.result ?? '') : (result.error ?? 'unknown error');
    lines.push(
      `<subagent${mode}${agentId}${item}${state} outcome="${result.status}">${body}</subagent>`,
    );
  }

  lines.push('</agent_swarm_result>');
  return lines.join('\n');
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function renderSwarmSummary(completed: number, failed: number, aborted = 0): string {
  const parts: string[] = [];
  if (completed > 0) parts.push(`completed: ${String(completed)}`);
  if (failed > 0) parts.push(`failed: ${String(failed)}`);
  if (aborted > 0) parts.push(`aborted: ${String(aborted)}`);
  return parts.join(', ');
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
