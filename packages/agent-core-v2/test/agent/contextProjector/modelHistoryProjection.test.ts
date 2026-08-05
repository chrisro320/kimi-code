import { describe, expect, it } from 'vitest';

import type { CompactionCheckpoint } from '#/kosong/contract/compaction';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  projectModelHistory,
  type CheckpointTarget,
} from '#/agent/contextProjector/modelHistoryProjection';

const SENTINEL = 'SECRET-SENTINEL';

const OWNING_LINEAGE = { provider: 'openai', model: 'gpt-x', baseUrl: 'https://api.openai.com' };

function makeCheckpoint(overrides: Partial<CompactionCheckpoint> = {}): CompactionCheckpoint {
  return {
    encrypted: SENTINEL,
    itemType: 'compaction',
    itemId: 'cmp_1',
    lineage: { ...OWNING_LINEAGE },
    replayInputTokens: { kind: 'measured', tokens: 500 },
    ...overrides,
  };
}

function summaryMessage(checkpoint?: CompactionCheckpoint): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'readable summary' }],
    toolCalls: [],
    origin: {
      kind: 'compaction_summary',
      ...(checkpoint !== undefined ? { checkpoint } : {}),
    },
  };
}

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

const supportingTarget: CheckpointTarget = {
  supportsCheckpointReplay: true,
  lineage: { ...OWNING_LINEAGE },
};

const incapableTarget: CheckpointTarget = {
  supportsCheckpointReplay: false,
  lineage: { ...OWNING_LINEAGE },
};

describe('projectModelHistory', () => {
  it('replaces an owned compaction summary with its checkpoint when the target supports replay', () => {
    const items = projectModelHistory([summaryMessage(makeCheckpoint())], supportingTarget);
    expect(items).toEqual([{ kind: 'checkpoint', checkpoint: makeCheckpoint() }]);
  });

  it('emits the checkpoint in the summary slot — after retained messages, order unchanged', () => {
    const items = projectModelHistory(
      [userMessage('kept-a'), userMessage('kept-b'), summaryMessage(makeCheckpoint())],
      supportingTarget,
    );
    expect(items.map((item) => item.kind)).toEqual(['message', 'message', 'checkpoint']);
    const last = items[2];
    expect(last).toMatchObject({ kind: 'checkpoint' });
  });

  it('falls back to the portable summary text when the target does not support replay', () => {
    const items = projectModelHistory([summaryMessage(makeCheckpoint())], incapableTarget);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('message');
  });

  it('falls back to the portable summary text when the lineage is not owned', () => {
    const items = projectModelHistory(
      [summaryMessage(makeCheckpoint())],
      { supportsCheckpointReplay: true, lineage: { provider: 'other', model: 'gpt-x', baseUrl: 'https://api.openai.com' } },
    );
    expect(items[0]!.kind).toBe('message');
  });

  it('never leaks the checkpoint payload into a projected message (sentinel)', () => {
    for (const target of [
      incapableTarget,
      { supportsCheckpointReplay: true, lineage: { provider: 'other', model: 'm', baseUrl: 'u' } },
    ]) {
      const items = projectModelHistory(
        [userMessage('kept'), summaryMessage(makeCheckpoint())],
        target,
      );
      expect(JSON.stringify(items)).not.toContain(SENTINEL);
    }
  });

  it('toWireMessage output carries no origin sidecar', () => {
    const items = projectModelHistory([summaryMessage(makeCheckpoint())], incapableTarget);
    const projected = items[0]!;
    expect(projected.kind).toBe('message');
    if (projected.kind === 'message') {
      expect(projected.message).not.toHaveProperty('origin');
      expect(projected.message).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: 'readable summary' }],
      });
    }
  });
});
