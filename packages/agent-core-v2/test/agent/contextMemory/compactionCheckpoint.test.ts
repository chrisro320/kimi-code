/**
 * Compaction checkpoint carrier contract — wire round-trip, restore-time
 * degradation, and token-accounting semantics.
 *
 * The round-trip test is the heart of the contract: a checkpoint written by
 * the live path must come back BYTE-FOR-BYTE after persistence + replay,
 * bound to the summary message's `origin`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import {
  IAgentContextMemoryService,
  type ContextCompactionResult,
} from '#/agent/contextMemory/contextMemory';
import {
  buildContextCompactionShape,
  type TokenEstimate,
} from '#/agent/contextMemory/compactionHandoff';
import { AgentContextMemoryService } from '#/agent/contextMemory/contextMemoryService';
import { ContextModel } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentTokenCountingService,
} from '#/agent/tokenCounting/tokenCounting';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { WarningEvent } from '#/agent/profile/profileService';
import type { CompactionCheckpoint } from '#/kosong/contract/compaction';
import {
  estimateTokens,
  estimateTokensForMessage,
  estimateTokensForMessages,
} from '#/kosong/contract/tokens';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'checkpoint-live';
const REPLAY_KEY = 'checkpoint-replay';

/** Long, special-character-laden opaque payload — no test-friendly shortcut. */
const ENCRYPTED =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.±§\u0001\uFFFF — "quotes" \\ backslash \n newline ' +
  'A'.repeat(512) +
  '==/+/==';

function makeCheckpoint(overrides: Partial<CompactionCheckpoint> = {}): CompactionCheckpoint {
  return {
    encrypted: ENCRYPTED,
    itemType: 'compaction',
    itemId: 'cmp_abc123',
    lineage: { provider: 'openai', model: 'gpt-x', baseUrl: 'https://api.openai.com/v1' },
    replayInputTokens: { kind: 'measured', tokens: 500 },
    ...overrides,
  };
}

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

interface Host {
  wire: IWireService;
  svc: IAgentContextMemoryService;
  log: IAppendLogStore;
  eventBus: IEventBus;
}

let disposables: DisposableStore;

function buildHost(key: string): Host {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.stub(IAgentTokenCountingService, {
    estimateText: estimateTokens,
    estimateMessage: estimateTokensForMessage,
    estimateMessages: estimateTokensForMessages,
  } as unknown as IAgentTokenCountingService);
  ix.set(IAgentContextMemoryService, new SyncDescriptor(AgentContextMemoryService));
  const eventBus = ix.get(IEventBus);
  const wire = registerTestAgentWire(ix, testWireScope(SCOPE, key), {
    log: ix.get(IAppendLogStore),
    eventBus,
  });
  return { wire, svc: ix.get(IAgentContextMemoryService), log: ix.get(IAppendLogStore), eventBus };
}

async function readRecords(log: IAppendLogStore, key: string): Promise<WireRecord[]> {
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, key), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

function restoredModel(host: Host): readonly ContextMessage[] {
  return host.wire.getModel(ContextModel) as readonly ContextMessage[];
}

beforeEach(() => {
  disposables = new DisposableStore();
});

afterEach(() => {
  resetUnexpectedErrorHandler();
  disposables.dispose();
});

