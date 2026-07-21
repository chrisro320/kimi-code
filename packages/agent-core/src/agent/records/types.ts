import type { ContentPart, ThinkingEffort, TokenUsage } from '@moonshot-ai/kosong';

import type { LoopRecordedEvent } from '../../loop';
import type { GoalActor, GoalBudgetLimits, GoalStatus } from '../goal';
import type { MCPToolDefinition } from '../../mcp/types';
import type { ToolStoreUpdate } from '../../tools/store';
import type { CompactionBeginData, CompactionResult } from '../compaction';
import type { AgentConfigUpdateData } from '../config';
import type { ContextMessage, PromptOrigin } from '../context';
import type { PermissionApprovalResultRecord, PermissionMode } from '../permission';
import type { McpToolCollision, UserToolRegistration } from '../tool';
import type { UsageRecordScope } from '../usage';
import type { SwarmModeTrigger } from '../swarm';
import type { DispatchMode } from '../dispatch/mode';
import type { AgoraNecessityDecision } from '../../agora/types';
import type { AgoraLifecyclePhase } from '../../agora/lifecycle';
import type {
  ReferenceAuditIntensity,
  ReferenceAuditResult,
  ReferenceAuditWorkflowRole,
} from '../../reference-audit/types';
import type {
  AssetBomItem,
  AssetCandidate,
  VerifiedAssetExecutionResult,
} from '../../asset-pipeline/types';
import type { AssetRawWorkerAudit } from '../../asset-pipeline/execution';

/** One entry of a tools table as sent in a request's top-level `tools[]`. */
export interface LlmRequestToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// Agent records are the ordered event log used to rebuild agent state on resume.
// Use records, not state.json, when correctness depends on the order in which
// state transitions happened.
//
// Two record classes exist, and being persisted is not the same as being
// replayed:
//   - State records (the default): each type must have explicit state-rebuild
//     semantics in restoreAgentRecord; a write-only state record is not
//     persistence.
//   - Observability records (`llm.tools_snapshot`, `llm.request`,
//     `mcp.tools_discovered`): a durable trace of the data sent to the model,
//     for debugging and trajectory replay. They never feed state rebuild;
//     their only resume semantics is restoring the write-dedup cursors so a
//     resumed session does not re-log snapshots it already persisted.
export interface AgentRecordEvents {
  metadata: {
    protocol_version: string;
    created_at: number;
  };

  forked: {};

  'turn.prompt': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.steer': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.cancel': { turnId?: number };

  'config.update': AgentConfigUpdateData;

  'permission.set_mode': {
    mode: PermissionMode;
  };
  'permission.record_approval_result': PermissionApprovalResultRecord;

  'full_compaction.begin': CompactionBeginData;

  'plan_mode.enter': {
    id: string;
  };
  'plan_mode.cancel': {
    id?: string;
  };
  'plan_mode.exit': {
    id?: string;
  };

  'swarm_mode.enter': {
    trigger: SwarmModeTrigger;
  };
  'swarm_mode.exit': {};

  'dispatch_mode.set': {
    mode: DispatchMode;
  };

  'tools.register_user_tool': UserToolRegistration;
  'tools.unregister_user_tool': {
    name: string;
  };
  'tools.set_active_tools': {
    names: readonly string[];
  };

  'usage.record': {
    model: string;
    usage: TokenUsage;
    usageScope?: UsageRecordScope | undefined;
  };

  'full_compaction.cancel': {};
  'full_compaction.complete': {};
  'micro_compaction.apply': { cutoff: number };

  'context.append_message': { message: ContextMessage };
  'context.append_loop_event': { event: LoopRecordedEvent };
  'context.update_token_count': { tokenCount: number };
  'context.clear': {};
  'context.apply_compaction': CompactionResult;
  'context.undo': { count: number };

  'tools.update_store': ToolStoreUpdate;

  'goal.create': {
    goalId: string;
    objective: string;
    completionCriterion?: string;
  };
  'goal.update': {
    status?: GoalStatus;
    tokensUsed?: number;
    turnsUsed?: number;
    wallClockMs?: number;
    budgetLimits?: GoalBudgetLimits;
    reason?: string;
    actor?: GoalActor;
  };
  'goal.clear': {};

