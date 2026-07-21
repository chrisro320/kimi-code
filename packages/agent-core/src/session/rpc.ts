import { ErrorCodes, KimiError } from '#/errors';
import type { SessionWarning } from '@moonshot-ai/protocol';
import type {
  ActivateSkillPayload,
  ActivatePluginCommandPayload,
  AddAdditionalDirPayload,
  AddAdditionalDirResult,
  AgentAPI,
  BeginCompactionPayload,
  CancelPayload,
  CancelPlanPayload,
  CancelShellCommandPayload,
  CreateGoalPayload,
  DetachBackgroundPayload,
  EmptyPayload,
  EnterSwarmPayload,
  SetDispatchModePayload,
  GetBackgroundOutputPayload,
  GetBackgroundPayload,
  ImportContextPayload,
  McpServerInfo,
  McpStartupMetrics,
  PromptPayload,
  RunShellCommandPayload,
  ReconnectMcpServerPayload,
  RenameSessionPayload,
  RegisterToolPayload,
  SessionAPI,
  SetActiveToolsPayload,
  SetModelPayload,
  SetPermissionPayload,
  SetThinkingPayload,
  SkillSummary,
  PluginCommandDef,
  SteerPayload,
  StopBackgroundPayload,
  UndoHistoryPayload,
  UnregisterToolPayload,
  UpdateSessionMetadataPayload,
  InsertAgoraReviewPayload,
  InsertAgoraReviewResult,
  GetAgoraReviewPayload,
  CancelAgoraReviewPayload,
  ConfirmAgoraMaterializationPayload,
  MaterializeAgoraReviewPayload,
  MaterializeAgoraReviewResult,
} from '#/rpc';
import type { Event } from '#/rpc/events';
import {
  confirmAgoraMaterializationProposal,
  createAgoraLifecycleCapability,
  recordAgoraLifecycleTransition,
  cancelAgoraLifecycleTransition,
  materializeAgoraLifecycleTransition,
  toAgoraLifecycleHandle,
  verifyAgoraLifecycleHandle,
  type AgoraLifecycleCapability,
  type AgoraLifecycleCapabilityToken,
  type AgoraLifecycleSnapshot,
  type AgoraLifecycleTransitionResult,
  type AgoraMaterializationConfirmation,
} from '#/agora/lifecycle';
import type { PromisableMethods } from '#/utils/types';

import type { Session, SessionMeta } from '.';
import {
  promptMetadataTextFromPayload,
  promptMetadataTextFromPluginCommand,
  promptMetadataTextFromSkill,
  titleFromPromptMetadataText,
} from './prompt-metadata';

type AgentScopedPayload<T> = T & { agentId: string };

export class SessionAPIImpl implements PromisableMethods<SessionAPI> {
  /** Public callers only receive operationId; bearer plaintext stays here. */
  private readonly agoraCapabilityVault = new Map<string, AgoraLifecycleCapabilityToken>();

  constructor(protected readonly session: Session) {}

  async renameSession(payload: RenameSessionPayload): Promise<void> {
    const title = payload.title.trim();
    if (title.length === 0) {
      throw new KimiError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty');
    }
    this.session.metadata = {
      ...this.session.metadata,
      title,
      isCustomTitle: true,
      updatedAt: new Date().toISOString(),
    };
    await this.session.writeMetadata();
  }

  async updateSessionMetadata(payload: UpdateSessionMetadataPayload): Promise<void> {
    this.session.metadata = {
      ...this.session.metadata,
      ...payload.metadata,
      agents: this.session.metadata.agents,
    };
    await this.session.writeMetadata();
  }

  getSessionMetadata(_payload: EmptyPayload): SessionMeta {
    return this.session.metadata;
  }

  listSkills(_payload: EmptyPayload): Promise<readonly SkillSummary[]> {
    return this.session.listSkills();
  }

  listPluginCommands(_payload: EmptyPayload): readonly PluginCommandDef[] {
    return this.session.listPluginCommands();
  }

  listMcpServers(_payload: EmptyPayload): readonly McpServerInfo[] {
    return this.session.mcp.list();
  }

  async getMcpStartupMetrics(_payload: EmptyPayload): Promise<McpStartupMetrics> {
    await this.session.mcp.waitForInitialLoad();
    return { durationMs: this.session.mcp.initialLoadDurationMs() };
  }

