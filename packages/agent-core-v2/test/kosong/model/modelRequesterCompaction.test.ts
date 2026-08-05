/**
 * `kosong/model` ModelRequesterImpl.compactConversation — the REQUIRED
 * remote-compaction boundary.
 *
 * Covers the provider-method gate (typed `unsupported`, never an exception),
 * the auth-refresh replay (proving the path runs through
 * `runWithAuthRefresh`, not around it), abort propagation (thrown, never an
 * outcome), provider error translation for non-abort failures, and the
 * params → GenerateOptions mapping.
 */

import { describe, expect, it } from 'vitest';

import { isError2, unwrapErrorCause } from '#/_base/errors/errors';import type { CompactionCheckpoint } from '#/kosong/contract/compaction';
import { APIStatusError, createAbortError } from '#/kosong/contract/errors';
import type { Message, StreamedMessagePart } from '#/kosong/contract/message';
import type {
  ChatProvider,
  ChatProviderCompactionInput,
  ChatProviderCompactionResult,
  GenerateOptions,
  StreamedMessage,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import { emptyUsage } from '#/kosong/contract/usage';
import type { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import type { Model } from '#/kosong/model/catalog';
import type { ModelCompactionInput } from '#/kosong/model/modelRequester';
import { ModelRequesterImpl } from '#/kosong/model/modelRequesterImpl';

const LINEAGE = { provider: 'fake', model: 'fake-model', baseUrl: 'https://api.fake.test' };

function checkpoint(): CompactionCheckpoint {
  return {
    encrypted: 'opaque',
    itemType: 'compaction',
    lineage: { ...LINEAGE },
    replayInputTokens: { kind: 'unknown' },
  };
}

function compactionResult(): ChatProviderCompactionResult {
  return {
    checkpoint: checkpoint(),
    retainedMessages: [{ role: 'user', content: [{ type: 'text', text: 'kept' }], toolCalls: [] }],
    usage: emptyUsage(),
    unknownOutputItemTypes: ['future_item'],
    traceId: 'trace-cmp',
  };
}

class FakeChatProvider implements ChatProvider {
  readonly name = 'fake-base';
  readonly modelName = 'fake-model';
  readonly thinkingEffort = null;

  readonly compactCalls: Array<{ input: ChatProviderCompactionInput; options?: GenerateOptions }> =
    [];
  compactHandler?: (callIndex: number) => Promise<ChatProviderCompactionResult>;

  async generate(): Promise<StreamedMessage> {
    throw new Error('generate not used in compaction tests');
  }

  compactConversation?: ChatProvider['compactConversation'];
  compactionLineage?: ChatProvider['compactionLineage'];

  installCompact(): void {
    this.compactConversation = async (input, options) => {
      this.compactCalls.push({ input, options });
      return (this.compactHandler ?? (() => Promise.resolve(compactionResult())))(
        this.compactCalls.length - 1,
      );
    };
    this.compactionLineage = () => ({ ...LINEAGE });
  }
}

function registryReturning(provider: ChatProvider): IProtocolAdapterRegistry {
  return {
    createChatProvider: () => provider,
  } as unknown as IProtocolAdapterRegistry;
}

function modelWith(authProvider: Model['authProvider']): Model {
  return {
    id: 'm1',
    name: 'fake-model',
    aliases: [],
    protocol: 'openai',
    headers: {},
    capabilities: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128000,
    },
    maxContextSize: 128000,
    alwaysThinking: false,
    providerType: 'fake',
    providerName: 'fake',
    authProvider,
  } as Model;
}

const staticAuth = (apiKey?: string): Model['authProvider'] => ({
  canRefresh: false,
  getAuth: () => Promise.resolve(apiKey === undefined ? undefined : { apiKey }),
});

const INPUT: ModelCompactionInput = {
  systemPrompt: 'sys',
  tools: [],
  history: [{ kind: 'message', message: { role: 'user', content: [], toolCalls: [] } }],
  retainedMessages: [],
};

describe('ModelRequesterImpl.compactConversation', () => {
  it('returns typed unsupported when the provider has no endpoint — never throws', async () => {
    const provider = new FakeChatProvider();
    const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider));

    await expect(requester.compactConversation(INPUT)).resolves.toEqual({ kind: 'unsupported' });
  });

  it('maps params onto GenerateOptions and returns the provider result', async () => {
    const provider = new FakeChatProvider();
    provider.installCompact();
    const requester = new ModelRequesterImpl(
      modelWith(staticAuth('sk-1')),
      registryReturning(provider),
    );
    const signal = AbortSignal.timeout(1000);
    const traceIds: Array<string | null> = [];

    const outcome = await requester.compactConversation(INPUT, signal, {
      cacheKey: 'session-1',
      thinkingEffort: 'high',
      thinkingKeep: 'all',
      maxCompletionTokens: 512,
      usedContextTokens: 5000,
      maxContextTokens: 128000,
      onTraceId: (id) => traceIds.push(id),
    });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.result.checkpoint).toEqual(checkpoint());
      expect(outcome.result.unknownOutputItemTypes).toEqual(['future_item']);
      expect(outcome.result.traceId).toBe('trace-cmp');
    }
    const options = provider.compactCalls[0]!.options;
    expect(options?.signal).toBe(signal);
    expect(options?.auth).toEqual({ apiKey: 'sk-1' });
    expect(options?.cacheKey).toBe('session-1');
    expect(options?.thinking).toEqual({ effort: 'high', keep: 'all' });
    expect(options?.maxCompletionTokens).toBe(512);
    expect(options?.usedContextTokens).toBe(5000);
    expect(options?.maxContextTokens).toBe(128000);
    expect(options?.onTraceId).toBeDefined();
  });

  it('replays once after a forced token refresh on 401 (runWithAuthRefresh NOT bypassed)', async () => {
    const provider = new FakeChatProvider();
    provider.installCompact();
    provider.compactHandler = (callIndex) =>
      callIndex === 0
        ? Promise.reject(new APIStatusError(401, 'unauthorized'))
        : Promise.resolve(compactionResult());
    const authCalls: Array<{ force?: boolean }> = [];
    const requester = new ModelRequesterImpl(
      modelWith({
        canRefresh: true,
        getAuth: (options) => {
          authCalls.push(options ?? {});
          return Promise.resolve({ apiKey: authCalls.length === 1 ? 'tok-1' : 'tok-2' });
        },
      }),
      registryReturning(provider),
    );

    const outcome = await requester.compactConversation(INPUT);

    expect(outcome.kind).toBe('ok');
    expect(provider.compactCalls).toHaveLength(2);
    expect(provider.compactCalls[0]?.options?.auth).toEqual({ apiKey: 'tok-1' });
    expect(provider.compactCalls[1]?.options?.auth).toEqual({ apiKey: 'tok-2' });
    expect(authCalls).toEqual([{}, { force: true }]);
  });

  it('propagates abort as an abort error — never an error outcome', async () => {
    const provider = new FakeChatProvider();
    provider.installCompact();
    const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider));

    const controller = new AbortController();
    controller.abort();
    await expect(requester.compactConversation(INPUT, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(provider.compactCalls).toHaveLength(0);

    provider.compactHandler = () => Promise.reject(createAbortError());
    await expect(requester.compactConversation(INPUT)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('translates non-abort provider failures into an error outcome', async () => {
    const provider = new FakeChatProvider();
    provider.installCompact();
    const raw = new APIStatusError(500, 'internal');
    provider.compactHandler = () => Promise.reject(raw);
    const requester = new ModelRequesterImpl(modelWith(staticAuth()), registryReturning(provider));

    const outcome = await requester.compactConversation(INPUT);

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(isError2(outcome.error)).toBe(true);
      expect(unwrapErrorCause(outcome.error)).toBe(raw);
    }
  });

  it('exposes the provider lineage and undefined without an endpoint', async () => {
    const withEndpoint = new FakeChatProvider();
    withEndpoint.installCompact();
    const requester = new ModelRequesterImpl(
      modelWith(staticAuth()),
      registryReturning(withEndpoint),
    );
    expect(requester.compactionLineage()).toEqual(LINEAGE);

    const withoutEndpoint = new FakeChatProvider();
    const bare = new ModelRequesterImpl(
      modelWith(staticAuth()),
      registryReturning(withoutEndpoint),
    );
    expect(bare.compactionLineage()).toBeUndefined();
  });
});
