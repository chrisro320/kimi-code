import { describe, expect, it } from 'vitest';

import { buildReplay } from '../../../src';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  InMemoryAgentRecordPersistence,
  type AgentRecord,
} from '../../../src/agent/records';
import type { ContextMessage } from '../../../src/agent/context';
import { testAgent } from '../harness/agent';

describe('AgentRecords persistence metadata', () => {
  it('writes metadata before the first persisted record', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const records = testAgent({ persistence }).agent.records;

    records.logRecord({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'hello' }],
      origin: { kind: 'user' },
    });
    await records.flush();

    expect(persistence.records).toHaveLength(2);
    expect(persistence.records[0]).toMatchObject({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    });
    expect(persistence.records[0]).not.toHaveProperty('app_version');
    expect(persistence.records[0]).not.toHaveProperty('resumed');
    expect(persistence.records[1]?.type).toBe('turn.prompt');
    expect(records.latest('turn.prompt')).toMatchObject({
      input: [{ type: 'text', text: 'hello' }],
    });
  });

  it('keeps Agora lifecycle projections keyed by run across interleaved replay', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const records = testAgent({ persistence }).agent.records;
    const lifecycle = (runId: string, transitionId: string, phase: 'packet_confirmation' | 'peer_review') => ({
      type: 'agora.lifecycle' as const,
      runId,
      transitionId,
      phase,
      insertedTask: `.trellis/tasks/${runId}`,
      sourceSessionId: 'session-1',
      capabilityEpoch: `${runId}-${transitionId}`,
      capabilityHash: 'a'.repeat(64),
    });
    const run = (runId: string, phase: string) => ({
      type: 'agora.run' as const,
      runId,
      phase,
      packetRevision: 1,
      packet: {},
      necessity: {
        outcome: 'allowed_on_request' as const,
        signals: {
          impactIfWrong: 'medium' as const,
          uncertaintyOrDisagreement: 'medium' as const,
          expectedInformationGain: 'medium' as const,
          incrementalCostLatency: 'medium' as const,
        },
        explanation: 'test',
        normalWorkflowRecommendation: 'test',
        forcedByUser: false,
      },
      routes: {},
      peers: [],
      temporaryOverrides: {},
      hostRoute: 'coder' as const,
      routeUpgrade: 'none' as const,
    });

    records.logRecord(lifecycle('run-a', 'a-1', 'packet_confirmation'));
    records.logRecord(run('run-a', 'peer_review'));
    records.logRecord(lifecycle('run-b', 'b-1', 'packet_confirmation'));
    records.logRecord(run('run-b', 'synthesis'));
    records.logRecord(lifecycle('run-a', 'a-2', 'peer_review'));
    await records.flush();

    expect(records.latestAgoraLifecycle('run-a')).toMatchObject({ transitionId: 'a-2' });
    expect(records.latestAgoraLifecycle('run-b')).toMatchObject({ transitionId: 'b-1' });
    expect(records.latestAgoraRun('run-a')).toMatchObject({ phase: 'peer_review' });
    expect(records.latestAgoraRun('run-b')).toMatchObject({ phase: 'synthesis' });

    const replayed = testAgent({
      persistence: new InMemoryAgentRecordPersistence(persistence.records),
    }).agent;
    await replayed.records.replay();
    expect(replayed.records.latestAgoraLifecycle('run-a')).toMatchObject({ transitionId: 'a-2' });
    expect(replayed.records.latestAgoraLifecycle('run-b')).toMatchObject({ transitionId: 'b-1' });
    expect(replayed.records.latestAgoraRun('run-a')).toMatchObject({ phase: 'peer_review' });
    expect(replayed.records.latestAgoraRun('run-b')).toMatchObject({ phase: 'synthesis' });
  });

  it('does not write metadata when replaying an empty stream', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const records = testAgent({ persistence }).agent.records;

    await records.replay();
    records.logRecord({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'one' }],
      origin: { kind: 'user' },
    });
    await records.flush();

    expect(persistence.records.map((record) => record.type)).toEqual([
      'metadata',
      'turn.prompt',
    ]);
  });

  it('rejects replaying a non-empty stream without metadata', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'one' }],
        origin: { kind: 'user' },
      },
    ]);
    const records = testAgent({ persistence }).agent.records;

    await expect(records.replay()).rejects.toThrow(
      'AgentRecords replay expected metadata as the first record',
    );
  });

  it('does not duplicate metadata after replaying existing records', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'one' }],
        origin: { kind: 'user' },
      },
    ]);
    const records = testAgent({ persistence }).agent.records;

    await records.replay();
    records.logRecord({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'two' }],
      origin: { kind: 'user' },
    });
    await records.flush();

    expect(persistence.records.map((record) => record.type)).toEqual([
      'metadata',
      'turn.prompt',
      'turn.prompt',
    ]);
    expect(persistence.records.filter((record) => record.type === 'metadata')).toHaveLength(1);
  });

  it('replays a reference_audit.run record as a no-op observability entry', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const records = testAgent({ persistence }).agent.records;

    records.logRecord({
      type: 'reference_audit.run',
      runId: 'audit-1',
      triggered: true,
      intensity: 'standard',
      referenceHash: 'a'.repeat(64),
      planHash: 'plan-hash',
      resultHash: 'result-hash',
      tracks: [
        { trackId: 'reference-a', workflowRole: 'source-explore', status: 'completed', repairCount: 0 },
      ],
      claimCount: 1,
      contradictionCount: 0,
      unknownCount: 0,
      licenseNoteCount: 0,
      terminalState: 'completed',
    });
    await records.flush();

    const replayed = testAgent({ persistence: new InMemoryAgentRecordPersistence(persistence.records) }).agent;
    const warning = await replayed.records.replay();

    expect(warning).toEqual({});
    expect(replayed.records.latest('reference_audit.run')).toMatchObject({
      runId: 'audit-1',
      referenceHash: 'a'.repeat(64),
      terminalState: 'completed',
    });
    expect(persistence.records.map((record) => record.type)).toEqual([
      'metadata',
      'reference_audit.run',
    ]);
  });

  it('replays an asset_pipeline.run record as a no-op durable artifact entry', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const records = testAgent({ persistence }).agent.records;

    records.logRecord({
      type: 'asset_pipeline.run',
      runId: 'assets-1',
      action: 'discover_candidates',
      bom: [],
      candidates: [],
      rawDiscoveryResponses: [{
        bomItemId: 'icon-1',
        response: '{"candidates":[]}',
        status: 'completed',
      }],
      terminalState: 'completed',
    });
    await records.flush();

    const replayed = testAgent({ persistence: new InMemoryAgentRecordPersistence(persistence.records) }).agent;
    await expect(replayed.records.replay()).resolves.toEqual({});
    expect(persistence.records.map((record) => record.type)).toEqual([
      'metadata',
      'asset_pipeline.run',
    ]);
  });

  it('does not rewrite records that already use the current wire version', async () => {
    const persistence = new RecordingInMemoryAgentRecordPersistence([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'one' }],
        origin: { kind: 'user' },
      },
    ]);
    const records = testAgent({ persistence }).agent.records;

    await records.replay();

    expect(persistence.rewrites).toEqual([]);
  });

  it('rewrites migrated records to the current wire version after replay', async () => {
    const persistence = new RecordingInMemoryAgentRecordPersistence([
      {
        type: 'metadata',
        protocol_version: '1.0',
        created_at: 1,
      },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              type: 'function',
              id: 'call_legacy_bash',
              function: {
                name: 'Bash',
                arguments: '{"command":"pwd"}',
              },
            },
          ],
        },
      } as unknown as AgentRecord,
    ]);
    const records = testAgent({ persistence }).agent.records;

    await records.replay();

    expect(persistence.rewrites).toHaveLength(1);
    expect(persistence.records[0]).toMatchObject({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    });
    const migrated = persistence.records[1] as unknown as {
      readonly message: {
        readonly toolCalls: readonly Record<string, unknown>[];
      };
    };
    expect(migrated.message.toolCalls[0]).toMatchObject({
      name: 'Bash',
      arguments: '{"command":"pwd"}',
    });
    expect(migrated.message.toolCalls[0]?.['function']).toBeUndefined();
  });

  it('replays legacy tool-baked <system> metadata verbatim without migration', async () => {
    // Pre-note records carry tool metadata inline in the output. They are
    // intentionally NOT migrated: the model view stays byte-identical to
    // what the model originally saw, and UIs show the legacy text as-is.
    const summary =
      '<system>Read image file. Mime type: image/png. Size: 70 bytes. ' +
      'Original dimensions: 4x2 pixels.</system>';
    const legacyOutput = [
      { type: 'text', text: summary },
      { type: 'text', text: '<image path="/tmp/a.png">' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,A' } },
      { type: 'text', text: '</image>' },
    ];
    const persistence = new RecordingInMemoryAgentRecordPersistence([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 's1', turnId: 't', step: 1 },
      } as unknown as AgentRecord,
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call_media',
          turnId: 't',
          step: 1,
          stepUuid: 's1',
          toolCallId: 'call_media',
          name: 'ReadMediaFile',
          args: {},
        },
      } as unknown as AgentRecord,
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'call_media',
          toolCallId: 'call_media',
          result: { output: legacyOutput },
        },
      } as unknown as AgentRecord,
    ]);
    const agent = testAgent({ persistence }).agent;

    await agent.records.replay();

    expect(persistence.rewrites).toEqual([]);
    const stored = agent.context.history.find((m) => m.toolCallId === 'call_media')!;
    expect(stored.note).toBeUndefined();
    expect(stored.content).toEqual(legacyOutput);

    // Projection passes the legacy content through untouched — the model
    // sees exactly the bytes it saw before the note side channel existed.
    const projected = agent.context.messages.find((m) => m.toolCallId === 'call_media')!;
    expect(projected.content).toEqual(legacyOutput);
  });

  it('warns but continues when replaying records from a newer wire version', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      {
        type: 'metadata',
        protocol_version: '9.9',
        created_at: 1,
      },
    ]);
    const records = testAgent({ persistence }).agent.records;

    const result = await records.replay();
    expect(result.warning).toContain('9.9');
    expect(result.warning).toContain(AGENT_WIRE_PROTOCOL_VERSION);
  });

  it('rejects replaying records without a registered migration path', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      {
        type: 'metadata',
        protocol_version: '0.9',
        created_at: 1,
      },
    ]);
    const records = testAgent({ persistence }).agent.records;

    await expect(records.replay()).rejects.toThrow('Missing wire migration for version 0.9');
  });

  it('replays a tools.set_active_tools record without names without crashing', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      // v2-engine wires may omit `names` (= every tool active); replaying
      // such a record must not throw.
      { type: 'tools.set_active_tools' } as unknown as AgentRecord,
      { type: 'goal.create', goalId: 'g1', objective: 'do work' } as AgentRecord,
    ]);
    const { agent } = testAgent({ persistence });

    await expect(agent.records.replay()).resolves.toEqual({ warning: undefined });
    // Replay continued past the names-less record.
    expect(agent.goal.getGoal().goal?.goalId).toBe('g1');
  });

  it('restores goal.* records during replay', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'goal.create',
        goalId: 'g1',
        objective: 'do work',
        completionCriterion: 'tests pass',
      },
      { type: 'goal.update', budgetLimits: { turnBudget: 20 } },
      { type: 'goal.update', tokensUsed: 5, wallClockMs: 0 },
      { type: 'goal.update', turnsUsed: 1 },
      { type: 'goal.update', status: 'blocked', reason: 'needs credentials', actor: 'model' },
    ]);
    const { agent } = testAgent({ persistence });

    await expect(agent.records.replay()).resolves.toEqual({ warning: undefined });
    expect(agent.context.history).toHaveLength(0);
    expect(agent.goal.getGoal().goal).toMatchObject({
      goalId: 'g1',
      objective: 'do work',
      completionCriterion: 'tests pass',
      status: 'blocked',
      terminalReason: 'needs credentials',
      tokensUsed: 5,
      turnsUsed: 1,
      budget: expect.objectContaining({ turnBudget: 20 }),
    });
    expect(agent.replayBuilder.buildResult()).toEqual([
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({ goalId: 'g1', status: 'active' }),
        change: { kind: 'created' },
      }),
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({
          goalId: 'g1',
          status: 'blocked',
          terminalReason: 'needs credentials',
        }),
        change: {
          kind: 'lifecycle',
          status: 'blocked',
          reason: 'needs credentials',
          actor: 'model',
        },
      }),
    ]);
  });

  it('restores forked records as fork boundaries that clear copied goals', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'goal.create',
        goalId: 'source-goal',
        objective: 'source work',
      },
      { type: 'forked', time: 2 },
    ]);
    const { agent } = testAgent({ persistence });

    await expect(agent.records.replay()).resolves.toEqual({ warning: undefined });

    expect(agent.goal.getGoal().goal).toBeNull();
    expect(persistence.records.map((record) => record.type)).toEqual([
      'metadata',
      'goal.create',
      'forked',
    ]);
    const reminder = agent.context.history.at(-1);
    expect(reminder?.origin).toEqual({ kind: 'system_trigger', name: 'goal_fork_cleared' });
    expect(JSON.stringify(reminder?.content)).toContain('This fork does not have a current goal.');
  });

  it('keeps goals created after the forked boundary', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'goal.create',
        goalId: 'source-goal',
        objective: 'source work',
      },
      { type: 'forked', time: 2 },
      {
        type: 'goal.create',
        goalId: 'fork-goal',
        objective: 'fork work',
      },
    ]);
    const { agent } = testAgent({ persistence });

    await expect(agent.records.replay()).resolves.toEqual({ warning: undefined });

    expect(agent.goal.getGoal().goal).toMatchObject({
      goalId: 'fork-goal',
      objective: 'fork work',
    });
    expect(agent.context.history.at(-1)?.origin).toEqual({
      kind: 'system_trigger',
      name: 'goal_fork_cleared',
    });
  });

  it('does not add a fork-cleared reminder when a forked record has no copied goal', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'forked', time: 2 },
    ]);
    const { agent } = testAgent({ persistence });

    await expect(agent.records.replay()).resolves.toEqual({ warning: undefined });

    expect(agent.goal.getGoal().goal).toBeNull();
    expect(agent.context.history).toHaveLength(0);
  });
});

