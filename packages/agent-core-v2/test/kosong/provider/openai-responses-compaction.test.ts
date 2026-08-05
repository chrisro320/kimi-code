/**
 * OpenAI Responses — compaction decoder groundwork.
 *
 * Covers the two parser halves of the retry contract: the streamed /
 * non-streamed generate parsers recording undecodable output item types
 * instead of dropping them silently, and `decodeCompactionResponse`'s typed
 * `CompactionResponseOutcome` (ok / empty / protocol_error / decode_error)
 * with its deterministic-vs-retryable verdict.
 */

import { describe, expect, it } from 'vitest';

import type { StreamedMessagePart } from '#/kosong/contract/message';
import {
  decodeCompactionResponse,
  isRetryableCompactionOutcome,
  OpenAIResponsesStreamedMessage,
  type CompactionResponseOutcome,
} from '#/kosong/provider/bases/openai/openai-responses';

async function* makeAsyncIterable(items: readonly unknown[]): AsyncIterable<object> {
  for (const item of items) {
    yield item as object;
  }
}

async function drain(stream: OpenAIResponsesStreamedMessage): Promise<StreamedMessagePart[]> {
  const parts: StreamedMessagePart[] = [];
  for await (const part of stream) {
    parts.push(part);
  }
  return parts;
}

const CHECKPOINT_ITEM = {
  id: 'cmp_1',
  type: 'compaction',
  encrypted_content: 'opaque-payload-±§',
};

describe('OpenAIResponsesStreamedMessage dropped output items', () => {
  it('records output item types it cannot decode (stream parser)', async () => {
    const events = [
      { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning', summary: [] } },
      {
        type: 'response.output_item.done',
        item: { id: 'shell_1', type: 'local_shell_call', call_id: 'call_1' },
      },
      { type: 'response.completed', response: { id: 'resp_drop', status: 'completed' } },
    ];
    const stream = new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true);

    const parts = await drain(stream);

    expect(parts).toEqual([{ type: 'think', think: '' }]);
    expect(stream.droppedOutputItemTypes).toEqual(['local_shell_call']);
  });

  it('records output item types it cannot decode (non-stream parser)', async () => {
    const response = {
      id: 'resp_ns',
      status: 'completed',
      output: [
        { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
        { id: 'wid_1', type: 'web_search_call' },
      ],
    };
    const stream = new OpenAIResponsesStreamedMessage(response, false);

    const parts = await drain(stream);

    expect(parts).toEqual([{ type: 'text', text: 'hi' }]);
    expect(stream.droppedOutputItemTypes).toEqual(['web_search_call']);
  });

  it('records a compaction item arriving on a generate response as dropped', async () => {
    const response = {
      id: 'resp_cmp',
      status: 'completed',
      output: [
        { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'done' }] },
        CHECKPOINT_ITEM,
      ],
    };
    const stream = new OpenAIResponsesStreamedMessage(response, false);

    await drain(stream);

    expect(stream.droppedOutputItemTypes).toEqual(['compaction']);
  });
});