  // Observability records (see the header note): request-trace data, not
  // state. Resume only restores the write-dedup cursors.

  /**
   * Content-addressed snapshot of a request's top-level `tools[]` (after the
   * `deferred` strip — exactly what the provider receives). Written once per
   * unique table; `llm.request.toolsHash` points here.
   */
  'llm.tools_snapshot': {
    hash: string;
    tools: readonly LlmRequestToolSchema[];
  };

  /**
   * One record per outbound model request (every retry attempt, strict
   * resend, and compaction round included). Together with `config.update`
   * (system prompt full text), context records (messages), and
   * `llm.tools_snapshot` (tool schemas), this makes each request
   * reconstructable from the wire log at the logical-request level.
   */
  'llm.request': {
    kind: 'loop' | 'compaction';
    provider: string;
    model: string;
    modelAlias?: string;
    /**
     * Provider-effective thinking effort — for Kimi providers this is derived
     * from the request body's thinking payload, so env overrides
     * (`KIMI_MODEL_THINKING_EFFORT`) are already reflected.
     */
    thinkingEffort?: ThinkingEffort;
    /**
     * Kimi preserved-thinking passthrough (`thinking.keep`) in effect for
     * this request — resolved from env, config, and the default, none of
     * which are otherwise recorded.
     */
    thinkingKeep?: string;
    /** Effective env-driven sampling overrides (Kimi provider only). */
    temperature?: number;
    topP?: number;
    /**
     * Effective completion-token cap the provider sends on the wire — read
     * from the effective provider, so provider-side clamping (remaining
     * context window, transport ceilings) and provider-level defaults (e.g.
     * Anthropic's required `max_tokens`) are included.
     */
    maxTokens?: number;
    betaApi?: boolean;
    /** Progressive tool disclosure in effect (env flag × model capability). */
    toolSelect: boolean;
    systemPromptHash: string;
    /**
     * Inlined only when the request's system prompt differs from the current
     * `config.update` value (no such caller today; defensive for future ones).
     */
    systemPrompt?: string;
    toolsHash: string;
    messageCount: number;
    turnStep?: string;
    attempt?: string;
    /** Set when this request is a fallback resend (strict rebuild,
     * media-degraded rebuild, or media-stripped rebuild). */
    projection?: 'strict' | 'media-degraded' | 'media-stripped';
    /** Compaction only: messages dropped so far by overflow/empty shrinking. */
    droppedCount?: number;
  };

  /**
   * Raw MCP `tools/list` result as advertised by the server, plus how this
   * agent gated it (allow-list, name collisions). Written on registration,
   * deduplicated per server by content hash.
   */
  'mcp.tools_discovered': {
    serverName: string;
    hash: string;
    tools: readonly MCPToolDefinition[];
    enabledNames: readonly string[];
    collisions?: readonly McpToolCollision[];
  };

  /**
   * Typed Agora lifecycle transition. Each record is keyed by runId; the latest
   * transition for a run is the durable authorization source for peer dispatch
   * and materialization. Capability plaintext is never stored here — only a
   * one-way digest and an opaque epoch.
   */
  'agora.lifecycle': {
    runId: string;
    transitionId: string;
    phase: AgoraLifecyclePhase;
    originTask?: string;
    insertedTask?: string;
    targetTask?: string;
    terminalState?: string;
    sourceSessionId: string;
    capabilityEpoch: string;
    capabilityHash: string;
    envelopeRevision?: number;
    materializationTransitionId?: string;
    materializationHandoffPath?: string;
    materializationDigest?: string;
  };

  /**
   * Trusted-host confirmation bound to one canonical materialization proposal.
   * It remains confirmed through durable adapter execution and is only consumed
   * after the applied lifecycle record has been appended.
   */
  'agora.materialization_confirmation': {
    runId: string;
    sourceSessionId: string;
    lifecycleEpoch: string;
    proposalRevision: number;
    proposalHash: string;
    runPacketRevision: number;
    state: 'confirmed' | 'consumed';
    confirmedBy: 'host' | 'user';
    consumedBy?: string;
  };

