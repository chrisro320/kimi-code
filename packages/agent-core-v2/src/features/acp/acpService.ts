/**
 * `acp` domain — Agent-scoped ACP context-manager service.
 *
 * Sidecar I/O is lazy: merely constructing or registering the service does not
 * touch storage, so an unconfigured manager remains a zero-cost native path.
 *
 * Compaction takeover (`onWillCompact`): while the manager is active the
 * delegate summarizes from the LAST TRANSFORMED VIEW (`lastView`), not the raw
 * history — on the overflow path the raw history is what overflowed, while the
 * view is already compressed by the kernel. The view is valid only when the
 * live context is element-identical to the view's source snapshot; otherwise
 * (no turn since enable, a PreCompact hook appended) the delegate declines to
 * the built-in round, as it does for degraded health or an empty history. The
 * ACP-owned summarizer request goes through
 * `startInternal({ manager: undefined, transform: 'bypass' })` with
 * `tools: []` and the manual instruction rendered into the ACP-owned
 * `compaction-instruction.md` template; there is no shrink-retry loop (the
 * view is already bounded by kernel truncation), so a truncated or empty
 * response fails the round. A context-overflow rejection from the summarizer
 * itself declines the round instead (`handled: false`): nothing durable has
 * changed at that point and the built-in path owns overflow shrink-retry.
 * Before the durable mutation the delegate
 * re-checks the prefix race (element-identical prefix; an appended tail must
 * be real user input) and throws an abort-shaped error on mismatch. Durable
 * order: sidecar first — `compressionState` resets to a fresh kernel state
 * keeping cumulative `stats`, while `refs`/`nextRef` survive so refs are never
 * reused — then `context.applyCompaction` folds the entire snapshot
 * (`compactedCount = live.length`, built-in parity) with the session todo list
 * appended to the summary like the built-in. A failed sidecar save throws
 * before the fold; a failed fold after the save leaves a clean fresh kernel
 * state over the unfolded context. `requestOverheadTokens` is omitted (the
 * built-in recomputes it from profile/tool services; the omission only
 * slightly under-estimates `tokensAfter`). Post-takeover the cached view is
 * dropped and the next transform starts from the fold summary.
 *
 * The cached transform view is sound only while the live history still
 * extends the exact live snapshot it was shaped from — a length check alone
 * misses in-place edits and undo+regrow, which would let tools act on undone
 * content — and fold eligibility re-checks the prefix after every await
 * because a prefix rewrite (undo/edit) between checks would fold messages
 * the summary never covered. Rebuilt histories append at the tail, keeping
 * every existing provider prefix intact. On reset the cached view and status
 * are dropped immediately so no exit path (abort, fold failure) leaves a
 * stale compressed view eligible against the fresh sidecar.
 *
 * Tool semantics: compress is all-or-nothing — a rejected range fails the
 * whole call, so the model can retry the batch without hitting
 * already-consumed boundaries — and both compress and restore invalidate the
 * cached view immediately after the sidecar save, before the abort check, so
 * an abort cannot leave a view that hides the wrong content (or still shows
 * folded content) eligible for the next transform or takeover. Tools speak
 * the model-visible kernel ref, not the raw projection id — the two diverge
 * once one source message yields several cores. Restore drops the block
 * record entirely: this host re-projects the full raw history every turn, so
 * the kernel's syncBlocks re-derives `active` from message presence and
 * would resurrect a merely-deactivated block; dropping the record keeps the
 * originals visible and lets a nested child block fold its own range again
 * (exactly shallow, one-tier-up restore), while a retained inactive block
 * points the model at its consuming ancestor. Consumed blocks always precede
 * their consumer (kernel appends), which makes the lineage acyclic.
 *
 * Durability fails open: a read-path load or validation failure never
 * silently resets corrupt durable state — the original bytes are kept for
 * `/acp reset` — and a failed save leaves the live history untouched.
 *
 * Status changes publish the `acp` slice (health only) of
 * `agent.status.updated` on the agent event bus, gated on ACP being the
 * requester's active manager so a `reset()` issued while disabled does not
 * light the TUI badge.
 */

