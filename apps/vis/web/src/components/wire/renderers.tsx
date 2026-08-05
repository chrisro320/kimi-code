// The single wire-renderer registry. Co-locates tone + label + headline +
// detail for every record kind. Because `WIRE_RENDERERS` is typed as a mapped
// type over the FULL `RecordType` union, TypeScript REQUIRES an entry for each
// kind: adding a kind upstream in agent-core fails
// `pnpm --filter @moonshot-ai/vis-web typecheck` here until a renderer is
// added. This is the anti-rot guarantee that keeps vis from silently falling
// behind the wire protocol.

import type { ReactNode } from 'react';

import type { AgentRecord, AgentRecordOf } from '../../types';
import type { PillTone } from '../shared/Pill';
import { Pill } from '../shared/Pill';
import {
  Dim,
  type HeadlineRender,
  LoopEventDetail,
  MessageDetail,
  Mono,
  ContentPartView,
  FieldRow,
  firstText,
  truncate,
  loopEventSummary,
} from './parts';
import { SizePreview } from '../shared/SizePreview';
import { JsonViewer } from '../shared/JsonViewer';

export type RecordType = AgentRecord['type'];

export interface WireRenderer<K extends RecordType> {
  tone: PillTone;
  /** Compact badge label. */
  label: string;
  /** One-line collapsed summary. */
  headline: (r: AgentRecordOf<K>) => HeadlineRender;
  /** Expanded detail. Omit to fall back to a full structured JSON dump. */
  detail?: (r: AgentRecordOf<K>) => ReactNode;
}

/** A registry entry for every record kind. The value type is a mapped type
 *  over the full `RecordType` union, so TypeScript forces an entry per kind. */
type RendererMap = { [K in RecordType]: WireRenderer<K> };

/** Terminal / durable-state string -> severity tone. Shared by the Agora,
 *  reference-audit, and asset-pipeline records below, which all carry a
 *  small closed set of outcome strings rather than a boolean. */
function stateTone(state: string | undefined): PillTone {
  switch (state) {
    case undefined:
      return 'neutral';
    case 'completed':
    case 'confirmed':
    case 'complete':
    case 'approved':
      return 'success';
    case 'skipped':
    case 'consumed':
    case 'not-required':
      return 'neutral';
    case 'fallback_required':
    case 'aborted':
    case 'blocked':
    case 'audit-risk-accepted':
    case 'unavailable':
      return 'warning';
    case 'failed':
      return 'error';
    default:
      return 'info';
  }
}