describe('compaction checkpoint carrier', () => {
  it('round-trips the checkpoint byte-for-byte through dispatch → persist → restore', async () => {
    const host = buildHost(KEY);
    host.svc.append(userMessage('old fact'));
    host.svc.append(userMessage('recent question'));
    const checkpoint = makeCheckpoint();
    const result = host.svc.applyCompaction({
      summary: 'summary of old fact',
      compactedCount: 2,
      tokensBefore: 1234,
      checkpoint,
    });
    expect(result.checkpoint).toEqual(checkpoint);

    await host.wire.flush();
    const records = await readRecords(host.log, KEY);
    const record = records.find((r) => r.type === 'context.apply_compaction');
    expect(record).toBeDefined();
    expect(record!['checkpoint']).toEqual(checkpoint);
    expect((record!['checkpoint'] as CompactionCheckpoint).encrypted).toBe(ENCRYPTED);

    const replay = buildHost(REPLAY_KEY);
    await restoreTestAgentWire(replay.wire, replay.log, testWireScope(SCOPE, REPLAY_KEY), records);

    const model = restoredModel(replay);
    const summary = model.find((m) => m.origin?.kind === 'compaction_summary');
    expect(summary).toBeDefined();
    expect(summary!.origin?.kind === 'compaction_summary' && summary!.origin.checkpoint).toEqual(
      checkpoint,
    );
    const restored = summary!.origin as { checkpoint?: CompactionCheckpoint };
    expect(restored.checkpoint!.encrypted).toBe(ENCRYPTED);
    expect(restored.checkpoint!.encrypted.length).toBe(ENCRYPTED.length);
  });

  it('legacy records without a checkpoint field restore exactly as before', async () => {
    const variants: { name: string; record: WireRecord }[] = [
      {
        name: 'summary + contextSummary',
        record: {
          type: 'context.apply_compaction',
          summary: 'human summary',
          contextSummary: 'model summary',
          compactedCount: 1,
          tokensBefore: 100,
          tokensAfter: 20,
        },
      },
      {
        name: 'contextSummary only',
        record: {
          type: 'context.apply_compaction',
          contextSummary: 'model summary',
          compactedCount: 1,
          tokensBefore: 100,
          tokensAfter: 20,
        },
      },
      {
        name: 'legacy summary message + count',
        record: {
          type: 'context.apply_compaction',
          summary: {
            role: 'assistant',
            content: [{ type: 'text', text: 'legacy summary' }],
            toolCalls: [],
            origin: { kind: 'compaction_summary' },
          },
          count: 1,
        },
      },
    ];

    for (const [index, variant] of variants.entries()) {
      const key = `${REPLAY_KEY}-legacy-${index}`;
      const host = buildHost(key);
      await restoreTestAgentWire(host.wire, host.log, testWireScope(SCOPE, key), [
        { type: 'context.append_message', message: userMessage('old') },
        { type: 'context.append_message', message: userMessage('tail') },
        variant.record,
      ]);
      const model = restoredModel(host);
      const summary = model.find((m) => m.origin?.kind === 'compaction_summary');
      expect(summary, variant.name).toBeDefined();
      expect(summary!.origin, variant.name).not.toHaveProperty('checkpoint');
      expect(model.some((m) => m.content[0]!.type === 'text' && m.content[0]!.text === 'tail')).toBe(true);
    }
  });

  it('a malformed checkpoint degrades to summary-only replay WITH a diagnostic', async () => {
    const diagnostics: unknown[] = [];
    setUnexpectedErrorHandler((err) => diagnostics.push(err));

    const key = `${REPLAY_KEY}-malformed`;
    const host = buildHost(key);
    await restoreTestAgentWire(host.wire, host.log, testWireScope(SCOPE, key), [
      { type: 'context.append_message', message: userMessage('old') },
      {
        type: 'context.apply_compaction',
        summary: 'valid summary',
        compactedCount: 1,
        tokensBefore: 100,
        tokensAfter: 20,
        checkpoint: { encrypted: 123 },
      },
    ]);

    const model = restoredModel(host);
    const summary = model.find((m) => m.origin?.kind === 'compaction_summary');
    // The compaction record itself survived — only the checkpoint was dropped.
    expect(summary).toBeDefined();
    expect(summary!.origin).not.toHaveProperty('checkpoint');
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('checkpoint replay tokens REPLACE the summary contribution (measured)', () => {
    const estimate: TokenEstimate = {
      text: () => 1000,
      message: () => 100,
      messages: (ms) => ms.length * 100,
    };
    const shape = buildContextCompactionShape(
      [userMessage('a'), userMessage('b')],
      {
        summary: 's',
        compactedCount: 2,
        tokensBefore: 5000,
        checkpoint: makeCheckpoint(),
      },
      estimate,
    );
    // 500 (checkpoint replay) + 200 (two retained messages) — NOT + 1000 summary.
    expect(shape.tokensAfter).toBe(700);
    expect(shape.estimateNote).toBeUndefined();
  });

  it('checkpoint replay tokens REPLACE the summary contribution (unknown books 0 + estimate note)', () => {
    const diagnostics: unknown[] = [];
    setUnexpectedErrorHandler((err) => diagnostics.push(err));
    const estimate: TokenEstimate = {
      text: () => 1000,
      message: () => 100,
      messages: (ms) => ms.length * 100,
    };
    const shape = buildContextCompactionShape(
      [userMessage('a'), userMessage('b')],
      {
        summary: 's',
        compactedCount: 2,
        tokensBefore: 5000,
        checkpoint: makeCheckpoint({ replayInputTokens: { kind: 'unknown' } }),
      },
      estimate,
    );
    expect(shape.tokensAfter).toBe(200);
    // The unknown replay estimate is a NORMAL contract branch — it must not
    // trip the unexpected-error handler; the diagnostic rides out as a note
    // for the caller to surface as a warning instead.
    expect(diagnostics).toEqual([]);
    expect(shape.estimateNote).toBeTypeOf('string');
    expect(shape.estimateNote!).toMatch(/replay cost is unknown/);
  });

  it('live applyCompaction publishes exactly one warning for an unknown replay estimate', () => {
    const host = buildHost(KEY);
    const diagnostics: unknown[] = [];
    setUnexpectedErrorHandler((err) => diagnostics.push(err));
    const warnings: WarningEvent[] = [];
    disposables.add(
      host.eventBus.subscribe('warning', (event) => {
        warnings.push(event);
      }),
    );
    host.svc.append(userMessage('old fact'));
    host.svc.append(userMessage('recent question'));
    host.svc.applyCompaction({
      summary: 'summary of old fact',
      compactedCount: 2,
      tokensBefore: 1234,
      checkpoint: makeCheckpoint({ replayInputTokens: { kind: 'unknown' } }),
    });
    expect(diagnostics).toEqual([]);
    expect(warnings).toEqual([
      {
        type: 'warning',
        code: 'compaction-replay-estimate',
        message: expect.stringMatching(/post-compaction token count is an underestimate/) as string,
      },
    ]);
  });

  it('live applyCompaction with a measured replay estimate publishes no warning', () => {
    const host = buildHost(KEY);
    const warnings: WarningEvent[] = [];
    disposables.add(
      host.eventBus.subscribe('warning', (event) => {
        warnings.push(event);
      }),
    );
    host.svc.append(userMessage('old fact'));
    host.svc.applyCompaction({
      summary: 'summary of old fact',
      compactedCount: 1,
      tokensBefore: 1234,
      checkpoint: makeCheckpoint(),
    });
    expect(warnings).toEqual([]);
  });

  it('replay with an unknown replay estimate stays silent (no warning, no unexpected error)', async () => {
    const key = `${REPLAY_KEY}-unknown-silent`;
    const host = buildHost(key);
    const diagnostics: unknown[] = [];
    setUnexpectedErrorHandler((err) => diagnostics.push(err));
    const warnings: WarningEvent[] = [];
    disposables.add(
      host.eventBus.subscribe('warning', (event) => {
        warnings.push(event);
      }),
    );
    await restoreTestAgentWire(host.wire, host.log, testWireScope(SCOPE, key), [
      { type: 'context.append_message', message: userMessage('old') },
      {
        type: 'context.apply_compaction',
        summary: 'valid summary',
        compactedCount: 1,
        tokensBefore: 100,
        tokensAfter: 20,
        // Without this the record reads as the legacy tail shape, which never
        // consults the checkpoint — the unknown branch must actually run.
        keptUserMessageCount: 1,
        checkpoint: makeCheckpoint({ replayInputTokens: { kind: 'unknown' } }),
      },
    ]);

    const model = restoredModel(host);
    expect(model.some((m) => m.origin?.kind === 'compaction_summary')).toBe(true);
    // The replay path has no event bus — the estimate note is dropped silently.
    expect(diagnostics).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('a restored checkpoint is not double-counted by the message estimator', async () => {
    const key = `${REPLAY_KEY}-double-count`;
    const host = buildHost(key);
    const checkpoint = makeCheckpoint();
    await restoreTestAgentWire(host.wire, host.log, testWireScope(SCOPE, key), [
      { type: 'context.append_message', message: userMessage('tail') },
      {
        type: 'context.apply_compaction',
        summary: 'summary',
        compactedCount: 1,
        tokensBefore: 100,
        tokensAfter: 20,
        checkpoint,
      },
    ]);

    const model = restoredModel(host);
    // The estimator is origin-blind: stripping origin must not change the count,
    // so the checkpoint can never be booked twice.
    const withOrigin = estimateTokensForMessages(model);
    const stripped = model.map(({ origin: _origin, ...rest }) => rest as ContextMessage);
    expect(estimateTokensForMessages(stripped)).toBe(withOrigin);
  });

  it('live result exposes the checkpoint and the wire record matches the live history', async () => {
    const host = buildHost(KEY);
    host.svc.append(userMessage('fact'));
    const checkpoint = makeCheckpoint();
    const result: ContextCompactionResult = host.svc.applyCompaction({
      summary: 's',
      compactedCount: 1,
      tokensBefore: 100,
      checkpoint,
    });
    expect(result.checkpoint?.encrypted).toBe(ENCRYPTED);

    const live = restoredModel(host);
    const summary = live.find((m) => m.origin?.kind === 'compaction_summary');
    expect(summary!.origin).toMatchObject({ kind: 'compaction_summary', checkpoint });
  });
});