import {
  blockDocs,
  BLOCKED_REF,
  buildStatusReport,
  collectBlockContent,
  createCore,
  createInitialState,
  defaultConfig,
  defaultCountTokens,
  findActiveAncestor,
  messageDocs,
  parseBlockIdArg,
  renderNudgeText,
  searchBlocks,
  type CompressionBlock,
  type CompressionCore,
  type CompressionState,
  type CoreMessage,
  type ProcessTurnResult,
} from 'acp-kernel';

import { Service } from '#/_base/di/service';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  buildCompactionSummaryText,
  isRealUserInput,
} from '#/agent/contextMemory/compactionHandoff';
import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
  type CompactDelegation,
  type ContextManager,
} from '#/agent/llmRequester/llmRequester';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventBus } from '#/app/event/eventBus';
import { unwrapErrorCause } from '#/errors';
import { APIContextOverflowError } from '#/kosong/contract/errors';
import { createUserMessage, type Message } from '#/kosong/contract/message';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { renderTodoList } from '#/session/todo/todoItem';

import {
  ACP_MANAGER_ID,
  ACP_MANAGER_VERSION,
  type AcpMutationResult,
  type AcpStatus,
  type IAcpService,
} from './acp';
import { peelTag, projectAcpMessages, rebuildAcpMessages, type CoreProjection } from './messageAdapter';
import acpCompactionInstructionTemplate from './compaction-instruction.md?raw';
import {
  acpCompressionStatesEqual,
  ensureStableRefs,
  loadAcpSidecar,
  resetAcpSidecar,
  saveAcpSidecar,
  type AcpSidecar,
} from './sidecar';

export class AcpService extends Service implements IAcpService {
  declare readonly _serviceBrand: undefined;

  private readonly sidecarScope: string;
  private readonly projector: IAgentContextProjectorService;
  private readonly context: IAgentContextMemoryService;
  private readonly core: CompressionCore;
  private readonly lifetime = new AbortController();
  private operation = Promise.resolve();
  private lastUsage: { readonly usedContextTokens: number; readonly maxContextTokens: number } = {
    usedContextTokens: 0,
    maxContextTokens: 100_000,
  };
  /**
   * The last successful turn's input array (the view the model's refs were
   * issued against) plus the live-history snapshot used to validate reuse.
   * Tools must evaluate that same view; re-projecting the raw history can
   * diverge (shaping, strict/media projections, checkpoint replay), which
   * would let a cited range fold content the summary never covered. The
   * snapshot must come from the live context, not the transform input: the
   * requester hands managers a structuredClone, so input entries never
   * reference-match live entries. `compacted` is the transform OUTPUT (the
   * compressed, kernel-bounded form of `view`); the compaction takeover
   * summarizes from it, never from the raw view.
   */
  private lastView:
    | {
        readonly source: readonly Message[];
        readonly view: readonly Message[];
        readonly compacted: readonly Message[];
      }
    | undefined;
  private currentStatus: AcpStatus = {
    managerId: ACP_MANAGER_ID,
    managerVersion: ACP_MANAGER_VERSION,
    health: 'healthy',
    refs: 0,
    blocks: 0,
    activeBlocks: 0,
  };

