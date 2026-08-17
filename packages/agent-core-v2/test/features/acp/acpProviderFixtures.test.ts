import { describe, expect, it } from 'vitest';

import type { Message } from '#/kosong/contract/message';

import { projectAcpMessages, rebuildAcpMessages } from '../../../src/features/acp/messageAdapter';

interface ProviderFixture {
  readonly name: string;
  readonly messages: readonly Message[];
  readonly reject?: string;
}

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

const FIXTURES: readonly ProviderFixture[] = [
  {
    name: 'anthropic: encrypted thinking with tool_use adjacency',
    messages: [
      user('Investigate the cache regression.'),
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'plan: read the trace first', encrypted: 'sig-anthropic-1' },
          { type: 'text', text: 'Reading the trace.' },
        ],
        toolCalls: [
          { type: 'function', id: 'call_a1', name: 'read_file', arguments: '{"path":"trace.log"}' },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_a1',
        name: 'read_file',
        content: [{ type: 'text', text: 'trace body' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'root cause found', encrypted: 'sig-anthropic-2' },
          { type: 'text', text: 'The cache key changed shape.' },
        ],
        toolCalls: [],
      },
    ],
  },
  {
    name: 'openai-chat: parallel tool calls with adjacent results',
    messages: [
      user('Compare the two configs.'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_c1', name: 'read_file', arguments: '{"path":"a.json"}' },
          { type: 'function', id: 'call_c2', name: 'read_file', arguments: '{"path":"b.json"}' },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_c1',
        name: 'read_file',
        content: [{ type: 'text', text: '{"a":1}' }],
        toolCalls: [],
      },
      {
        role: 'tool',
        toolCallId: 'call_c2',
        name: 'read_file',
        content: [{ type: 'text', text: '{"b":2}' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'a.json sets a=1, b.json sets b=2.' }],
        toolCalls: [],
      },
    ],
  },
  {
    name: 'openai-responses: encrypted reasoning carrier over an interrupted turn',
    messages: [
      user('Run the migration.'),
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'checking prerequisites', encrypted: 'responses-reasoning-item' },
        ],
        toolCalls: [
          { type: 'function', id: 'call_r1', name: 'run_shell', arguments: '{"cmd":"migrate"}' },
        ],
      },
      user('Never mind, stop.'),
    ],
  },
  {
    name: 'gemini: thought-signature carrier with an oversized tool result',
    messages: [
      user('Dump the table.'),
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'querying', encrypted: 'gemini-thought-signature' },
          { type: 'text', text: 'Querying now.' },
        ],
        toolCalls: [
          {
            type: 'function',
            id: 'call_g1',
            name: 'run_sql',
            arguments: '{"q":"select *"}',
            extras: { thought_signature_b64: 'gemini-sig-call-g1' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_g1',
        name: 'run_sql',
        content: [{ type: 'text', text: `row ${'x'.repeat(50_000)}` }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'The table is large.' }],
        toolCalls: [],
      },
    ],
  },
  {
    name: 'gemini: interrupted streaming turn (partial message)',
    messages: [
      user('Say hi.'),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi—' }],
        toolCalls: [],
        partial: true,
      } as Message,
    ],
    reject: 'ACP cannot safely transform a partial message',
  },
  {
    // Media round-trips verbatim rather than failing the whole projection
    // (2026-08-17 fix) — the kernel never sees it (`textOf` reads only `text`
    // parts), mirroring how the reference host's `extractText` silently skips
    // non-text parts with no rejection at all.
    name: 'openai-responses: opaque media carrier (round-trips untouched)',
    messages: [
      user('Describe the screenshot.'),
      {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: 'https://example.invalid/s.png' } }],
        toolCalls: [],
      } as Message,
    ],
  },
  {
    name: 'any: compaction checkpoint carrier',
    messages: [
      user('hello'),
      {
        role: 'system',
        content: [{ type: 'compaction', summary: 'earlier fold' } as never],
        toolCalls: [],
      },
    ],
    reject: 'ACP cannot safely transform a compaction checkpoint carrier',
  },
];

describe('ACP provider fixtures', () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      const projected = projectAcpMessages([...fixture.messages], (_message, index) => `m${index + 1}`);
      if (fixture.reject !== undefined) {
        expect(projected).toMatchObject({ ok: false, reason: fixture.reject });
        return;
      }
      if (!projected.ok) throw new Error(projected.reason);
      const rebuilt = rebuildAcpMessages(projected.projection.messages, projected.projection);
      if (!rebuilt.ok) throw new Error(rebuilt.reason);
      expect(rebuilt.messages).toEqual(fixture.messages);
    });
  }
});