export const WIRE_RENDERERS: RendererMap = {
  metadata: {
    tone: 'meta',
    label: 'meta',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Mono>protocol v{r.protocol_version}</Mono>
          <Dim>·</Dim>
          <Mono>created {new Date(r.created_at).toLocaleString()}</Mono>
        </span>
      ),
    }),
  },

  forked: {
    tone: 'lifecycle',
    label: 'fork',
    headline: () => ({ main: <Dim>session forked</Dim> }),
  },

  'config.update': {
    tone: 'config',
    label: 'config',
    headline: (r) => {
      const parts: string[] = [];
      if (r.profileName !== undefined) parts.push(`profile=${r.profileName}`);
      if (r.modelAlias !== undefined) parts.push(`model=${r.modelAlias}`);
      if (r.cwd !== undefined) parts.push(`cwd=${r.cwd}`);
      if (r.thinkingEffort !== undefined) parts.push(`thinking=${r.thinkingEffort}`);
      if (r.systemPrompt !== undefined) parts.push(`system(${r.systemPrompt.length}b)`);
      return {
        main: (
          <span className="truncate text-fg-0">
            {parts.length === 0 ? <Dim>(no fields)</Dim> : parts.join(' · ')}
          </span>
        ),
      };
    },
  },

  'profile.bind': {
    tone: 'config',
    label: 'profile',
    headline: (r) => {
      const parts: string[] = [];
      if (r.profileName !== undefined) parts.push(`profile=${r.profileName}`);
      if (r.modelAlias !== undefined) parts.push(`model=${r.modelAlias}`);
      if (r.thinkingEffort !== undefined) parts.push(`thinking=${r.thinkingEffort}`);
      if (r.activeToolNames !== undefined) {
        parts.push(`${r.activeToolNames.length} tools`);
      } else {
        parts.push('all tools');
      }
      return {
        main: (
          <span className="truncate text-fg-0">
            {parts.length === 0 ? <Dim>(no fields)</Dim> : parts.join(' · ')}
          </span>
        ),
      };
    },
  },

  'turn.prompt': {
    tone: 'turn',
    label: 'prompt',
    headline: (r) => {
      const text = firstText(r.input);
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone="turn" variant="soft">
              {r.origin.kind}
            </Pill>
            <span className="truncate text-fg-1">→ {truncate(text, 80)}</span>
          </span>
        ),
      };
    },
    detail: (r) => (
      <div className="space-y-2">
        <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
          <FieldRow label="origin" wide>
            <JsonViewer value={r.origin} defaultOpenDepth={2} />
          </FieldRow>
        </div>
        <div>
          <div className="mb-1 text-fg-2">
            input ({r.input.length} part{r.input.length === 1 ? '' : 's'})
          </div>
          <div className="space-y-1">
            {r.input.map((part, i) => (
              <ContentPartView key={i} part={part} />
            ))}
          </div>
        </div>
      </div>
    ),
  },

  'turn.steer': {
    tone: 'turn',
    label: 'steer',
    headline: (r) => {
      const text = firstText(r.input);
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone="turn" variant="soft">
              {r.origin.kind}
            </Pill>
            <span className="truncate text-fg-1">→ {truncate(text, 80)}</span>
          </span>
        ),
      };
    },
    detail: (r) => (
      <div className="space-y-2">
        <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
          <FieldRow label="origin" wide>
            <JsonViewer value={r.origin} defaultOpenDepth={2} />
          </FieldRow>
        </div>
        <div>
          <div className="mb-1 text-fg-2">
            input ({r.input.length} part{r.input.length === 1 ? '' : 's'})
          </div>
          <div className="space-y-1">
            {r.input.map((part, i) => (
              <ContentPartView key={i} part={part} />
            ))}
          </div>
        </div>
      </div>
    ),
  },

  'turn.cancel': {
    tone: 'warning',
    label: 'cancel',
    headline: (r) => ({
      main: <Mono>{r.turnId !== undefined ? `turn ${r.turnId}` : '(latest)'}</Mono>,
    }),
  },

  'context.append_message': {
    tone: 'assistant',
    label: 'message',
    headline: (r) => {
      const m = r.message;
      const tc = m.toolCalls.length > 0 ? `${m.toolCalls.length} tool_call(s)` : '';
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill
              tone={
                m.role === 'user'
                  ? 'user'
                  : m.role === 'assistant'
                    ? 'assistant'
                    : m.role === 'tool'
                      ? 'tool'
                      : 'meta'
              }
              variant="soft"
            >
              {m.role}
            </Pill>
            <Dim>({m.content.length} part{m.content.length === 1 ? '' : 's'})</Dim>
            {tc ? <Dim>· {tc}</Dim> : null}
            {m.origin?.kind ? <Dim>· origin={m.origin.kind}</Dim> : null}
          </span>
        ),
        right: m.isError === true ? (
          <Pill tone="error" variant="solid">
            error
          </Pill>
        ) : undefined,
      };
    },
    detail: (r) => <MessageDetail message={r.message} />,
  },

  'context.append_loop_event': {
    tone: 'meta',
    label: 'loop',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Mono>{r.event.type}</Mono>
          <Dim className="truncate">{loopEventSummary(r.event)}</Dim>
        </span>
      ),
    }),
    detail: (r) => <LoopEventDetail event={r.event} />,
  },

  'context.update_token_count': {
    tone: 'meta',
    label: 'tokens',
    headline: (r) => ({ main: <Dim>context {r.tokenCount} tok</Dim> }),
  },

  'context.clear': {
    tone: 'warning',
    label: 'clear',
    headline: () => ({ main: <Dim>context cleared</Dim> }),
  },

  'context.apply_compaction': {
    tone: 'compaction',
    label: 'compacted',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Pill tone="compaction" variant="soft">
            compacted
          </Pill>
          <Dim>
            summary {r.summary.length}b · {r.tokensBefore}→{r.tokensAfter} tok · {r.compactedCount}{' '}
            msgs
          </Dim>
        </span>
      ),
    }),
    detail: (r) => (
      <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
        <FieldRow label="summary" wide>
          <SizePreview label="summary" sizeBytes={r.summary.length} preview={r.summary}>
            <pre className="whitespace-pre-wrap break-words text-fg-1">{r.summary}</pre>
          </SizePreview>
        </FieldRow>
        <FieldRow label="compactedCount">
          <span className="text-[var(--color-sev-info)]">{r.compactedCount}</span>
        </FieldRow>
        <FieldRow label="tokensBefore">
          <span className="text-[var(--color-sev-info)]">{r.tokensBefore}</span>
        </FieldRow>
        <FieldRow label="tokensAfter">
          <span className="text-[var(--color-sev-info)]">{r.tokensAfter}</span>
        </FieldRow>
      </div>
    ),
  },

  'context.undo': {
    tone: 'warning',
    label: 'undo',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2">
          <Pill tone="warning" variant="soft">
            undo
          </Pill>
          <Dim>
            {r.count} prompt{r.count === 1 ? '' : 's'}
          </Dim>
        </span>
      ),
    }),
  },

  'tools.register_user_tool': {
    tone: 'tools',
    label: 'tool+',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2">
          <Mono className="text-[var(--color-cat-tools)]">+ {r.name}</Mono>
        </span>
      ),
    }),
  },

  'tools.unregister_user_tool': {
    tone: 'tools',
    label: 'tool-',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2">
          <Mono className="text-[var(--color-sev-warning)]">- {r.name}</Mono>
        </span>
      ),
    }),
  },

  'tools.set_active_tools': {
    tone: 'tools',
    label: 'tools',
    headline: (r) => {
      const head = r.names.slice(0, 3).join(', ');
      const rest = r.names.length > 3 ? ` +${r.names.length - 3} more` : '';
      return {
        main: (
          <Mono className="truncate">
            {head}
            {rest}
          </Mono>
        ),
        right: <Dim>{r.names.length} tools</Dim>,
      };
    },
  },

  'tools.reset_active_tools': {
    tone: 'tools',
    label: 'reset',
    headline: () => ({
      main: <Mono>all tools active</Mono>,
    }),
  },

  'tools.update_store': {
    tone: 'meta',
    label: 'store',
    headline: (r) => {
      const valuePreview =
        typeof r.value === 'object' && r.value !== null
          ? '(object)'
          : truncate(String(r.value), 60);
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono>{r.key}</Mono>
            <Dim>= {valuePreview}</Dim>
          </span>
        ),
      };
    },
  },

  'permission.set_mode': {
    tone: 'approval',
    label: 'perm',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2">
          <Dim>mode →</Dim>
          <Pill tone="approval" variant="soft">
            {r.mode}
          </Pill>
        </span>
      ),
    }),
  },

  'permission.record_approval_result': {
    tone: 'approval',
    label: 'approval',
    headline: (r) => {
      const tone =
        r.result.decision === 'approved'
          ? 'success'
          : r.result.decision === 'rejected'
            ? 'error'
            : 'neutral';
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono>
              {r.toolName}#{r.toolCallId.slice(-8)}
            </Mono>
            <Pill tone={tone} variant="soft">
              {r.result.decision}
            </Pill>
            {r.result.scope ? <Dim>({r.result.scope})</Dim> : null}
          </span>
        ),
      };
    },
    detail: (r) => (
      <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
        <FieldRow label="toolName">
          <Mono>{r.toolName}</Mono>
        </FieldRow>
        <FieldRow label="toolCallId">
          <Mono>{r.toolCallId}</Mono>
        </FieldRow>
        <FieldRow label="action">
          <Mono>{r.action}</Mono>
        </FieldRow>
        <FieldRow label="turnId">
          <span className="text-[var(--color-sev-info)]">{r.turnId}</span>
        </FieldRow>
        <FieldRow label="decision">
          <span className="text-fg-0">{r.result.decision}</span>
        </FieldRow>
        {r.result.scope !== undefined ? (
          <FieldRow label="scope">
            <Mono>{r.result.scope}</Mono>
          </FieldRow>
        ) : null}
        {r.sessionApprovalRule !== undefined ? (
          <FieldRow label="sessionApprovalRule" wide>
            <Mono className="break-all">{r.sessionApprovalRule}</Mono>
          </FieldRow>
        ) : null}
        {r.result.selectedLabel !== undefined ? (
          <FieldRow label="selectedLabel" wide>
            <Mono className="break-all">{r.result.selectedLabel}</Mono>
          </FieldRow>
        ) : null}
        {r.result.feedback !== undefined ? (
          <FieldRow label="feedback" wide>
            <pre className="whitespace-pre-wrap break-words text-fg-1">{r.result.feedback}</pre>
          </FieldRow>
        ) : null}
      </div>
    ),
  },

  'usage.record': {
    tone: 'meta',
    label: 'usage',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Mono>{r.model}</Mono>
          <Dim>
            in {r.usage.inputOther} / out {r.usage.output} / cache r{r.usage.inputCacheRead} w
            {r.usage.inputCacheCreation}
          </Dim>
        </span>
      ),
      right: r.usageScope ? (
        <Pill tone="meta" variant="outline">
          {r.usageScope}
        </Pill>
      ) : undefined,
    }),
  },

  'full_compaction.begin': {
    tone: 'compaction',
    label: 'compact↻',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Pill tone="compaction" variant="soft">
            {r.source}
          </Pill>
          {r.instruction ? (
            <Dim className="truncate">"{truncate(r.instruction, 40)}"</Dim>
          ) : null}
        </span>
      ),
    }),
  },

  'full_compaction.cancel': {
    tone: 'warning',
    label: 'compact×',
    headline: () => ({ main: <Dim>cancelled</Dim> }),
  },

  // `full_compaction.complete` has an EMPTY payload (`{}`). The previous code
  // read `r.summary` / `r.compactedCount` / `r.tokensBefore` / `r.tokensAfter`,
  // none of which exist on this record — a runtime crash. Those fields belong
  // to `context.apply_compaction` (its own entry above). This is a static,
  // payload-free renderer; the generic JSON dump shows type + time only.
  'full_compaction.complete': {
    tone: 'success',
    label: 'compact✓',
    headline: () => ({ main: <Dim>compaction complete</Dim> }),
  },

  'micro_compaction.apply': {
    tone: 'compaction',
    label: 'µcompact',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Pill tone="compaction" variant="soft">
            micro
          </Pill>
          <Dim>cutoff {r.cutoff}</Dim>
        </span>
      ),
    }),
  },

  'plan_mode.enter': {
    tone: 'lifecycle',
    label: 'plan↻',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2">
          <Pill tone="lifecycle" variant="soft">
            enter
          </Pill>
          <Mono>{r.id}</Mono>
        </span>
      ),
    }),
  },

  'plan_mode.cancel': {
    tone: 'warning',
    label: 'plan×',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2">
          <Pill tone="warning" variant="soft">
            cancel
          </Pill>
          <Mono>{r.id ?? '(latest)'}</Mono>
        </span>
      ),
    }),
  },

  'plan_mode.exit': {
    tone: 'success',
    label: 'plan✓',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2">
          <Pill tone="success" variant="soft">
            exit
          </Pill>
          <Mono>{r.id ?? '(latest)'}</Mono>
        </span>
      ),
    }),
  },

  'swarm_mode.enter': {
    tone: 'subagent',
    label: 'swarm↻',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2">
          <Pill tone="subagent" variant="soft">
            enter
          </Pill>
          <Mono>{r.trigger}</Mono>
        </span>
      ),
    }),
  },

  'swarm_mode.exit': {
    tone: 'subagent',
    label: 'swarm✓',
    headline: () => ({ main: <Dim>swarm mode exited</Dim> }),
  },

  'dispatch_mode.set': {
    tone: 'config',
    label: 'dispatch',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2">
          <Pill tone={r.mode === 'off' ? 'warning' : 'config'} variant="soft">
            {r.mode}
          </Pill>
          <Dim>subagent dispatch mode</Dim>
        </span>
      ),
    }),
  },

  'goal.create': {
    tone: 'lifecycle',
    label: 'goal+',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Pill tone="lifecycle" variant="soft">
            goal
          </Pill>
          <span className="truncate text-fg-1">{r.objective}</span>
        </span>
      ),
    }),
  },

  'goal.update': {
    tone: 'lifecycle',
    label: 'goal',
    headline: (r) => {
      const parts: string[] = [];
      if (r.status !== undefined) parts.push(`status=${r.status}`);
      if (r.actor !== undefined) parts.push(`by=${r.actor}`);
      if (r.turnsUsed !== undefined) parts.push(`turns=${r.turnsUsed}`);
      if (r.tokensUsed !== undefined) parts.push(`tok=${r.tokensUsed}`);
      return {
        main: (
          <span className="truncate text-fg-1">
            {parts.length === 0 ? <Dim>(no change)</Dim> : parts.join(' · ')}
          </span>
        ),
      };
    },
  },

  'goal.clear': {
    tone: 'warning',
    label: 'goal×',
    headline: () => ({ main: <Dim>goal cleared</Dim> }),
  },

  // Observability records — the request trace (see agent-core records/types.ts).

  'llm.tools_snapshot': {
    tone: 'tools',
    label: 'req·tools',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Mono>
            {r.tools.length} tool{r.tools.length === 1 ? '' : 's'}
          </Mono>
          <Dim className="truncate">
            {r.tools
              .slice(0, 4)
              .map((tool) => tool.name)
              .join(', ')}
            {r.tools.length > 4 ? ` +${r.tools.length - 4} more` : ''}
          </Dim>
        </span>
      ),
      right: <Mono>#{r.hash.slice(0, 8)}</Mono>,
    }),
  },

  'llm.request': {
    tone: 'meta',
    label: 'llm→',
    headline: (r) => {
      const parts: string[] = [];
      if (r.turnStep !== undefined) parts.push(`step ${r.turnStep}`);
      if (r.attempt !== undefined) parts.push(`attempt ${r.attempt}`);
      parts.push(`${r.messageCount} msgs`);
      if (r.maxTokens !== undefined) parts.push(`max ${r.maxTokens} tok`);
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone={r.kind === 'compaction' ? 'compaction' : 'turn'} variant="soft">
              {r.kind}
            </Pill>
            <Mono>{r.model}</Mono>
            <Dim className="truncate">{parts.join(' · ')}</Dim>
          </span>
        ),
        right:
          r.projection !== undefined ? (
            <Pill tone="warning" variant="soft">
              {r.projection}
            </Pill>
          ) : undefined,
      };
    },
    detail: (r) => (
      <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
        <FieldRow label="provider">
          <Mono>{r.provider}</Mono>
        </FieldRow>
        <FieldRow label="model">
          <Mono>{r.model}</Mono>
        </FieldRow>
        {r.modelAlias !== undefined ? (
          <FieldRow label="modelAlias">
            <Mono>{r.modelAlias}</Mono>
          </FieldRow>
        ) : null}
        {r.thinkingEffort !== undefined ? (
          <FieldRow label="thinkingEffort">
            <Mono>{r.thinkingEffort}</Mono>
          </FieldRow>
        ) : null}
        {r.thinkingKeep !== undefined ? (
          <FieldRow label="thinkingKeep">
            <Mono>{r.thinkingKeep}</Mono>
          </FieldRow>
        ) : null}
        {r.temperature !== undefined ? (
          <FieldRow label="temperature">
            <span className="text-[var(--color-sev-info)]">{r.temperature}</span>
          </FieldRow>
        ) : null}
        {r.topP !== undefined ? (
          <FieldRow label="topP">
            <span className="text-[var(--color-sev-info)]">{r.topP}</span>
          </FieldRow>
        ) : null}
        {r.maxTokens !== undefined ? (
          <FieldRow label="maxTokens">
            <span className="text-[var(--color-sev-info)]">{r.maxTokens}</span>
          </FieldRow>
        ) : null}
        {r.betaApi !== undefined ? (
          <FieldRow label="betaApi">
            <Mono>{String(r.betaApi)}</Mono>
          </FieldRow>
        ) : null}
        <FieldRow label="toolSelect">
          <Mono>{String(r.toolSelect)}</Mono>
        </FieldRow>
        <FieldRow label="toolsHash" wide>
          <Mono className="break-all">{r.toolsHash}</Mono>
        </FieldRow>
        <FieldRow label="systemPromptHash" wide>
          <Mono className="break-all">{r.systemPromptHash}</Mono>
        </FieldRow>
        {r.systemPrompt !== undefined ? (
          <FieldRow label="systemPrompt" wide>
            <SizePreview
              label="systemPrompt"
              sizeBytes={r.systemPrompt.length}
              preview={r.systemPrompt}
            >
              <pre className="whitespace-pre-wrap break-words text-fg-1">{r.systemPrompt}</pre>
            </SizePreview>
          </FieldRow>
        ) : null}
        {r.droppedCount !== undefined ? (
          <FieldRow label="droppedCount">
            <span className="text-[var(--color-sev-info)]">{r.droppedCount}</span>
          </FieldRow>
        ) : null}
      </div>
    ),
  },

  'mcp.tools_discovered': {
    tone: 'tools',
    label: 'mcp·list',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Mono>{r.serverName}</Mono>
          <Dim>
            {r.tools.length} tool{r.tools.length === 1 ? '' : 's'} · {r.enabledNames.length}{' '}
            enabled
          </Dim>
        </span>
      ),
      right:
        r.collisions !== undefined && r.collisions.length > 0 ? (
          <Pill tone="warning" variant="soft">
            {r.collisions.length} collision{r.collisions.length === 1 ? '' : 's'}
          </Pill>
        ) : (
          <Mono>#{r.hash.slice(0, 8)}</Mono>
        ),
    }),
  },

  // Agora / reference-audit / asset-pipeline records. The first two are durable
  // authorization state (replayed); the `*.run` ones are observability only.

  'agora.lifecycle': {
    tone: 'lifecycle',
    label: 'agora↻',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Pill tone={stateTone(r.terminalState)} variant="soft">
            {r.phase}
          </Pill>
          <Mono>{r.runId.slice(0, 8)}</Mono>
          {r.insertedTask !== undefined ? <Dim className="truncate">{r.insertedTask}</Dim> : null}
        </span>
      ),
      right: r.terminalState !== undefined ? <Mono>{r.terminalState}</Mono> : undefined,
    }),
    detail: (r) => (
      <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
        <FieldRow label="runId">
          <Mono>{r.runId}</Mono>
        </FieldRow>
        <FieldRow label="transitionId">
          <Mono>{r.transitionId}</Mono>
        </FieldRow>
        <FieldRow label="phase">
          <Mono>{r.phase}</Mono>
        </FieldRow>
        <FieldRow label="sourceSessionId">
          <Mono>{r.sourceSessionId}</Mono>
        </FieldRow>
        <FieldRow label="capabilityEpoch">
          <Mono>{r.capabilityEpoch}</Mono>
        </FieldRow>
        <FieldRow label="capabilityHash" wide>
          <Mono className="break-all">{r.capabilityHash}</Mono>
        </FieldRow>
        {r.envelopeRevision !== undefined ? (
          <FieldRow label="envelopeRevision">
            <span className="text-[var(--color-sev-info)]">{r.envelopeRevision}</span>
          </FieldRow>
        ) : null}
        {r.originTask !== undefined ? (
          <FieldRow label="originTask" wide>
            <Mono className="break-all">{r.originTask}</Mono>
          </FieldRow>
        ) : null}
        {r.insertedTask !== undefined ? (
          <FieldRow label="insertedTask" wide>
            <Mono className="break-all">{r.insertedTask}</Mono>
          </FieldRow>
        ) : null}
        {r.targetTask !== undefined ? (
          <FieldRow label="targetTask" wide>
            <Mono className="break-all">{r.targetTask}</Mono>
          </FieldRow>
        ) : null}
        {r.materializationTransitionId !== undefined ? (
          <FieldRow label="materialization" wide>
            <Mono className="break-all">{r.materializationTransitionId}</Mono>
          </FieldRow>
        ) : null}
        {r.materializationHandoffPath !== undefined ? (
          <FieldRow label="handoffPath" wide>
            <Mono className="break-all">{r.materializationHandoffPath}</Mono>
          </FieldRow>
        ) : null}
        {r.materializationDigest !== undefined ? (
          <FieldRow label="digest" wide>
            <Mono className="break-all">{r.materializationDigest}</Mono>
          </FieldRow>
        ) : null}
      </div>
    ),
  },

  'agora.materialization_confirmation': {
    tone: 'approval',
    label: 'agora✓',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Pill tone={stateTone(r.state)} variant="soft">
            {r.state}
          </Pill>
          <Mono>{r.runId.slice(0, 8)}</Mono>
          <Dim>
            by {r.confirmedBy} · proposal rev {r.proposalRevision}
          </Dim>
        </span>
      ),
      right: <Mono>#{r.proposalHash.slice(0, 8)}</Mono>,
    }),
    detail: (r) => (
      <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
        <FieldRow label="runId">
          <Mono>{r.runId}</Mono>
        </FieldRow>
        <FieldRow label="sourceSessionId">
          <Mono>{r.sourceSessionId}</Mono>
        </FieldRow>
        <FieldRow label="lifecycleEpoch">
          <Mono>{r.lifecycleEpoch}</Mono>
        </FieldRow>
        <FieldRow label="proposalRevision">
          <span className="text-[var(--color-sev-info)]">{r.proposalRevision}</span>
        </FieldRow>
        <FieldRow label="runPacketRevision">
          <span className="text-[var(--color-sev-info)]">{r.runPacketRevision}</span>
        </FieldRow>
        <FieldRow label="proposalHash" wide>
          <Mono className="break-all">{r.proposalHash}</Mono>
        </FieldRow>
        {r.consumedBy !== undefined ? (
          <FieldRow label="consumedBy" wide>
            <Mono className="break-all">{r.consumedBy}</Mono>
          </FieldRow>
        ) : null}
      </div>
    ),
  },

  'agora.run': {
    tone: 'subagent',
    label: 'agora',
    headline: (r) => {
      const done = r.peers.filter((peer) => peer.status === 'completed').length;
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone={stateTone(r.terminalState)} variant="soft">
              {r.phase}
            </Pill>
            <Mono>{r.runId.slice(0, 8)}</Mono>
            <Dim className="truncate">
              {done}/{r.peers.length} peers · rev {r.packetRevision} · {r.hostRoute}
              {r.routeUpgrade === 'none' ? '' : ` · ${r.routeUpgrade}`}
            </Dim>
          </span>
        ),
        right: r.terminalState !== undefined ? <Mono>{r.terminalState}</Mono> : undefined,
      };
    },
    detail: (r) => (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
          <FieldRow label="runId">
            <Mono>{r.runId}</Mono>
          </FieldRow>
          <FieldRow label="necessity">
            <span className="flex items-center gap-2">
              <Mono>{r.necessity.outcome}</Mono>
              {r.necessity.forcedByUser ? (
                <Pill tone="warning" variant="soft">
                  forced
                </Pill>
              ) : null}
            </span>
          </FieldRow>
          <FieldRow label="explanation" wide>
            <span className="text-fg-1">{r.necessity.explanation}</span>
          </FieldRow>
          {r.referenceAuditGate !== undefined ? (
            <FieldRow label="auditGate" wide>
              <span className="flex items-center gap-2 min-w-0">
                <Pill tone={stateTone(r.referenceAuditGate.state)} variant="soft">
                  {r.referenceAuditGate.state}
                </Pill>
                <Dim className="truncate">{r.referenceAuditGate.reason}</Dim>
              </span>
            </FieldRow>
          ) : null}
          {r.insertedTask !== undefined ? (
            <FieldRow label="insertedTask" wide>
              <Mono className="break-all">{r.insertedTask}</Mono>
            </FieldRow>
          ) : null}
          {r.hostRecoveryResult !== undefined ? (
            <FieldRow label="hostRecovery" wide>
              <span className="text-fg-1">{r.hostRecoveryResult}</span>
            </FieldRow>
          ) : null}
        </div>
        {r.peers.length > 0 ? (
          <div className="flex flex-col gap-[2px]">
            {r.peers.map((peer) => (
              <div key={peer.peer} className="flex items-center gap-2 min-w-0">
                <Pill tone={stateTone(peer.status)} variant="soft">
                  {peer.status}
                </Pill>
                <Mono>{peer.peer}</Mono>
                <Dim className="truncate">
                  {peer.model ?? peer.backend ?? '(unrouted)'}
                  {peer.repairCount > 0 ? ` · ${peer.repairCount} repair` : ''}
                  {peer.error !== undefined ? ` · ${truncate(peer.error, 80)}` : ''}
                </Dim>
              </div>
            ))}
          </div>
        ) : null}
        <JsonViewer value={r.packet} defaultOpenDepth={1} />
      </div>
    ),
  },

  'agora.override': {
    tone: 'warning',
    label: 'agora!',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Pill tone="warning" variant="soft">
            {r.kind}
          </Pill>
          <Mono>{r.operationId}</Mono>
          <Dim>{r.state}</Dim>
        </span>
      ),
      right: <Mono>#{r.envelopeHash.slice(0, 8)}</Mono>,
    }),
  },

  'reference_audit.state': {
    tone: 'config',
    label: 'ref·state',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Pill tone={r.material ? 'info' : 'neutral'} variant="soft">
            {r.material ? 'material' : 'immaterial'}
          </Pill>
          <Dim>
            {r.references.length} reference{r.references.length === 1 ? '' : 's'}
          </Dim>
        </span>
      ),
      right: r.referenceHash !== undefined ? <Mono>#{r.referenceHash.slice(0, 8)}</Mono> : undefined,
    }),
    detail: (r) => <JsonViewer value={r.references} defaultOpenDepth={2} />,
  },

  'reference_audit.override': {
    tone: 'warning',
    label: 'ref!',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Pill tone={stateTone(r.state)} variant="soft">
            {r.state}
          </Pill>
          <Mono>{r.purpose}</Mono>
          <Dim className="truncate">{r.reason}</Dim>
        </span>
      ),
      right: <Mono>#{r.overrideHash.slice(0, 8)}</Mono>,
    }),
    detail: (r) => (
      <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
        <FieldRow label="operationId">
          <Mono>{r.operationId}</Mono>
        </FieldRow>
        <FieldRow label="referenceHash" wide>
          <Mono className="break-all">{r.referenceHash}</Mono>
        </FieldRow>
        {r.auditRunId !== undefined ? (
          <FieldRow label="auditRunId">
            <Mono>{r.auditRunId}</Mono>
          </FieldRow>
        ) : null}
        {r.consumedBy !== undefined ? (
          <FieldRow label="consumedBy" wide>
            <Mono className="break-all">{r.consumedBy}</Mono>
          </FieldRow>
        ) : null}
      </div>
    ),
  },

  'reference_audit.run': {
    tone: 'meta',
    label: 'ref·audit',
    headline: (r) => {
      const parts: string[] = [];
      if (r.intensity !== undefined) parts.push(r.intensity);
      parts.push(`${r.tracks.length} track${r.tracks.length === 1 ? '' : 's'}`);
      if (r.claimCount !== undefined) parts.push(`${r.claimCount} claims`);
      if (r.contradictionCount !== undefined && r.contradictionCount > 0) {
        parts.push(`${r.contradictionCount} contradictions`);
      }
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone={stateTone(r.terminalState)} variant="soft">
              {r.terminalState}
            </Pill>
            <Mono>{r.runId.slice(0, 8)}</Mono>
            <Dim className="truncate">
              {r.triggered ? parts.join(' · ') : `not triggered${r.reason === undefined ? '' : ` · ${r.reason}`}`}
            </Dim>
          </span>
        ),
        right:
          r.error !== undefined ? (
            <Pill tone="error" variant="soft">
              error
            </Pill>
          ) : undefined,
      };
    },
    detail: (r) => (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
          <FieldRow label="runId">
            <Mono>{r.runId}</Mono>
          </FieldRow>
          {r.referenceHash !== undefined ? (
            <FieldRow label="referenceHash" wide>
              <Mono className="break-all">{r.referenceHash}</Mono>
            </FieldRow>
          ) : null}
          {r.unknownCount !== undefined ? (
            <FieldRow label="unknownCount">
              <span className="text-[var(--color-sev-info)]">{r.unknownCount}</span>
            </FieldRow>
          ) : null}
          {r.licenseNoteCount !== undefined ? (
            <FieldRow label="licenseNotes">
              <span className="text-[var(--color-sev-info)]">{r.licenseNoteCount}</span>
            </FieldRow>
          ) : null}
          {r.error !== undefined ? (
            <FieldRow label="error" wide>
              <span className="text-[var(--color-sev-error)]">{r.error}</span>
            </FieldRow>
          ) : null}
        </div>
        {r.tracks.length > 0 ? (
          <div className="flex flex-col gap-[2px]">
            {r.tracks.map((track) => (
              <div key={track.trackId} className="flex items-center gap-2 min-w-0">
                <Pill tone={stateTone(track.status)} variant="soft">
                  {track.status}
                </Pill>
                <Mono>{track.workflowRole}</Mono>
                <Dim className="truncate">
                  {track.trackId}
                  {track.repairCount > 0 ? ' · repaired' : ''}
                  {track.reason === undefined ? '' : ` · ${track.reason}`}
                </Dim>
              </div>
            ))}
          </div>
        ) : null}
        {r.result !== undefined ? <JsonViewer value={r.result} defaultOpenDepth={1} /> : null}
      </div>
    ),
  },

  'asset_pipeline.run': {
    tone: 'tools',
    label: 'assets',
    headline: (r) => ({
      main: (
        <span className="flex items-center gap-2 min-w-0">
          <Pill tone={stateTone(r.terminalState)} variant="soft">
            {r.action}
          </Pill>
          <Mono>{r.runId.slice(0, 8)}</Mono>
          <Dim className="truncate">
            {r.bom.length} bom · {r.candidates.length} candidate
            {r.candidates.length === 1 ? '' : 's'} · {r.terminalState}
          </Dim>
        </span>
      ),
      right:
        r.error !== undefined ? (
          <Pill tone="error" variant="soft">
            error
          </Pill>
        ) : undefined,
    }),
    detail: (r) => (
      <div className="flex flex-col gap-2">
        {r.error !== undefined ? (
          <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
            <FieldRow label="error" wide>
              <span className="text-[var(--color-sev-error)]">{r.error}</span>
            </FieldRow>
          </div>
        ) : null}
        {r.bom.length > 0 ? <JsonViewer value={r.bom} defaultOpenDepth={1} /> : null}
        {r.candidates.length > 0 ? <JsonViewer value={r.candidates} defaultOpenDepth={1} /> : null}
        {r.execution !== undefined ? <JsonViewer value={r.execution} defaultOpenDepth={1} /> : null}
      </div>
    ),
  },
};