  constructor(
    @IAgentScopeContext agentContext: IAgentScopeContext,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @IAgentLLMRequesterService private readonly requester: IAgentLLMRequesterService,
    @IAgentContextProjectorService projector: IAgentContextProjectorService,
    @IAgentContextMemoryService context: IAgentContextMemoryService,
    @ISessionTodoService private readonly todo: ISessionTodoService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
    this.sidecarScope = agentContext.scope('acp');
    this.projector = projector;
    this.context = context;
    this.core = createCore();
    const manager: ContextManager = {
      id: ACP_MANAGER_ID,
      version: ACP_MANAGER_VERSION,
      transformMessages: ({ messages, usedContextTokens, maxContextTokens, signal }) =>
        this.serialize(async () => {
          const linked = AbortSignal.any([signal, this.lifetime.signal]);
          let durableRefs = this.currentStatus.refs;
          try {
            linked.throwIfAborted();
            this.lastUsage = { usedContextTokens, maxContextTokens };
            const loaded = await loadAcpSidecar(this.documents, this.sidecarScope);
            linked.throwIfAborted();
            durableRefs = loaded.refs.length;
            const stable = ensureStableRefs(loaded, messages);
            const projection = projectAcpMessages(messages, (_message, index) => stable.refs[index]!);
            if (!projection.ok) {
              this.degrade(projection.reason, durableRefs);
              return { messages, accounting: 'raw-equivalent' as const };
            }
            const config = defaultConfig(maxContextTokens);
            if (loaded.compressionState !== null && !isCompressionState(loaded.compressionState)) {
              this.degrade('ACP sidecar compression state is corrupt', durableRefs);
              return { messages, accounting: 'raw-equivalent' as const };
            }
            const kernelState = isCompressionState(loaded.compressionState)
              ? loaded.compressionState
              : createInitialState();
            const turn = this.core.processTurn({
              messages: projection.projection.messages,
              state: kernelState,
              config,
              tokenCount: usedContextTokens,
              renderTags: 'text-only',
            });
            linked.throwIfAborted();
            const rebuilt = rebuildAcpMessages(turn.messages, projection.projection);
            if (!rebuilt.ok) {
              this.degrade(rebuilt.reason, durableRefs);
              return { messages, accounting: 'raw-equivalent' as const };
            }
            const tagOnly = isTagOnlyTurn(projection.projection.messages, turn.messages);
            const nextSidecar = {
              ...stable.sidecar,
              compressionState: turn.state,
            };
            linked.throwIfAborted();
            if (stable.changed || !acpCompressionStatesEqual(loaded.compressionState, turn.state)) {
              await saveAcpSidecar(this.documents, this.sidecarScope, nextSidecar);
              linked.throwIfAborted();
            }
            this.setStatus({
              managerId: ACP_MANAGER_ID,
              managerVersion: ACP_MANAGER_VERSION,
              health: 'healthy',
              refs: nextSidecar.refs.length,
              blocks: turn.state.blocks.length,
              activeBlocks: turn.state.blocks.filter((block) => block.active).length,
              contextUsage: maxContextTokens > 0 ? usedContextTokens / maxContextTokens : undefined,
            });
            const nudge = renderTurnNudge(turn);
            const base = tagOnly ? messages : rebuilt.messages;
            const outgoing = nudge === undefined ? base : [...base, nudge];
            this.lastView = { source: this.context.get(), view: messages, compacted: outgoing };
            if (tagOnly && nudge === undefined) {
              return { messages: outgoing, accounting: 'raw-equivalent' as const };
            }
            return { messages: outgoing, accounting: 'transformed' as const };
          } catch (error) {
            if (linked.aborted) throw linked.reason;
            this.degrade(errorMessage(error), durableRefs);
            return { messages, accounting: 'raw-equivalent' as const };
          }
        }),
      onWillCompact: ({ task, input, signal }) =>
        this.serialize(async (): Promise<CompactDelegation> => {
          const linked = AbortSignal.any([signal, this.lifetime.signal]);
          linked.throwIfAborted();
          if (this.currentStatus.health !== 'healthy') return { handled: false };
          const live = this.context.get();
          if (live.length === 0) return { handled: false };
          const cached = this.lastView;
          if (
            cached === undefined ||
            cached.source.length !== live.length ||
            !extendsSnapshot(live, cached.source)
          ) {
            return { handled: false };
          }

          const assertFoldSafe = (): void => {
            if (historySafeToCompact(this.context.get(), live)) return;
            const error = new Error(
              'ACP compaction cancelled: the live history changed while summarizing.',
            );
            error.name = 'AbortError';
            throw error;
          };

          const customInstruction = input.instruction?.trim() ?? '';
          const instruction = renderPrompt(acpCompactionInstructionTemplate, {
            custom_instruction_block:
              customInstruction.length > 0
                ? `\nOptional user instruction:\n${customInstruction}\n`
                : '',
          }).trimEnd();
          const request = this.requester.startInternal(
            { manager: undefined, transform: 'bypass' },
            {
              messages: [...cached.compacted, createUserMessage(instruction)],
              tools: [],
              source: {
                type: 'operation',
                turnId: task.originTurnId,
                requestKind: 'acp_compaction',
              },
            },
            undefined,
            linked,
          );
          let finish: AgentLLMRequestFinish;
          try {
            finish = await request.result;
          } catch (error) {
            if (linked.aborted) throw linked.reason;
            if (unwrapErrorCause(error) instanceof APIContextOverflowError) {
              return { handled: false };
            }
            throw error;
          }
          linked.throwIfAborted();
          if (finish.providerFinishReason === 'truncated') {
            throw new Error('ACP compaction response was truncated before producing a complete summary.');
          }
          const summary = finish.message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
            .trim();
          if (summary.length === 0) {
            throw new Error('ACP compaction response did not contain a non-empty summary.');
          }
          assertFoldSafe();

          const loaded = await loadAcpSidecar(this.documents, this.sidecarScope);
          linked.throwIfAborted();
          const fresh = createInitialState();
          const nextState: CompressionState = isCompressionState(loaded.compressionState)
            ? { ...fresh, stats: loaded.compressionState.stats }
            : fresh;
          assertFoldSafe();
          await saveAcpSidecar(this.documents, this.sidecarScope, {
            ...loaded,
            compressionState: nextState,
          });
          this.lastView = undefined;
          this.setStatus({
            managerId: ACP_MANAGER_ID,
            managerVersion: ACP_MANAGER_VERSION,
            health: 'healthy',
            refs: loaded.refs.length,
            blocks: 0,
            activeBlocks: 0,
          });
          linked.throwIfAborted();
          assertFoldSafe();

          const fullSummary = this.appendTodoList(summary);
          const result = this.context.applyCompaction({
            summary: fullSummary,
            contextSummary: buildCompactionSummaryText(fullSummary),
            compactedCount: live.length,
            tokensBefore: task.tokenCount,
            summaryOutputTokens: finish.usage.output,
          });
          return { handled: true, result };
        }),
    };
    this._register(requester.registerContextManager(manager));
  }