  /** Durable Agora packet, peer responses, and terminal run state. */
  'agora.run': {
    runId: string;
    phase: string;
    packetRevision: number;
    packet: Record<string, unknown>;
    /**
     * The Trellis inserted-task path bound to this run, and the origin task
     * it decoupled. Populated when the TUI confirms the Trellis
     * `agora-insert` lifecycle step. The `AgoraTool` reads this durable
     * field (never a caller-supplied task path) to gate peer dispatch.
     */
    insertedTask?: string;
    originTask?: string;
    necessity: AgoraNecessityDecision;
    referenceAuditGate?: {
      state: 'not-required' | 'complete' | 'blocked' | 'audit-risk-accepted';
      currentReferenceHash?: string;
      auditRunId?: string;
      auditReferenceHash?: string;
      riskOverrideConfirmed: boolean;
      reason: string;
    };
    routes: Readonly<Record<string, {
      backend: string;
      modelOverride?: string;
      profileName?: string;
      displayName?: string;
      role?: string;
    }>>;
    peers: readonly {
      peer: string;
      backend?: string;
      model?: string;
      status: 'pending' | 'completed' | 'repair_required' | 'unavailable';
      initialRawResponse?: string;
      repairRawResponse?: string;
      normalizedResponse?: Record<string, unknown>;
      error?: string;
      repairCount: number;
    }[];
    temporaryOverrides: Readonly<Record<string, 'active' | 'disposed'>>;
    hostRoute: 'coder' | 'coder-ex';
    routeUpgrade: 'none' | 'coder_to_coder-ex';
    hostRecoveryResult?: string;
    terminalState?: string;
  };

  'reference_audit.state': {
    material: boolean;
    references: readonly import('../../reference-audit/types').ReferenceDescriptor[];
    referenceHash?: string;
  };

  'reference_audit.override': {
    referenceHash: string;
    auditRunId?: string;
    purpose: 'agora' | 'editing-dispatch';
    operationId: string;
    reason: string;
    overrideHash: string;
    state: 'approved' | 'consumed';
    consumedBy?: string;
  };

  'agora.override': {
    operationId: string;
    kind: 'necessity_force_after_decline' | 'reference_risk_override';
    envelopeHash: string;
    state: 'consumed';
  };

  /** Durable reference audit observability record; replay is intentionally a no-op. */
  'reference_audit.run': {
    runId: string;
    triggered: boolean;
    reason?: string;
    intensity?: ReferenceAuditIntensity;
    referenceHash?: string;
    planHash?: string;
    resultHash?: string;
    tracks: readonly {
      trackId: string;
      workflowRole: ReferenceAuditWorkflowRole;
      status: 'completed' | 'unavailable';
      repairCount: 0 | 1;
      reason?: string;
    }[];
    claimCount?: number;
    contradictionCount?: number;
    unknownCount?: number;
    licenseNoteCount?: number;
    rawResponses?: readonly {
      trackId: string;
      initial: string;
      repair?: string;
      summary: string;
      redactionCount: number;
      originalSha256: string;
      redactedSha256: string;
    }[];
    result?: ReferenceAuditResult;
    terminalState: 'skipped' | 'completed' | 'fallback_required' | 'aborted' | 'failed';
    error?: string;
  };

  /** Durable AssetPipeline planning/discovery artifact record; replay is intentionally a no-op. */
  'asset_pipeline.run': {
    runId: string;
    action: 'validate_bom' | 'discover_candidates' | 'validate_candidates' | 'prepare_execution';
    bom: readonly AssetBomItem[];
    candidates: readonly AssetCandidate[];
    rawDiscoveryResponses?: readonly {
      bomItemId: string;
      response: string;
      status: 'completed' | 'unavailable';
      reason?: string;
    }[];
    rawExecutionResponse?: AssetRawWorkerAudit;
    execution?: VerifiedAssetExecutionResult;
    terminalState: 'completed' | 'fallback_required' | 'failed' | 'aborted';
    error?: string;
  };
}

export type AgentRecord = {
  [K in keyof AgentRecordEvents]: Readonly<AgentRecordEvents[K]> & {
    readonly type: K;
    readonly time?: number;
  };
}[keyof AgentRecordEvents];

export type AgentRecordOf<K extends keyof AgentRecordEvents> = Extract<
  AgentRecord,
  { readonly type: K }
>;

export interface AgentRecordPersistence {
  read(): AsyncIterable<AgentRecord>;
  append(input: AgentRecord): void;
  rewrite(records: readonly AgentRecord[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}