describe('agent replay range build', () => {
  it('returns the complete replay when no range is requested', async () => {
    const firstMessage = userMessage('first');
    const afterClearMessage = userMessage('after-clear');
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'context.append_message', message: firstMessage },
      { type: 'context.clear' },
      { type: 'context.append_message', message: afterClearMessage },
    ]);

    await expect(buildReplay(persistence)).resolves.toEqual([
      expect.objectContaining({ type: 'message', message: firstMessage }),
      expect.objectContaining({ type: 'message', message: afterClearMessage }),
    ]);
  });

  it('applies start and count to replay records instead of wire records', async () => {
    const message = userMessage('hello');
    const persistence = new RecordingInMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'usage.record',
        model: 'mock-model',
        usage: { inputOther: 1, inputCacheRead: 0, inputCacheCreation: 0, output: 1 },
      },
      {
        type: 'config.update',
        cwd: process.cwd(),
        thinkingEffort: 'off',
      },
      {
        type: 'usage.record',
        model: 'mock-model',
        usage: { inputOther: 2, inputCacheRead: 0, inputCacheCreation: 0, output: 1 },
      },
      { type: 'permission.set_mode', mode: 'yolo' },
      { type: 'context.append_message', message },
    ]);

    const replay = await buildReplay(persistence, { start: 1, count: 2 });

    expect(replay).toEqual([
      expect.objectContaining({ type: 'permission_updated', mode: 'yolo' }),
      expect.objectContaining({ type: 'message', message }),
    ]);
    expect(persistence.rewrites).toEqual([]);
  });

  it('returns the last count replay records when start is omitted', async () => {
    const firstMessage = userMessage('first');
    const secondMessage = userMessage('second');
    const thirdMessage = userMessage('third');
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'context.append_message', message: firstMessage },
      { type: 'permission.set_mode', mode: 'auto' },
      { type: 'context.append_message', message: secondMessage },
      { type: 'context.append_message', message: thirdMessage },
    ]);

    await expect(buildReplay(persistence, { count: 2 })).resolves.toEqual([
      expect.objectContaining({ type: 'message', message: secondMessage }),
      expect.objectContaining({ type: 'message', message: thirdMessage }),
    ]);
    await expect(buildReplay(persistence, { count: 10 })).resolves.toEqual([
      expect.objectContaining({ type: 'message', message: firstMessage }),
      expect.objectContaining({ type: 'permission_updated', mode: 'auto' }),
      expect.objectContaining({ type: 'message', message: secondMessage }),
      expect.objectContaining({ type: 'message', message: thirdMessage }),
    ]);
  });

  it('continues reading all segments before returning the last count replay records', async () => {
    const beforeClearMessages = Array.from({ length: 50 }, (_item, index) =>
      userMessage(`before-clear-${String(index)}`),
    );
    const afterClearMessages = Array.from({ length: 50 }, (_item, index) =>
      userMessage(`after-clear-${String(index)}`),
    );
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      ...beforeClearMessages.map((message) => ({ type: 'context.append_message' as const, message })),
      { type: 'context.clear' },
      ...afterClearMessages.map((message) => ({ type: 'context.append_message' as const, message })),
    ]);

    const replay = await buildReplay(persistence, { count: 10 });

    expect(replay).toHaveLength(10);
    expect(replay).toEqual(
      afterClearMessages.slice(-10).map((message) =>
        expect.objectContaining({ type: 'message', message }),
      ),
    );
  });

  it('continues reading after count so later wire records can patch captured replay records', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'full_compaction.begin', source: 'manual', instruction: 'keep facts' },
      {
        type: 'context.apply_compaction',
        summary: 'Compacted summary.',
        compactedCount: 0,
        tokensBefore: 10,
        tokensAfter: 3,
      },
      { type: 'permission.set_mode', mode: 'auto' },
    ]);

    await expect(buildReplay(persistence, { start: 0, count: 1 })).resolves.toEqual([
      expect.objectContaining({
        type: 'compaction',
        instruction: 'keep facts',
        result: {
          summary: 'Compacted summary.',
          contextSummary: 'Compacted summary.',
          compactedCount: 0,
          tokensBefore: 10,
          tokensAfter: 3,
          keptUserMessageCount: 0,
        },
      }),
    ]);
  });

  it('does not rewrite migrated wire records while projecting', async () => {
    const persistence = new RecordingInMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: '1.0', created_at: 1 },
      { type: 'permission.set_mode', mode: 'auto' },
    ]);

    await expect(buildReplay(persistence, { start: 0, count: 1 })).resolves.toEqual([
      expect.objectContaining({ type: 'permission_updated', mode: 'auto' }),
    ]);
    expect(persistence.rewrites).toEqual([]);
  });

  it('keeps the start offset correct when undo removes more messages than count', async () => {
    const firstMessage = userMessage('first');
    const removedBeforeStart = userMessage('removed-before-start');
    const removedAtStart = userMessage('removed-at-start');
    const removedAfterStart = userMessage('removed-after-start');
    const nextMessage = userMessage('next');
    const expectedMessage = userMessage('expected');
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'context.append_message', message: firstMessage },
      { type: 'context.append_message', message: removedBeforeStart },
      { type: 'context.append_message', message: removedAtStart },
      { type: 'context.append_message', message: removedAfterStart },
      { type: 'context.undo', count: 3 },
      { type: 'context.append_message', message: nextMessage },
      { type: 'context.append_message', message: expectedMessage },
    ]);

    await expect(buildReplay(persistence, { start: 2, count: 1 })).resolves.toEqual([
      expect.objectContaining({ type: 'message', message: expectedMessage }),
    ]);
  });

  it('clamps results at undo boundaries', async () => {
    const firstMessage = userMessage('first');
    const secondMessage = userMessage('second');
    const afterClearMessage = userMessage('after-clear');
    const persistence = new InMemoryAgentRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'context.append_message', message: firstMessage },
      { type: 'context.append_message', message: secondMessage },
      { type: 'context.clear' },
      { type: 'context.append_message', message: afterClearMessage },
    ]);

    await expect(buildReplay(persistence, { start: 0, count: 10 })).resolves.toEqual([
      expect.objectContaining({ type: 'message', message: firstMessage }),
      expect.objectContaining({ type: 'message', message: secondMessage }),
    ]);
    await expect(buildReplay(persistence, { start: 2, count: 10 })).resolves.toEqual([
      expect.objectContaining({ type: 'message', message: afterClearMessage }),
    ]);
  });
});

class RecordingInMemoryAgentRecordPersistence extends InMemoryAgentRecordPersistence {
  readonly rewrites: AgentRecord[][] = [];

  override rewrite(records: readonly AgentRecord[]): void {
    this.rewrites.push([...records]);
    super.rewrite(records);
  }
}

function userMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}