  async reconnectMcpServer(payload: ReconnectMcpServerPayload): Promise<void> {
    await this.session.mcp.reconnect(payload.name);
  }

  generateAgentsMd(_payload: EmptyPayload): Promise<void> {
    return this.session.generateAgentsMd();
  }

  getSessionWarnings(_payload: EmptyPayload): Promise<readonly SessionWarning[]> {
    return this.session.getSessionWarnings();
  }

  waitForBackgroundTasksOnPrint(_payload: EmptyPayload): Promise<void> {
    return this.session.waitForBackgroundTasksOnPrint();
  }

  handlePrintMainTurnCompleted(_payload: EmptyPayload): Promise<'finish' | 'continue'> {
    return this.session.handlePrintMainTurnCompleted();
  }

  addAdditionalDir(payload: AddAdditionalDirPayload): Promise<AddAdditionalDirResult> {
    return this.session.addAdditionalDir(payload.path, payload.persist);
  }

  async prompt({ agentId, ...payload }: AgentScopedPayload<PromptPayload>) {
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromPayload(payload));
    }
    return (await this.getAgent(agentId)).prompt(payload);
  }

  async steer({ agentId, ...payload }: AgentScopedPayload<SteerPayload>) {
    return (await this.getAgent(agentId)).steer(payload);
  }

  async runShellCommand({ agentId, ...payload }: AgentScopedPayload<RunShellCommandPayload>) {
    return (await this.getAgent(agentId)).runShellCommand(payload);
  }

  async cancelShellCommand({ agentId, ...payload }: AgentScopedPayload<CancelShellCommandPayload>) {
    return (await this.getAgent(agentId)).cancelShellCommand(payload);
  }

  async cancel({ agentId, ...payload }: AgentScopedPayload<CancelPayload>) {
    return (await this.getAgent(agentId)).cancel(payload);
  }

  async undoHistory({ agentId, ...payload }: AgentScopedPayload<UndoHistoryPayload>) {
    return (await this.getAgent(agentId)).undoHistory(payload);
  }

  async setModel({ agentId, ...payload }: AgentScopedPayload<SetModelPayload>) {
    return (await this.getAgent(agentId)).setModel(payload);
  }

  async setThinking({ agentId, ...payload }: AgentScopedPayload<SetThinkingPayload>) {
    return (await this.getAgent(agentId)).setThinking(payload);
  }

  async setPermission({ agentId, ...payload }: AgentScopedPayload<SetPermissionPayload>) {
    return (await this.getAgent(agentId)).setPermission(payload);
  }

  async getModel({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getModel(payload);
  }

  async enterPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).enterPlan(payload);
  }

  async cancelPlan({ agentId, ...payload }: AgentScopedPayload<CancelPlanPayload>) {
    return (await this.getAgent(agentId)).cancelPlan(payload);
  }

  async clearPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).clearPlan(payload);
  }

  async enterSwarm({ agentId, ...payload }: AgentScopedPayload<EnterSwarmPayload>) {
    return (await this.getAgent(agentId)).enterSwarm(payload);
  }

  async exitSwarm({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).exitSwarm(payload);
  }

  async getSwarmMode({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getSwarmMode(payload);
  }

  async setDispatchMode({ agentId, ...payload }: AgentScopedPayload<SetDispatchModePayload>) {
    return (await this.getAgent(agentId)).setDispatchMode(payload);
  }

  async getDispatchMode({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getDispatchMode(payload);
  }

  async beginCompaction({ agentId, ...payload }: AgentScopedPayload<BeginCompactionPayload>) {
    return (await this.getAgent(agentId)).beginCompaction(payload);
  }

  async cancelCompaction({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).cancelCompaction(payload);
  }

  async registerTool({ agentId, ...payload }: AgentScopedPayload<RegisterToolPayload>) {
    return (await this.getAgent(agentId)).registerTool(payload);
  }

  async unregisterTool({ agentId, ...payload }: AgentScopedPayload<UnregisterToolPayload>) {
    return (await this.getAgent(agentId)).unregisterTool(payload);
  }

  async setActiveTools({ agentId, ...payload }: AgentScopedPayload<SetActiveToolsPayload>) {
    return (await this.getAgent(agentId)).setActiveTools(payload);
  }

  async stopBackground({ agentId, ...payload }: AgentScopedPayload<StopBackgroundPayload>) {
    return (await this.getAgent(agentId)).stopBackground(payload);
  }

  async detachBackground({ agentId, ...payload }: AgentScopedPayload<DetachBackgroundPayload>) {
    return (await this.getAgent(agentId)).detachBackground(payload);
  }

  async clearContext({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).clearContext(payload);
  }

  async importContext({ agentId, ...payload }: AgentScopedPayload<ImportContextPayload>) {
    return (await this.getAgent(agentId)).importContext(payload);
  }

  async activateSkill({ agentId, ...payload }: AgentScopedPayload<ActivateSkillPayload>) {
    await (await this.getAgent(agentId)).activateSkill(payload);
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromSkill(payload));
    }
  }

  async activatePluginCommand({
    agentId,
    ...payload
  }: AgentScopedPayload<ActivatePluginCommandPayload>) {
    await (await this.getAgent(agentId)).activatePluginCommand(payload);
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromPluginCommand(payload));
    }
  }

  async startBtw({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>): Promise<string> {
    return (await this.getAgent(agentId)).startBtw(payload);
  }

  async createGoal({ agentId, ...payload }: AgentScopedPayload<CreateGoalPayload>) {
    return (await this.getAgent(agentId)).createGoal(payload);
  }

  async getGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getGoal(payload);
  }

  async pauseGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).pauseGoal(payload);
  }

  async resumeGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).resumeGoal(payload);
  }

  async cancelGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).cancelGoal(payload);
  }

  async getCronTasks({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getCronTasks(payload);
  }

  async getBackgroundOutput({
    agentId,
    ...payload
  }: AgentScopedPayload<GetBackgroundOutputPayload>) {
    return (await this.getAgent(agentId)).getBackgroundOutput(payload);
  }

  async getContext({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getContext(payload);
  }

  async getConfig({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getConfig(payload);
  }

  async getPermission({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getPermission(payload);
  }

  async getPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getPlan(payload);
  }

  async getUsage({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getUsage(payload);
  }

  async getTools({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getTools(payload);
  }

  async getBackground({ agentId, ...payload }: AgentScopedPayload<GetBackgroundPayload>) {
    return (await this.getAgent(agentId)).getBackground(payload);
  }

  async insertAgoraReview(payload: InsertAgoraReviewPayload): Promise<InsertAgoraReviewResult> {
    const runId = payload.runId.trim();
    const transitionId = payload.transitionId.trim();
    if (runId.length === 0) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora run id cannot be empty');
    }
    if (transitionId.length === 0) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora transition id cannot be empty');
    }
    const title = normalizeUntrustedTitle(payload.title);
    const slug = normalizeUntrustedSlug(payload.slug);
    const agent = await this.session.ensureAgentResumed('main');
    const sessionId = this.session.options.id ?? '';
    const adapter = this.session.agoraLifecycleAdapter;
    if (adapter === undefined) {
      throw new KimiError(ErrorCodes.NOT_IMPLEMENTED, 'Agora lifecycle adapter is not configured');
    }
    const existing = agent.records.latestAgoraLifecycle(runId);
    if (payload.capability !== undefined) {
      if (existing === undefined || existing.transitionId !== transitionId) {
        throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora retry handle requires the same durable transition id');
      }
      if (payload.capability.runId !== runId || payload.capability.sessionId !== sessionId) {
        throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora retry handle is bound to a different run or session');
      }
    } else if (existing?.transitionId === transitionId) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora transition already exists; retry requires its opaque handle');
    }
    const capability = payload.capability === undefined
      ? createAgoraLifecycleCapability(sessionId, runId)
      : this.resolveAgoraCapabilityHandle(payload.capability);
    if (capability === undefined) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora retry handle is not available in this trusted host');
    }
    if (payload.capability !== undefined) {
      verifyAgoraLifecycleHandle(agent.records, capability);
    }
    this.agoraCapabilityVault.set(capability.operationId, capability);
    const handle = toAgoraLifecycleHandle(capability);
    const transition = existing?.transitionId === transitionId
      ? {
          success: true,
          originTask: existing.originTask,
          insertedTask: existing.insertedTask,
          targetTask: existing.targetTask,
          envelopeRevision: existing.envelopeRevision,
        }
      : await adapter.insert({
          operation: 'insert',
          runId,
          sourceSessionId: sessionId,
          transitionId,
          reconcile: true,
          insert: title === undefined && slug === undefined ? undefined : { title, slug },
        });
    if (!transition.success) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        transition.error ?? 'Agora insert transition failed',
      );
    }
    const snapshot = recordAgoraLifecycleTransition(agent.records, {
      sessionId,
      runId,
      transitionId,
      phase: 'packet_confirmation',
      originTask: transition.originTask,
      insertedTask: transition.insertedTask,
      targetTask: transition.targetTask,
      capability,
      envelopeRevision: transition.envelopeRevision,
    });
    try {
      await agent.records.flush();
    } catch (error) {
      throw new KimiError(
        ErrorCodes.RECORDS_WRITE_FAILED,
        `Agora transition ${transitionId} succeeded but its durable record failed to flush; retry with the same transitionId and opaque handle to reconcile.`,
        { cause: error, details: { runId, transitionId, reconcile: true, retryHandle: handle } },
      );
    }
    this.emitAgoraLifecycleUpdated(snapshot);
    return { handle, snapshot };
  }

  async getAgoraReview(payload: GetAgoraReviewPayload): Promise<AgoraLifecycleSnapshot | undefined> {
    const agent = await this.session.ensureAgentResumed('main');
    const latest = agent.records.latestAgoraLifecycle(payload.runId.trim());
    if (latest === undefined) return undefined;
    const { capabilityHash: _hash, capabilityEpoch: _epoch, ...snapshot } = latest;
    return snapshot;
  }

  async cancelAgoraReview(payload: CancelAgoraReviewPayload): Promise<AgoraLifecycleTransitionResult> {
    const runId = payload.runId.trim();
    const transitionId = payload.transitionId.trim();
    if (runId.length === 0) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora run id cannot be empty');
    }
    if (runId !== payload.capability.runId) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora run id does not match the lifecycle capability');
    }
    if (payload.capability.sessionId !== this.session.options.id) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora lifecycle capability is bound to a different session');
    }
    if (transitionId.length === 0) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora transition id cannot be empty');
    }
    const capability = this.resolveAgoraCapabilityHandle(payload.capability);
    if (capability === undefined) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora lifecycle capability is not available in this trusted host');
    }
    const agent = await this.session.ensureAgentResumed('main');
    const result = await cancelAgoraLifecycleTransition(
      agent.records,
      this.session.agoraLifecycleAdapter,
      capability,
      transitionId,
    );
    await agent.records.flush();
    const latest = agent.records.latestAgoraLifecycle(runId);
    if (latest !== undefined) {
      this.emitAgoraLifecycleUpdated(latest);
    }
    return result;
  }

  async confirmAgoraMaterialization(
    payload: ConfirmAgoraMaterializationPayload,
  ): Promise<AgoraMaterializationConfirmation> {
    const runId = payload.runId.trim();
    if (runId.length === 0 || runId !== payload.capability.runId) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora confirmation run id is invalid');
    }
    if (payload.capability.sessionId !== this.session.options.id) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora lifecycle capability is bound to a different session');
    }
    const capability = this.resolveAgoraCapabilityHandle(payload.capability);
    if (capability === undefined) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora lifecycle capability is not available in this trusted host');
    }
    const agent = await this.session.ensureAgentResumed('main');
    const confirmation = confirmAgoraMaterializationProposal(
      agent.records,
      capability,
      payload.proposal,
      'host',
    );
    await agent.records.flush();
    const latest = agent.records.latestAgoraLifecycle(runId);
    if (latest !== undefined) this.emitAgoraLifecycleUpdated(latest);
    return confirmation;
  }

  async materializeAgoraReview(
    payload: MaterializeAgoraReviewPayload,
  ): Promise<MaterializeAgoraReviewResult> {
    const runId = payload.runId.trim();
    const transitionId = payload.transitionId.trim();
    if (runId.length === 0) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora run id cannot be empty');
    }
    if (runId !== payload.capability.runId) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora run id does not match the lifecycle capability');
    }
    if (payload.capability.sessionId !== this.session.options.id) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora lifecycle capability is bound to a different session');
    }
    if (transitionId.length === 0) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora transition id cannot be empty');
    }
    const capability = this.resolveAgoraCapabilityHandle(payload.capability);
    if (capability === undefined) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora lifecycle capability is not available in this trusted host');
    }
    const agent = await this.session.ensureAgentResumed('main');
    const result = await materializeAgoraLifecycleTransition(
      agent.records,
      this.session.agoraLifecycleAdapter,
      capability,
      transitionId,
      this.buildSessionLineage(),
      payload.proposal,
      payload.confirmation,
    );
    await agent.records.flush();
    if (result.success) {
      const latest = agent.records.latestAgoraLifecycle(runId);
      if (latest !== undefined) {
        this.emitAgoraLifecycleUpdated(latest);
      }
    }
    return { ...result, runId };
  }

  private resolveAgoraCapabilityHandle(
    handle: AgoraLifecycleCapability,
  ): AgoraLifecycleCapabilityToken | undefined {
    const token = this.agoraCapabilityVault.get(handle.operationId);
    if (token === undefined) return undefined;
    return token.sessionId === handle.sessionId
      && token.runId === handle.runId
      && token.epoch === handle.epoch
      ? token
      : undefined;
  }

  private buildSessionLineage(): readonly string[] {
    const lineage: string[] = [];
    const sessionId = this.session.options.id;
    if (sessionId !== undefined) {
      lineage.push(sessionId);
    }
    if (this.session.metadata.forkedFrom !== undefined) {
      lineage.unshift(this.session.metadata.forkedFrom);
    }
    return lineage;
  }

  private emitAgoraLifecycleUpdated(snapshot: AgoraLifecycleSnapshot): void {
    const sessionId = this.session.options.id;
    if (sessionId === undefined) return;
    const { transitionId: _transitionId, ...eventPayload } = snapshot;
    const event: Event = {
      type: 'agora.lifecycle.updated',
      agentId: 'main',
      sessionId,
      ...eventPayload,
    };
    void this.session.rpc.emitEvent(event);
  }

  private async getAgent(agentId: string): Promise<PromisableMethods<AgentAPI>> {
    const agent = await this.session.ensureAgentResumed(agentId);
    return agent.rpcMethods;
  }

  private needUpdateEasyTitle(metadata: SessionMeta): boolean {
    if (hasCustomTitle(metadata)) return false;
    if (!isUntitled(metadata.title)) return false;
    return true;
  }

  private async updatePromptMetadata(lastPrompt: string | undefined): Promise<void> {
    if (lastPrompt === undefined) return;

    const title = this.needUpdateEasyTitle(this.session.metadata)
      ? titleFromPromptMetadataText(lastPrompt)
      : undefined;
    const now = new Date().toISOString();
    const nextMetadata = {
      ...this.session.metadata,
      lastPrompt,
      updatedAt: now,
    };
    if (title !== undefined) {
      nextMetadata.title = title;
      nextMetadata.isCustomTitle = false;
    }

    this.session.metadata = nextMetadata;
    await this.session.writeMetadata();
    await this.session.rpc.emitEvent({
      type: 'session.meta.updated',
      agentId: 'main',
      title,
      patch: {
        title,
        isCustomTitle: title === undefined ? undefined : false,
        lastPrompt,
      },
    });
  }
}

function normalizeUntrustedTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const title = value.trim();
  if (title.length === 0 || title.length > 200 || /[\r\n\0]/.test(title)) {
    throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora title must be 1-200 single-line characters');
  }
  return title;
}

function normalizeUntrustedSlug(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const slug = value.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Agora slug must be a canonical lowercase slug');
  }
  return slug;
}

function isUntitled(title: unknown): boolean {
  return typeof title !== 'string' || title.trim().length === 0 || title === 'New Session';
}

function hasCustomTitle(metadata: SessionMeta): boolean {
  if (metadata.isCustomTitle) return true;
  return typeof (metadata as SessionMeta & { customTitle?: unknown }).customTitle === 'string';
}