/** Look up a renderer by a runtime `type` string. Returns `undefined` for kinds
 *  outside the known union (best-effort parse of a future/legacy/foreign
 *  protocol), which the callers render via the generic fallback.
 *
 *  Legacy/foreign runtime-only kinds (e.g. `goal.account_usage`,
 *  `goal.continuation`, `background.stop`) are intentionally NOT given registry
 *  entries: they sit outside the typed `AgentRecord` union, so this returns
 *  `undefined` and they fall back to a readable generic render — `TypeBadge`
 *  shows the raw `type` string (neutral tone, `title` tooltip), the headline
 *  shows `(unknown record type: …)`, and the detail shows the full JSON. That is
 *  legible enough; no friendly-label map is warranted.
 *
 *  The `as unknown as` widening is the one place we sidestep TypeScript's
 *  correlated-union limitation: each entry's `headline`/`detail` is narrowed to
 *  its own kind, but at dispatch time we only have the union, so we widen the
 *  value to `WireRenderer<RecordType>` (callable with any `AgentRecord`). Safe
 *  because we only ever call it with the matching record. */
export function rendererFor(type: string): WireRenderer<RecordType> | undefined {
  return (WIRE_RENDERERS as unknown as Record<string, WireRenderer<RecordType>>)[type];
}
