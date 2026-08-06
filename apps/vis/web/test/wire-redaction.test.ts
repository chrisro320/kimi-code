import { describe, expect, it } from 'vitest';

import { redactCheckpointPayloads } from '../src/components/wire/renderers';

const CHECKPOINT = {
  encrypted: 'opaque-provider-state-xyzzy',
  itemType: 'compaction',
  lineage: { provider: 'kimi', model: 'kimi-code', baseUrl: 'https://api.example/v1' },
  replayInputTokens: { kind: 'measured', tokens: 1234 },
};

describe('redactCheckpointPayloads (B4-G vis redaction)', () => {
  it('strips the encrypted payload from an apply_compaction record but keeps metadata', () => {
    const raw = {
      type: 'context.apply_compaction',
      summary: 'folded',
      compactedCount: 4,
      tokensBefore: 100,
      tokensAfter: 20,
      checkpoint: { ...CHECKPOINT },
      time: 1,
    };

    const redacted = redactCheckpointPayloads(raw);
    const rendered = JSON.stringify(redacted, null, 2);

    expect(rendered).not.toContain('opaque-provider-state-xyzzy');
    expect(rendered).toContain('compaction');
    expect(rendered).toContain('kimi-code');
    expect(rendered).toContain('<redacted 27 chars>');
    // Metadata other than the payload survives untouched.
    expect(redacted.checkpoint.itemType).toBe('compaction');
    expect(redacted.checkpoint.lineage).toEqual(CHECKPOINT.lineage);
    expect(redacted.checkpoint.replayInputTokens).toEqual(CHECKPOINT.replayInputTokens);
  });

  it('redacts checkpoints nested in message origins (append_message)', () => {
    const raw = {
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'readable summary' }],
        toolCalls: [],
        origin: { kind: 'compaction_summary', checkpoint: { ...CHECKPOINT } },
      },
      time: 1,
    };

    const redacted = redactCheckpointPayloads(raw);

    expect(JSON.stringify(redacted)).not.toContain('opaque-provider-state-xyzzy');
    expect(
      JSON.stringify(redacted.message.origin.checkpoint.lineage),
    ).toContain('kimi-code');
  });

  it('leaves records without checkpoints byte-identical', () => {
    const raw = {
      type: 'usage.record',
      model: 'kimi-code',
      usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
      nested: [{ key: 'encrypted-note' }],
      time: 1,
    };

    expect(JSON.stringify(redactCheckpointPayloads(raw))).toBe(JSON.stringify(raw));
  });

  it('covers the copy path: stringified redacted output carries no payload', () => {
    const copyValue = JSON.stringify(
      redactCheckpointPayloads({ type: 'context.apply_compaction', checkpoint: { ...CHECKPOINT } }),
      null,
      2,
    );

    expect(copyValue).not.toContain('opaque-provider-state-xyzzy');
  });
});
