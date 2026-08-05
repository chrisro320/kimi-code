/**
 * OpenAI Responses — compaction decoder groundwork and the compact endpoint.
 *
 * Covers the two parser halves of the retry contract: the streamed /
 * non-streamed generate parsers recording undecodable output item types
 * instead of dropping them silently, and `decodeCompactionResponse`'s typed
 * `CompactionResponseOutcome` (ok / empty / protocol_error / decode_error)
 * with its deterministic-vs-retryable verdict — plus the provider's
 * `compactConversation` / `compactionLineage` endpoint implementation:
 * byte-for-byte checkpoint replay as a top-level input item, resolved
 * lineage, and the same empty-response retry gate as generate.
 */

import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';

import {
  canonicalizeLineage,
  sameOrigin,
  type CompactionCheckpoint,
  type ModelHistoryItem,
} from '#/kosong/contract/compaction';
import {
  APIEmptyResponseError,
  ChatProviderError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import type { Message, StreamedMessagePart } from '#/kosong/contract/message';
import {
  decodeCompactionResponse,
  isRetryableCompactionOutcome,
  OpenAIResponsesChatProvider,
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


// ---------------------------------------------------------------------------
// S4 — the compact endpoint itself (provider-level, AC16–AC17)
// ---------------------------------------------------------------------------

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

interface FakeCompact {
  readonly calls: { params: Record<string, unknown>; opts: unknown }[];
  readonly compact: (params: Record<string, unknown>, opts: unknown) => Promise<unknown>;
}

function makeEndpointProvider(options?: {
  model?: string;
  baseUrl?: string;
  respond?: (params: Record<string, unknown>) => unknown;
}): { provider: OpenAIResponsesChatProvider; fake: FakeCompact } {
  const fake: FakeCompact = {
    calls: [],
    compact(params: Record<string, unknown>, opts: unknown) {
      fake.calls.push({ params, opts });
      const body = options?.respond?.(params) ?? {
        id: 'resp_cmp',
        status: 'completed',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'user',
            content: [{ type: 'output_text', text: 'kept' }],
          },
          { id: 'cmp_1', type: 'compaction', encrypted_content: 'new-payload' },
          { id: 'ws_1', type: 'web_search_call' },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          total_tokens: 110,
          input_tokens_details: { cached_tokens: 40 },
        },
      };
      return Promise.resolve(body);
    },
  };
  const provider = new OpenAIResponsesChatProvider({
    model: options?.model ?? 'gpt-4.1',
    ...(options?.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    clientFactory: () => ({ responses: { compact: fake.compact } }) as unknown as OpenAI,
  });
  return { provider, fake };
}

function ownedCheckpoint(provider: OpenAIResponsesChatProvider): CompactionCheckpoint {
  return {
    encrypted: 'opaque-payload-±§',
    itemType: 'compaction_summary',
    itemId: 'cmp_9',
    lineage: provider.compactionLineage(),
    replayInputTokens: { kind: 'unknown' },
  };
}

describe('OpenAIResponsesChatProvider compactionLineage', () => {
  it('resolves the provider default base URL when the config sets none', () => {
    const { provider } = makeEndpointProvider({ model: 'gpt-4.1' });

    expect(provider.compactionLineage()).toEqual({
      provider: 'openai-responses',
      model: 'gpt-4.1',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('treats two unset-baseUrl providers with different identities as foreign', () => {
    const a = makeEndpointProvider({ model: 'gpt-4.1' }).provider;
    const b = makeEndpointProvider({ model: 'gpt-4.1-mini' }).provider;

    expect(sameOrigin(a.compactionLineage(), b.compactionLineage())).toBe(false);
    // The v1 `?? ''` bug: an UNRESOLVED (empty) base URL must never compare
    // owned against the resolved default.
    expect(
      sameOrigin(
        a.compactionLineage(),
        canonicalizeLineage({
          provider: 'openai-responses',
          model: 'gpt-4.1',
          effectiveBaseUrl: '',
        }),
      ),
    ).toBe(false);
  });

  it('strips trailing slashes from a configured base URL', () => {
    const { provider } = makeEndpointProvider({ baseUrl: 'https://gw.example.com/v1/' });

    expect(provider.compactionLineage().baseUrl).toBe('https://gw.example.com/v1');
  });
});

describe('OpenAIResponsesChatProvider compactConversation', () => {
  it('replays an owned checkpoint byte-for-byte as a top-level input item', async () => {
    const { provider, fake } = makeEndpointProvider({});
    const history: ModelHistoryItem[] = [
      { kind: 'message', message: userMessage('hello') },
      { kind: 'checkpoint', checkpoint: ownedCheckpoint(provider) },
      { kind: 'message', message: userMessage('after') },
    ];

    const result = await provider.compactConversation({
      systemPrompt: 'sys',
      tools: [],
      history,
      retainedMessages: [],
    });

    expect(fake.calls).toHaveLength(1);
    const params = fake.calls[0]!.params;
    expect(params['model']).toBe('gpt-4.1');
    // The compaction endpoint rejects `store` outright — never sent.
    expect(params).not.toHaveProperty('store');
    expect(params['instructions']).toBe('sys');
    expect(params).not.toHaveProperty('tools');
    expect(params).not.toHaveProperty('parallel_tool_calls');
    expect(params['input']).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'compaction_summary', encrypted_content: 'opaque-payload-±§', id: 'cmp_9' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'after' }] },
    ]);

    expect(result.checkpoint.encrypted).toBe('new-payload');
    expect(result.checkpoint.itemType).toBe('compaction');
    expect(result.checkpoint.itemId).toBe('cmp_1');
    expect(result.checkpoint.lineage).toEqual(provider.compactionLineage());
    expect(result.checkpoint.replayInputTokens).toEqual({ kind: 'unknown' });
    expect(result.retainedMessages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'kept' }], toolCalls: [] },
    ]);
    expect(result.usage).toEqual({
      inputOther: 60,
      output: 10,
      inputCacheRead: 40,
      inputCacheCreation: 0,
    });
    expect(result.unknownOutputItemTypes).toEqual(['web_search_call']);
  });

  it('sends converted tools only when the caller provides them', async () => {
    const { provider, fake } = makeEndpointProvider({});

    await provider.compactConversation({
      systemPrompt: '',
      tools: [
        {
          name: 'get_weather',
          description: 'Read the weather.',
          parameters: { type: 'object', properties: {} },
        },
      ],
      history: [{ kind: 'message', message: userMessage('hi') }],
      retainedMessages: [],
    });

    const params = fake.calls[0]!.params;
    expect(params).not.toHaveProperty('instructions');
    expect(params['tools']).toEqual([
      expect.objectContaining({ type: 'function', name: 'get_weather' }),
    ]);
    // Prefix alignment with the loop path: pinned exactly when tools go out.
    expect(params['parallel_tool_calls']).toBe(false);
    expect(fake.calls[0]!.params).not.toHaveProperty('include');
  });

  it('forwards the session cache key only when the caller provides one', async () => {
    const { provider, fake } = makeEndpointProvider({});
    const history: ModelHistoryItem[] = [{ kind: 'message', message: userMessage('hi') }];

    await provider.compactConversation(
      { systemPrompt: '', tools: [], history, retainedMessages: [] },
      { cacheKey: 'session-42' },
    );
    await provider.compactConversation({ systemPrompt: '', tools: [], history, retainedMessages: [] });

    expect(fake.calls[0]!.params['prompt_cache_key']).toBe('session-42');
    expect(fake.calls[1]!.params).not.toHaveProperty('prompt_cache_key');
  });

  it('rejects a completed empty response with a NON-retryable APIEmptyResponseError', async () => {
    const { provider } = makeEndpointProvider({
      respond: () => ({ id: 'resp_e', status: 'completed', output: [] }),
    });

    const error = await provider
      .compactConversation({
        systemPrompt: '',
        tools: [],
        history: [{ kind: 'message', message: userMessage('hi') }],
        retainedMessages: [],
      })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(APIEmptyResponseError);
    expect(isRetryableGenerateError(error)).toBe(false);
  });

  it('keeps a truncated empty response retryable', async () => {
    const { provider } = makeEndpointProvider({
      respond: () => ({
        id: 'resp_t',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [],
      }),
    });

    const error = await provider
      .compactConversation({
        systemPrompt: '',
        tools: [],
        history: [{ kind: 'message', message: userMessage('hi') }],
        retainedMessages: [],
      })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(APIEmptyResponseError);
    expect(isRetryableGenerateError(error)).toBe(true);
  });

  it('rejects multiple checkpoints as a protocol error, never a guess', async () => {
    const { provider } = makeEndpointProvider({
      respond: () => ({
        id: 'resp_p',
        status: 'completed',
        output: [
          { id: 'cmp_1', type: 'compaction', encrypted_content: 'a' },
          { id: 'cmp_2', type: 'compaction_summary', encrypted_content: 'b' },
        ],
      }),
    });

    await expect(
      provider.compactConversation({
        systemPrompt: '',
        tools: [],
        history: [{ kind: 'message', message: userMessage('hi') }],
        retainedMessages: [],
      }),
    ).rejects.toThrowError(/expected exactly one/);
  });

  it('rejects a malformed checkpoint field as a typed decode error', async () => {
    const { provider } = makeEndpointProvider({
      respond: () => ({
        id: 'resp_d',
        status: 'completed',
        output: [{ id: 'cmp_1', type: 'compaction' }],
      }),
    });

    await expect(
      provider.compactConversation({
        systemPrompt: '',
        tools: [],
        history: [{ kind: 'message', message: userMessage('hi') }],
        retainedMessages: [],
      }),
    ).rejects.toThrowError(/encrypted_content must be a string/);
  });

  it('rejects when the SDK has no compaction endpoint', async () => {
    const provider = new OpenAIResponsesChatProvider({
      model: 'gpt-4.1',
      clientFactory: () => ({ responses: {} }) as unknown as OpenAI,
    });

    await expect(
      provider.compactConversation({
        systemPrompt: '',
        tools: [],
        history: [{ kind: 'message', message: userMessage('hi') }],
        retainedMessages: [],
      }),
    ).rejects.toThrowError(/does not support the Responses compaction endpoint/);
  });

  it('converts transport failures through the provider error mapping', async () => {
    const provider = new OpenAIResponsesChatProvider({
      model: 'gpt-4.1',
      clientFactory: () =>
        ({
          responses: {
            compact: () => Promise.reject(new Error('connection reset by peer')),
          },
        }) as unknown as OpenAI,
    });

    const error = await provider
      .compactConversation({
        systemPrompt: '',
        tools: [],
        history: [{ kind: 'message', message: userMessage('hi') }],
        retainedMessages: [],
      })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(ChatProviderError);
    expect((error as Error).message).toContain('connection reset by peer');
  });
});