  isActive(): boolean {
    return this.requester.getActiveContextManager()?.id === ACP_MANAGER_ID;
  }

  statusReport(): Promise<AcpMutationResult> {
    return this.serialize(async () => {
      this.lifetime.signal.throwIfAborted();
      try {
        const view = await this.toolView();
        if (!view.ok) return { ok: false, message: view.reason };
        const usage = this.core.status(
          view.state,
          this.lastUsage.usedContextTokens,
          defaultConfig(this.lastUsage.maxContextTokens),
        );
        const report = buildStatusReport(
          view.state,
          [...view.projection.messages],
          defaultCountTokens,
        );
        const status = this.currentStatus;
        const reason = status.reason === undefined ? '' : ` — ${status.reason}`;
        return {
          ok: true,
          message: [
            `ACP ${this.isActive() ? 'active' : 'inactive'}; health: ${status.health}${reason}; manager ${status.managerId} v${status.managerVersion}.`,
            `Context usage: ${(usage.contextUsage * 100).toFixed(1)}% (~${usage.tokenCount} of ${usage.modelContextLimit} tokens).`,
            `Blocks: ${usage.activeBlocks} active / ${usage.totalBlocks} total; ~${usage.tokensCompressed} tokens compressed.`,
            '',
            report,
          ].join('\n'),
        };
      } catch (error) {
        const reason = errorMessage(error);
        if (!this.lifetime.signal.aborted) this.degrade(reason, this.currentStatus.refs);
        return { ok: false, message: `ACP status failed: ${reason}` };
      }
    });
  }

  compress(input: {
    readonly ranges: readonly {
      readonly startRef: string;
      readonly endRef: string;
      readonly summary: string;
      readonly topic?: string;
    }[];
    readonly toolCallId?: string;
    readonly signal?: AbortSignal;
  }): Promise<AcpMutationResult> {
    return this.serialize(async () => {
      const linked =
        input.signal === undefined
          ? this.lifetime.signal
          : AbortSignal.any([this.lifetime.signal, input.signal]);
      linked.throwIfAborted();
      try {
        if (!this.isActive()) {
          return { ok: false, message: 'ACP is not the active context manager.' };
        }
        const view = await this.toolView();
        if (!view.ok) return { ok: false, message: view.reason };
        const { state, result } = this.core.applyCompression({
          ranges: input.ranges.map((range) => ({
            ...range,
            ...(input.toolCallId === undefined ? {} : { compressCallId: input.toolCallId }),
          })),
          messages: [...view.projection.messages],
          state: view.state,
          config: defaultConfig(this.lastUsage.maxContextTokens),
        });
        linked.throwIfAborted();
        if (result.blocksCreated === 0 || result.errors.length > 0) {
          return {
            ok: false,
            message: result.errors.join('; ') || 'ACP compression produced no block',
          };
        }
        const nextSidecar = { ...view.sidecar, compressionState: state };
        await saveAcpSidecar(this.documents, this.sidecarScope, nextSidecar);
        this.lastView = undefined;
        linked.throwIfAborted();
        this.setStatus({
          managerId: ACP_MANAGER_ID,
          managerVersion: ACP_MANAGER_VERSION,
          health: 'healthy',
          refs: nextSidecar.refs.length,
          blocks: state.blocks.length,
          activeBlocks: state.blocks.filter((block) => block.active).length,
          contextUsage: this.currentStatus.contextUsage,
        });
        const created = state.blocks
          .slice(-result.blocksCreated)
          .map((block) => block.blockId)
          .join(', ');
        const warnings =
          result.warnings.length > 0 ? ` Warnings: ${result.warnings.join('; ')}` : '';
        return {
          ok: true,
          message: `Compressed ${result.blocksCreated} block(s) [${created}]; ~${result.tokensCompressed} tokens folded out of the context view.${warnings}`,
        };
      } catch (error) {
        const reason = errorMessage(error);
        if (!linked.aborted) this.degrade(reason, this.currentStatus.refs);
        return { ok: false, message: `ACP compression failed: ${reason}` };
      }
    });
  }