describe('decodeCompactionResponse', () => {
  it('ok: one checkpoint + unknown nonessential item succeeds WITH diagnostics', () => {
    const outcome = decodeCompactionResponse({
      id: 'resp_1',
      status: 'completed',
      usage: { input_tokens: 100, output_tokens: 40 },
      output: [
        {
          id: 'msg_u',
          type: 'message',
          role: 'user',
          content: [{ type: 'output_text', text: 'kept question' }],
        },
        { id: 'mystery_1', type: 'future_item', extra: 'opaque' },
        CHECKPOINT_ITEM,
      ],
    });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.checkpoint).toEqual({
      encrypted: 'opaque-payload-±§',
      itemType: 'compaction',
      itemId: 'cmp_1',
    });
    expect(outcome.retainedMessages).toEqual([{ role: 'user', text: 'kept question' }]);
    expect(outcome.unknownOutputItems).toEqual([{ rawType: 'future_item', index: 1, id: 'mystery_1' }]);
    expect(outcome.usage?.output).toBe(40);
  });

  it('decodes both checkpoint dialects and keeps the native wire type', () => {
    for (const rawType of ['compaction', 'compaction_summary']) {
      const outcome = decodeCompactionResponse({
        status: 'completed',
        output: [{ id: 'c', type: rawType, encrypted_content: 'x' }],
      });
      expect(outcome.kind).toBe('ok');
      if (outcome.kind === 'ok') {
        expect(outcome.checkpoint.itemType).toBe(rawType);
      }
    }
  });

  it('drops developer prefixes and reasoning/tool traffic without diagnostics', () => {
    const outcome = decodeCompactionResponse({
      status: 'completed',
      output: [
        {
          id: 'dev',
          type: 'message',
          role: 'developer',
          content: [{ type: 'output_text', text: 'instructions' }],
        },
        { id: 'rs', type: 'reasoning', summary: [] },
        { id: 'fc', type: 'function_call', name: 'Bash', arguments: '{}' },
        CHECKPOINT_ITEM,
      ],
    });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.retainedMessages).toEqual([]);
      expect(outcome.unknownOutputItems).toEqual([]);
    }
  });

  it('empty: zero usable checkpoints is deterministic when completed', () => {
    const outcome = decodeCompactionResponse({ status: 'completed', output: [] });

    expect(outcome.kind).toBe('empty');
    if (outcome.kind === 'empty') {
      expect(outcome.finishReason).toBe('completed');
    }
    expect(isRetryableCompactionOutcome(outcome)).toBe(false);
  });

  it('empty: truncated / interrupted stays retryable (bounded)', () => {
    const truncated = decodeCompactionResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
    });
    expect(truncated.kind).toBe('empty');
    if (truncated.kind === 'empty') {
      expect(truncated.finishReason).toBe('truncated');
    }
    expect(isRetryableCompactionOutcome(truncated)).toBe(true);

    const interrupted = decodeCompactionResponse({ output: [] });
    expect(interrupted.kind).toBe('empty');
    expect(isRetryableCompactionOutcome(interrupted)).toBe(true);
  });

  it('empty still reports unknown items — never silently "no checkpoint"', () => {
    const outcome: CompactionResponseOutcome = decodeCompactionResponse({
      status: 'completed',
      output: [{ id: 'z', type: 'brand_new_item' }],
    });

    expect(outcome.kind).toBe('empty');
    if (outcome.kind === 'empty') {
      expect(outcome.unknownOutputItems).toEqual([{ rawType: 'brand_new_item', index: 0, id: 'z' }]);
    }
  });

  it('protocol_error: multiple usable checkpoints — never guessed', () => {
    const outcome = decodeCompactionResponse({
      status: 'completed',
      output: [CHECKPOINT_ITEM, { ...CHECKPOINT_ITEM, id: 'cmp_2' }],
    });

    expect(outcome.kind).toBe('protocol_error');
    if (outcome.kind === 'protocol_error') {
      expect(outcome.reason).toBe('multiple_checkpoints');
      expect(outcome.checkpointCount).toBe(2);
    }
    expect(isRetryableCompactionOutcome(outcome)).toBe(false);
  });

  it('decode_error: a checkpoint with a malformed required field', () => {
    const outcome = decodeCompactionResponse({
      status: 'completed',
      output: [{ id: 'bad', type: 'compaction' }],
    });

    expect(outcome.kind).toBe('decode_error');
    if (outcome.kind === 'decode_error') {
      expect(outcome.error.message).toContain('encrypted_content');
    }
  });

  it('decode_error: a non-object body', () => {
    expect(decodeCompactionResponse('nope').kind).toBe('decode_error');
    expect(decodeCompactionResponse(null).kind).toBe('decode_error');
  });
});
