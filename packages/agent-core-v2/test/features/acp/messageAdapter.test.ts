import type { CoreMessage } from 'acp-kernel';
import { describe, expect, it } from 'vitest';

import type { Message } from '#/kosong/contract/message';
import {
  projectAcpMessages,
  rebuildAcpMessages,
  type CoreProjection,
} from '#/features/acp/messageAdapter';

function project(messages: readonly Message[]): CoreProjection {
  const result = projectAcpMessages(messages, (_message, index) => `message-${index}`);
  if (!result.ok) throw new Error(result.reason);
  return result.projection;
}

function rebuild(core: readonly CoreMessage[], projection: CoreProjection): Message[] {
  const result = rebuildAcpMessages(core, projection);
  if (!result.ok) throw new Error(result.reason);
  return result.messages;
}

describe('ACP message adapter', () => {
  it('round-trips text messages without changing their object identity', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'world' }], toolCalls: [] },
    ];
    const projection = project(messages);

    expect(projection.messages).toEqual([
      { id: 'message-0', role: 'user', contentType: 'text', text: 'hello' },
      { id: 'message-1', role: 'assistant', contentType: 'text', text: 'world' },
    ]);
    const rebuilt = rebuild(projection.messages, projection);
    expect(rebuilt[0]).toBe(messages[0]);
    expect(rebuilt[1]).toBe(messages[1]);
  });

  it('preserves encrypted thinking and tool-call pairing', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'private reasoning', encrypted: 'ciphertext' },
          { type: 'text', text: 'calling tool' },
        ],
        toolCalls: [
          { type: 'function', id: 'call-1', name: 'Read', arguments: '{"path":"a"}' },
        ],
      },
      {
        role: 'tool',
        name: 'Read',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'result' }],
        toolCalls: [],
      },
    ];
    const projection = project(messages);

    expect(projection.messages).toEqual([
      { id: 'message-0', role: 'assistant', contentType: 'text', text: 'calling tool' },
      {
        id: 'message-0#reasoning:0',
        role: 'assistant',
        contentType: 'reasoning',
        text: 'private reasoning',
      },
      {
        id: 'message-0#tool:call-1',
        role: 'assistant',
        contentType: 'tool-call',
        toolName: 'Read',
        toolCallId: 'call-1',
        text: '{"path":"a"}',
      },
      {
        id: 'message-1',
        role: 'tool',
        contentType: 'tool-result',
        toolName: 'Read',
        toolCallId: 'call-1',
        text: 'result',
      },
    ]);
    const rebuilt = rebuild(projection.messages, projection);
    expect(rebuilt[0]).toBe(messages[0]);
    expect(rebuilt[1]).toBe(messages[1]);
  });

  it('round-trips multiple reasoning parts independently', () => {
    const message: Message = {
      role: 'assistant',
      content: [
        { type: 'think', think: 'first' },
        { type: 'think', think: 'second' },
        { type: 'text', text: 'answer' },
      ],
      toolCalls: [],
    };
    const projection = project([message]);

    expect(rebuild(projection.messages, projection)[0]).toBe(message);
  });

  it('keeps encrypted reasoning when the kernel prunes its core projection', () => {
    const encrypted = { type: 'think' as const, think: 'private', encrypted: 'ciphertext' };
    const message: Message = {
      role: 'assistant',
      content: [encrypted, { type: 'text', text: 'answer' }],
      toolCalls: [],
    };
    const projection = project([message]);
    const withoutReasoning = projection.messages.filter(
      (core) => core.contentType !== 'reasoning',
    );

    expect(rebuild(withoutReasoning, projection)[0]!.content).toContain(encrypted);
  });

  it('uses an exact mutated kernel body while preserving message metadata', () => {
    const huge = 'secret '.repeat(8000);
    const message: Message = {
      role: 'tool',
      name: 'Bash',
      toolCallId: 'call-large',
      content: [{ type: 'text', text: huge }],
      toolCalls: [],
    };
    const projection = project([message]);
    const mutated: CoreMessage[] = [
      {
        ...projection.messages[0]!,
        text: '<acp tokens="12K" type="Bash">m00001</acp>\n[tool output truncated]  ',
      },
    ];

    const rebuilt = rebuild(mutated, projection);
    expect(rebuilt[0]!.content[0]).toEqual({
      type: 'text',
      text: '<acp tokens="12K" type="Bash">m00001</acp>\n[tool output truncated]  ',
    });
    expect(JSON.stringify(rebuilt)).not.toContain(huge);
    expect(rebuilt[0]!.toolCallId).toBe('call-large');
  });

  it('removes tool calls pruned by the kernel', () => {
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'two calls' }],
      toolCalls: [
        { type: 'function', id: 'call-a', name: 'Read', arguments: 'a' },
        { type: 'function', id: 'call-b', name: 'Read', arguments: 'b' },
      ],
    };
    const projection = project([message]);
    const surviving = projection.messages.filter((core) => core.toolCallId !== 'call-b');

    expect(rebuild(surviving, projection)[0]!.toolCalls).toEqual([message.toolCalls[0]]);
  });

  it('fails open when the kernel leaves an orphan tool result', () => {
    const assistant: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'calling' }],
      toolCalls: [{ type: 'function', id: 'call-a', name: 'Read', arguments: '{}' }],
    };
    const result: Message = {
      role: 'tool',
      content: [{ type: 'text', text: 'done' }],
      toolCalls: [],
      toolCallId: 'call-a',
    };
    const projection = project([assistant, result]);
    const withoutCall = projection.messages.filter((core) => core.contentType !== 'tool-call');

    expect(rebuildAcpMessages(withoutCall, projection)).toEqual({
      ok: false,
      reason: 'ACP kernel orphaned tool interaction call-a',
    });
  });

  it('accepts default-tagged tool-call arguments without changing them', () => {
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'calling' }],
      toolCalls: [{ type: 'function', id: 'call-a', name: 'Read', arguments: '{"path":"a"}' }],
    };
    const projection = project([message]);
    const tagged = projection.messages.map((core) =>
      core.toolCallId === 'call-a'
        ? { ...core, text: '<acp tokens="3" type="Read">m00001</acp>\n{"path":"a"}' }
        : core,
    );

    expect(rebuild(tagged, projection)[0]!.toolCalls[0]).toBe(message.toolCalls[0]);
  });

  it('fails open when the kernel changes tool-call arguments', () => {
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'calling' }],
      toolCalls: [{ type: 'function', id: 'call-a', name: 'Read', arguments: '{"path":"a"}' }],
    };
    const projection = project([message]);
    const changed = projection.messages.map((core) =>
      core.toolCallId === 'call-a' ? { ...core, text: 'not json' } : core,
    );

    expect(rebuildAcpMessages(changed, projection)).toEqual({
      ok: false,
      reason: 'ACP changed tool-call arguments for call-a',
    });
  });

  it('fails open instead of emitting an empty message shell', () => {
    const message: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'only text' }],
      toolCalls: [],
    };
    const projection = project([message]);

    expect(rebuildAcpMessages([{ ...projection.messages[0]!, text: '' }], projection)).toEqual({
      ok: false,
      reason: 'ACP produced an empty user message',
    });
  });

  it('preserves body-leading whitespace after an ACP tag', () => {
    const message: Message = {
      role: 'tool',
      content: [{ type: 'text', text: '  output' }],
      toolCalls: [],
      toolCallId: 'call-space',
    };
    const projection = project([message]);
    const tagged = [
      { ...projection.messages[0]!, text: '<acp tokens="2" type="tool">m00001</acp>\n  output' },
    ];

    expect(rebuild(tagged, projection)[0]!.content[0]).toEqual({
      type: 'text',
      text: '<acp tokens="2" type="tool">m00001</acp>\n  output',
    });
  });

  it('preserves multiple text parts on unchanged round-trip and fails open on mutation', () => {
    const message: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      toolCalls: [],
    };
    const projection = project([message]);
    expect(rebuild(projection.messages, projection)[0]).toBe(message);
    expect(
      rebuildAcpMessages([{ ...projection.messages[0]!, text: 'changed' }], projection),
    ).toEqual({
      ok: false,
      reason: 'ACP cannot safely rebuild mutated multiple text parts',
    });
  });

  it('rejects duplicate, unknown, reserved, and group-splitting kernel ids', () => {
    const reasoningOnly: Message = {
      role: 'assistant',
      content: [{ type: 'think', think: 'reasoning' }],
      toolCalls: [],
    };
    expect(projectAcpMessages([reasoningOnly, reasoningOnly], () => 'duplicate')).toEqual({
      ok: false,
      reason: 'ACP message id is empty, duplicated, or reserved at index 1',
    });
    expect(projectAcpMessages([reasoningOnly], () => 'acp_summary_user')).toEqual({
      ok: false,
      reason: 'ACP message id is empty, duplicated, or reserved at index 0',
    });
    const colliding = projectAcpMessages(
      [reasoningOnly, reasoningOnly],
      (_message, index) => (index === 0 ? 'a' : 'a#reasoning:0'),
    );
    expect(colliding).toEqual({
      ok: false,
      reason: 'ACP message id is empty, duplicated, or reserved at index 1',
    });

    const assistant: Message = {
      role: 'assistant',
      content: [{ type: 'think', think: 'reasoning' }, { type: 'text', text: 'answer' }],
      toolCalls: [{ type: 'function', id: 'call-a', name: 'Read', arguments: '{}' }],
    };
    const projection = project([assistant]);
    expect(rebuildAcpMessages([...projection.messages, projection.messages[0]!], projection)).toEqual({
      ok: false,
      reason: 'ACP kernel returned duplicate id message-0',
    });
    expect(
      rebuildAcpMessages(
        [{ id: 'unknown', role: 'user', contentType: 'text', text: 'unknown' }],
        projection,
      ),
    ).toEqual({ ok: false, reason: 'ACP kernel returned unknown id unknown' });
    expect(
      rebuildAcpMessages(
        [
          projection.messages[0]!,
          {
            id: 'acp_summary_b1',
            role: 'system',
            contentType: 'text',
            text: 'summary',
          },
          ...projection.messages.slice(1),
        ],
        projection,
      ),
    ).toEqual({ ok: false, reason: 'ACP summary splits one source message group' });
  });

  it('rejects duplicated tool-call ids across source messages', () => {
    const first: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'first call' }],
      toolCalls: [{ type: 'function', id: 'call-a', name: 'Read', arguments: '{}' }],
    };
    const second: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'second call' }],
      toolCalls: [{ type: 'function', id: 'call-a', name: 'Read', arguments: '{}' }],
    };

    expect(projectAcpMessages([first, second], (_message, index) => `message-${index}`)).toEqual({
      ok: false,
      reason: 'ACP tool call id is duplicated at index 1',
    });
  });

  it('fails open when the kernel reorders or interleaves source message groups', () => {
    const first: Message = {
      role: 'assistant',
      content: [{ type: 'think', think: 'reasoning' }, { type: 'text', text: 'first' }],
      toolCalls: [],
    };
    const second: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'second' }],
      toolCalls: [],
    };
    const projection = project([first, second]);
    const reversed = [projection.messages[2]!, ...projection.messages.slice(0, 2)];
    const interleaved = [
      projection.messages[0]!,
      projection.messages[2]!,
      projection.messages[1]!,
    ];

    for (const core of [reversed, interleaved]) {
      expect(rebuildAcpMessages(core, projection)).toEqual({
        ok: false,
        reason: 'ACP kernel reordered source message groups',
      });
    }
  });

  it('fails open when a summary splits an assistant tool call from its result', () => {
    const assistant: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'calling' }],
      toolCalls: [{ type: 'function', id: 'call-a', name: 'Read', arguments: '{}' }],
    };
    const result: Message = {
      role: 'tool',
      content: [{ type: 'text', text: 'done' }],
      toolCalls: [],
      toolCallId: 'call-a',
    };
    const projection = project([assistant, result]);
    const callPosition = projection.messages.findIndex((core) => core.contentType === 'tool-call');
    const split = [
      ...projection.messages.slice(0, callPosition + 1),
      {
        id: 'acp_summary_b1',
        role: 'system' as const,
        contentType: 'text' as const,
        text: 'summary',
      },
      ...projection.messages.slice(callPosition + 1).map((core) =>
        core.contentType === 'tool-result' ? { ...core, toolCallId: undefined } : core,
      ),
    ];

    expect(rebuildAcpMessages(split, projection)).toEqual({
      ok: false,
      reason: 'ACP summary splits tool interaction call-a',
    });
  });

  it('detects a summary split when only tool-result reasoning survives', () => {
    const assistant: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'calling' }],
      toolCalls: [{ type: 'function', id: 'call-a', name: 'Read', arguments: '{}' }],
    };
    const result: Message = {
      role: 'tool',
      content: [{ type: 'think', think: 'result reasoning' }],
      toolCalls: [],
      toolCallId: 'call-a',
    };
    const projection = project([assistant, result]);
    const callPosition = projection.messages.findIndex((core) => core.contentType === 'tool-call');
    const reasoning = projection.messages.find((core) => core.contentType === 'reasoning')!;
    const split: CoreMessage[] = [
      ...projection.messages.slice(0, callPosition + 1),
      {
        id: 'acp_summary_b1',
        role: 'system',
        contentType: 'text',
        text: 'summary',
      },
      { ...reasoning, toolCallId: undefined },
    ];

    expect(rebuildAcpMessages(split, projection)).toEqual({
      ok: false,
      reason: 'ACP summary splits tool interaction call-a',
    });
  });

  it('omits empty unencrypted reasoning', () => {
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'think', think: 'reasoning' }, { type: 'text', text: 'answer' }],
      toolCalls: [],
    };
    const projection = project([message]);
    const emptied = projection.messages.map((core) =>
      core.contentType === 'reasoning'
        ? { ...core, text: '<acp tokens="0" type="reasoning">m00001</acp>\n' }
        : core,
    );

    expect(rebuild(emptied, projection)[0]!.content).toEqual([
      { type: 'text', text: 'answer' },
    ]);
  });

  it('materializes kernel summary messages', () => {
    const projection = project([
      { role: 'user', content: [{ type: 'text', text: 'old text' }], toolCalls: [] },
    ]);
    const core: CoreMessage[] = [
      {
        id: 'acp_summary_b1',
        role: 'system',
        contentType: 'text',
        text: '[Compressed conversation section]\nsummary',
      },
    ];

    expect(rebuild(core, projection)).toEqual([
      {
        role: 'system',
        content: [{ type: 'text', text: '[Compressed conversation section]\nsummary' }],
        toolCalls: [],
      },
    ]);
  });

  it('rejects checkpoint carriers, partial messages, and tool declarations', () => {
    const checkpoint = {
      role: 'user',
      content: [{ type: 'compaction', id: 'cp' }],
      toolCalls: [],
    } as unknown as Message;
    const partial: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'unfinished' }],
      toolCalls: [],
      partial: true,
    };
    const declarations: Message = {
      role: 'system',
      content: [],
      toolCalls: [],
      tools: [{ name: 'Read', description: 'Read a file', parameters: {} }],
    };

    expect(projectAcpMessages([checkpoint], () => 'checkpoint')).toEqual({
      ok: false,
      reason: 'ACP cannot safely transform a compaction checkpoint carrier',
    });
    expect(projectAcpMessages([partial], () => 'partial')).toEqual({
      ok: false,
      reason: 'ACP cannot safely transform a partial message',
    });
    expect(projectAcpMessages([declarations], () => 'declarations')).toEqual({
      ok: false,
      reason: 'ACP cannot safely transform a tool-declaration-only message',
    });
  });

  // A history containing an image must not make the whole projection fail
  // (2026-08-17 incident: one image anywhere in history permanently degraded
  // all four ACP tools for the rest of the session). The kernel never sees
  // media — `textOf` only reads `text` parts — but it must round-trip
  // untouched through rebuild, mirroring the reference host's `extractText`
  // (which silently skips non-text parts with no rejection at all).
  it('round-trips a message containing image content verbatim (kernel never sees it)', () => {
    const image: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this screenshot' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AA==' } },
      ],
      toolCalls: [],
    };

    const result = projectAcpMessages([image], () => 'image');
    expect(result.ok).toBe(true);

    const projection = project([image]);
    expect(rebuild(projection.messages, projection)).toEqual([image]);
  });

  it('round-trips an image-only message (no text part at all)', () => {
    const image: Message = {
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,AA==' } }],
      toolCalls: [],
    };

    const projection = project([image]);
    expect(rebuild(projection.messages, projection)).toEqual([image]);
  });
});