  decompress(input: {
    readonly blockId: string;
    readonly full?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<AcpMutationResult> {
    return this.serialize(async () => {
      const linked =
        input.signal === undefined
          ? this.lifetime.signal
          : AbortSignal.any([this.lifetime.signal, input.signal]);
      linked.throwIfAborted();
      try {
        if (!this.isActive()) {
          return { ok: false, message: 'ACP is not the active context manager.' };
        }
        const view = await this.toolView();
        if (!view.ok) return { ok: false, message: view.reason };
        const parsed = parseBlockIdArg(input.blockId);
        const block = parsed === null ? undefined : this.core.decompress(parsed, view.state);
        if (block === undefined) {
          const known = view.state.blocks.map((entry) => entry.blockId).join(', ') || '(none)';
          return { ok: false, message: `Unknown ACP block "${input.blockId}". Known blocks: ${known}.` };
        }
        if (!block.active) {
          const ancestor = findActiveAncestor(view.state, block.blockId);
          return {
            ok: false,
            message:
              ancestor === null
                ? `ACP block ${block.blockId} is inactive: its messages are no longer in the visible context.`
                : `ACP block ${block.blockId} is folded into active block ${ancestor}; decompress ${ancestor} instead.`,
          };
        }
        const full = input.full ?? false;
        const removed = new Set<string>([block.blockId]);
        if (full) {
          const queue = [...block.directBlockIds];
          while (queue.length > 0) {
            const id = queue.shift()!;
            if (removed.has(id)) continue;
            removed.add(id);
            const nested = view.state.blocks.find((entry) => entry.blockId === id);
            if (nested !== undefined) queue.push(...nested.directBlockIds);
          }
        }
        const next: CompressionState = {
          ...view.state,
          blocks: view.state.blocks.filter((entry) => !removed.has(entry.blockId)),
        };
        linked.throwIfAborted();
        const nextSidecar = { ...view.sidecar, compressionState: next };
        await saveAcpSidecar(this.documents, this.sidecarScope, nextSidecar);
        this.lastView = undefined;
        linked.throwIfAborted();
        this.setStatus({
          managerId: ACP_MANAGER_ID,
          managerVersion: ACP_MANAGER_VERSION,
          health: 'healthy',
          refs: nextSidecar.refs.length,
          blocks: next.blocks.length,
          activeBlocks: next.blocks.filter((entry) => entry.active).length,
          contextUsage: this.currentStatus.contextUsage,
        });
        const { text, count } = collectBlockContent(
          view.state,
          block,
          [...view.projection.messages],
          { full },
        );
        const body = count === 0 ? '(no restorable text content)' : text;
        return {
          ok: true,
          message: `Restored ACP block ${block.blockId} (${count} item(s)); the originals rejoin the context view on the next request.\n\n${body}`,
        };
      } catch (error) {
        const reason = errorMessage(error);
        if (!linked.aborted) this.degrade(reason, this.currentStatus.refs);
        return { ok: false, message: `ACP decompression failed: ${reason}` };
      }
    });
  }

  search(input: { readonly query: string; readonly limit?: number }): Promise<AcpMutationResult> {
    return this.serialize(async () => {
      this.lifetime.signal.throwIfAborted();
      try {
        if (!this.isActive()) {
          return { ok: false, message: 'ACP is not the active context manager.' };
        }
        const view = await this.toolView();
        if (!view.ok) return { ok: false, message: view.reason };
        const ownerByMessage = new Map<string, CompressionBlock>();
        for (const block of view.state.blocks) {
          if (!block.active) continue;
          for (const id of block.effectiveMessageIds) ownerByMessage.set(id, block);
        }
        const docs = [
          ...blockDocs(view.state),
          ...messageDocs(
            view.projection.messages.flatMap((core) => {
              if (core.role === 'system') return [];
              const owner = ownerByMessage.get(core.id);
              const kernelRef = view.state.messageRefs.byRaw[core.id];
              return [
                {
                  ref: kernelRef === undefined || kernelRef === 'BLOCKED' ? core.id : kernelRef,
                  role: core.role,
                  text: peelTag(core.text ?? ''),
                  tokens: defaultCountTokens(core.text ?? ''),
                  blockId: owner?.blockId,
                  tier: owner?.tier,
                },
              ];
            }),
          ),
        ];
        const results = searchBlocks(docs, input.query, { limit: input.limit ?? 8 });
        if (results.length === 0) {
          return { ok: true, message: `No ACP context matches for "${input.query}".` };
        }
        const lines = results.map((hit) => {
          const owner = hit.blockId === undefined ? '' : `, block ${hit.blockId}`;
          const tokens = hit.tokens === undefined ? '' : `, ~${hit.tokens} tokens`;
          return `${hit.ref} (${hit.kind}${owner}${tokens}) ${hit.title}\n${hit.preview}`;
        });
        return {
          ok: true,
          message: `ACP context search "${input.query}" — ${results.length} hit(s); decompress the owning block for full content.\n\n${lines.join('\n\n')}`,
        };
      } catch (error) {
        const reason = errorMessage(error);
        if (!this.lifetime.signal.aborted) this.degrade(reason, this.currentStatus.refs);
        return { ok: false, message: `ACP search failed: ${reason}` };
      }
    });
  }

  private async toolView(): Promise<AcpToolView> {
    const loaded = await loadAcpSidecar(this.documents, this.sidecarScope);
    const state =
      loaded.compressionState === null
        ? createInitialState()
        : isCompressionState(loaded.compressionState)
          ? loaded.compressionState
          : undefined;
    if (state === undefined) {
      const reason = 'ACP sidecar compression state is corrupt';
      this.degrade(reason, loaded.refs.length);
      return { ok: false, reason };
    }
    const history = this.context.get();
    const cached = this.lastView;
    const messages =
      cached !== undefined && extendsSnapshot(history, cached.source)
        ? cached.view
        : this.projector.project(history);
    const stable = ensureStableRefs(loaded, messages);
    const projection = projectAcpMessages(messages, (_message, index) => stable.refs[index]!);
    if (!projection.ok) {
      this.degrade(projection.reason, loaded.refs.length);
      return { ok: false, reason: projection.reason };
    }
    return { ok: true, sidecar: stable.sidecar, state, projection: projection.projection };
  }

  override dispose(): void {
    this.lifetime.abort();
    super.dispose();
  }

  status(): AcpStatus {
    return this.currentStatus;
  }

  statusSnapshot(): Promise<AcpStatus> {
    return this.serialize(async () => {
      this.lifetime.signal.throwIfAborted();
      let loaded: AcpSidecar;
      try {
        loaded = await loadAcpSidecar(this.documents, this.sidecarScope);
      } catch (error) {
        const reason = errorMessage(error);
        this.degrade(reason, this.currentStatus.refs);
        return this.currentStatus;
      }
      const blocks = isCompressionState(loaded.compressionState)
        ? loaded.compressionState.blocks
        : [];
      const corrupt = loaded.compressionState !== null && !isCompressionState(loaded.compressionState);
      if (corrupt) {
        this.degrade('ACP sidecar compression state is corrupt', loaded.refs.length);
        return this.currentStatus;
      }
      const current = this.currentStatus;
      return {
        managerId: ACP_MANAGER_ID,
        managerVersion: ACP_MANAGER_VERSION,
        health: current.health,
        refs: loaded.refs.length,
        blocks: blocks.length,
        activeBlocks: blocks.filter((block) => block.active).length,
        contextUsage: current.contextUsage,
        ...(current.reason === undefined ? {} : { reason: current.reason }),
      };
    });
  }

  reset(): Promise<void> {
    return this.serialize(async () => {
      this.lifetime.signal.throwIfAborted();
      await resetAcpSidecar(this.documents, this.sidecarScope);
      this.lastView = undefined;
      this.lifetime.signal.throwIfAborted();
      this.setStatus({
        managerId: ACP_MANAGER_ID,
        managerVersion: ACP_MANAGER_VERSION,
        health: 'healthy',
        refs: 0,
        blocks: 0,
        activeBlocks: 0,
      });
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private degrade(reason: string, refs: number): void {
    this.setStatus({
      managerId: ACP_MANAGER_ID,
      managerVersion: ACP_MANAGER_VERSION,
      health: 'degraded',
      refs,
      blocks: this.currentStatus.blocks,
      activeBlocks: this.currentStatus.activeBlocks,
      contextUsage: this.currentStatus.contextUsage,
      reason,
    });
  }

  private setStatus(status: AcpStatus): void {
    this.currentStatus = status;
    if (this.requester.getActiveContextManager()?.id !== ACP_MANAGER_ID) return;
    this.eventBus.publish({ type: 'agent.status.updated', acp: status.health });
  }

  private appendTodoList(summary: string): string {
    const todos = this.todo.getTodos();
    if (todos.length === 0) {
      return summary;
    }
    return `${summary.trim()}\n\n${renderTodoList(todos, '## TODO List')}`;
  }
}

type AcpToolView =
  | {
      readonly ok: true;
      readonly sidecar: AcpSidecar;
      readonly state: CompressionState;
      readonly projection: CoreProjection;
    }
  | { readonly ok: false; readonly reason: string };

function renderTurnNudge(turn: ProcessTurnResult): Message | undefined {
  const decision = turn.nudge;
  if (decision?.shouldInject !== true) return undefined;
  return {
    role: 'system',
    content: [{ type: 'text', text: renderNudgeText(decision).text }],
    toolCalls: [],
  };
}

function isTagOnlyTurn(before: readonly CoreMessage[], after: readonly CoreMessage[]): boolean {
  if (before.length !== after.length) return false;
  return before.every((original, index) => {
    const evolved = after[index]!;
    return (
      evolved.id === original.id &&
      evolved.role === original.role &&
      evolved.contentType === original.contentType &&
      evolved.toolName === original.toolName &&
      evolved.toolCallId === original.toolCallId &&
      peelTag(evolved.text ?? '') === (original.text ?? '')
    );
  });
}

function isCompressionState(value: unknown): value is CompressionState {
  if (!isRecord(value)) return false;
  const blocks = value['blocks'];
  const messageRefs = value['messageRefs'];
  const nudge = value['nudge'];
  const stats = value['stats'];
  if (
    !Array.isArray(blocks) ||
    !isRecord(messageRefs) ||
    !isRecord(messageRefs['byRaw']) ||
    !isRecord(messageRefs['byRef']) ||
    !isRecord(nudge) ||
    !isRecord(stats) ||
    !isNonNegativeInteger(value['nextBlockId']) ||
    !isNonNegativeInteger(value['nextRunId'])
  ) {
    return false;
  }
  if (!blocks.every(isCompressionBlock)) return false;
  if (!recordValuesAreStrings(messageRefs['byRaw']) || !recordValuesAreStrings(messageRefs['byRef'])) {
    return false;
  }
  const lastShownByTier = nudge['lastShownByTier'];
  if (
    typeof nudge['lastPerMessageNudgeTokens'] !== 'number' ||
    typeof nudge['lastNudgeShownTokens'] !== 'number' ||
    typeof nudge['baselineTokens'] !== 'number' ||
    !isRecord(nudge['anchors']) ||
    !isRecord(lastShownByTier) ||
    !Object.values(lastShownByTier).every((entry) => typeof entry === 'number') ||
    typeof stats['tokensCompressed'] !== 'number' ||
    typeof stats['compressionCount'] !== 'number'
  ) {
    return false;
  }
  return compressionStateInvariantsHold(
    blocks as CompressionBlock[],
    messageRefs['byRaw'] as Record<string, string>,
    messageRefs['byRef'] as Record<string, string>,
    value['nextBlockId'] as number,
    value['nextRunId'] as number,
  );
}

/**
 * Cross-field invariants the kernel relies on when allocating ids and walking
 * lineage. A stale counter would hand out a duplicate block id, a broken ref
 * bijection makes cited ranges resolve to the wrong message, and a lineage
 * cycle hangs ancestor walks.
 */
function compressionStateInvariantsHold(
  blocks: readonly CompressionBlock[],
  byRaw: Record<string, string>,
  byRef: Record<string, string>,
  nextBlockId: number,
  nextRunId: number,
): boolean {
  const blockIds = new Set<string>();
  let maxBlock = 0;
  let maxRun = 0;
  for (const block of blocks) {
    const blockNum = /^b([1-9]\d*)$/.exec(block.blockId)?.[1];
    const runNum = /^r([1-9]\d*)$/.exec(block.runId)?.[1];
    if (blockNum === undefined || runNum === undefined) return false;
    if (blockIds.has(block.blockId)) return false;
    blockIds.add(block.blockId);
    maxBlock = Math.max(maxBlock, Number(blockNum));
    maxRun = Math.max(maxRun, Number(runNum));
    if (block.directBlockIds.includes(block.blockId)) return false;
  }
  if (nextBlockId < 1 || nextBlockId <= maxBlock) return false;
  if (nextRunId < 1 || nextRunId <= maxRun) return false;
  const order = new Map(blocks.map((block, index) => [block.blockId, index]));
  for (const [index, block] of blocks.entries()) {
    for (const id of block.directBlockIds) {
      const consumed = order.get(id);
      if (consumed === undefined || consumed >= index) return false;
    }
  }
  for (const [raw, ref] of Object.entries(byRaw)) {
    if (ref === BLOCKED_REF) continue;
    if (!refIndexInBounds(ref) || byRef[ref] !== raw) return false;
  }
  for (const [ref, raw] of Object.entries(byRef)) {
    if (!refIndexInBounds(ref) || byRaw[raw] !== ref) return false;
  }
  return true;
}

function isCompressionBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const tier = value['tier'];
  const generation = value['generation'];
  const directMessageIds = value['directMessageIds'];
  const effectiveMessageIds = value['effectiveMessageIds'];
  const directBlockIds = value['directBlockIds'];
  return (
    typeof value['blockId'] === 'string' &&
    typeof value['runId'] === 'string' &&
    (tier === 1 || tier === 2 || tier === 3) &&
    typeof value['summary'] === 'string' &&
    Array.isArray(directMessageIds) && directMessageIds.every(isString) &&
    Array.isArray(effectiveMessageIds) && effectiveMessageIds.every(isString) &&
    Array.isArray(directBlockIds) && directBlockIds.every(isString) &&
    typeof value['compressedTokens'] === 'number' &&
    typeof value['createdAt'] === 'number' &&
    typeof value['survivedCount'] === 'number' &&
    (generation === 'young' || generation === 'old') &&
    typeof value['active'] === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function recordValuesAreStrings(value: Record<string, unknown>): boolean {
  return Object.values(value).every(isString);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * True when `current` begins with exactly `snapshot` (reference equality per
 * entry), so state derived from `snapshot` still describes the live history.
 */
function extendsSnapshot(current: readonly Message[], snapshot: readonly Message[]): boolean {
  if (current.length < snapshot.length) return false;
  for (let index = 0; index < snapshot.length; index++) {
    if (current[index] !== snapshot[index]) return false;
  }
  return true;
}

/**
 * Prefix-race guard ahead of the fold, mirroring the built-in compaction's:
 * the live history must still extend the snapshot the summary was built from,
 * and anything appended mid-round must be real user input (the fold shape
 * keeps such a tail alive).
 */
function historySafeToCompact(
  current: readonly Message[],
  original: readonly Message[],
): boolean {
  if (current.length < original.length) return false;
  if (!original.every((message, index) => message === current[index])) return false;
  return current.slice(original.length).every(isRealUserInput);
}

/**
 * Mirrors the kernel's refToIndex bounds: refs parse as m<index> with index
 * 1–99999 (zero padding allowed); anything outside the allocatable range
 * (e.g. m00000) is corruption the kernel itself would fail to resolve.
 */
function refIndexInBounds(ref: string): boolean {
  const match = /^m0*(\d{1,5})$/.exec(ref);
  if (match === null) return false;
  const index = Number(match[1]);
  return index >= 1 && index <= 99_999;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
