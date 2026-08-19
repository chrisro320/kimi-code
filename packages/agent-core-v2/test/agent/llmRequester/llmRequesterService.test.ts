import { createControlledPromise } from '@antfu/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentContextProjectorService,
  type MediaStripSnapshot,
  type ProjectionPolicy,
} from '#/agent/contextProjector/contextProjector';
import { AgentContextProjectorService } from '#/agent/contextProjector/contextProjectorService';
import { AgentLLMRequesterService } from '#/agent/llmRequester/llmRequesterService';
import {
  IAgentLLMRequesterService,
  type ContextManager,
  type TransformResult,
} from '#/agent/llmRequester/llmRequester';
import { CONTEXT_MANAGER_SECTION } from '#/agent/llmRequester/configSection';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IConfigService } from '#/app/config/config';
import type { Event2 } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import {
  APIConnectionError,
  APIEmptyResponseError,
  APIRequestTooLargeError,
  APIStatusError,
} from '#/kosong/contract/errors';
import { emptyUsage, type TokenUsage } from '#/kosong/contract/usage';
import {
  isToolCall,
  type Message,
  type StreamedMessagePart,
  type ToolCall,
} from '#/kosong/contract/message';
import type { CompactionCheckpoint } from '#/kosong/contract/compaction';
import type { ThinkingEffort } from '#/kosong/contract/provider';
import type { ModelCapability } from '#/kosong/contract/capability';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import {
  type ModelCompactionInput,
  type ModelCompactionOutcome,
  type ModelRequestEvent,
  type ModelRequestInput,
  type ModelRequester,
} from '#/kosong/model/modelRequester';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ILogService } from '#/_base/log/log';
import { Error2, ErrorCodes } from '#/errors';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { WireRecord } from '#/wire/record';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

import {
  recordingWireLog,
  registerTestAgentWire,
  registerTestEventDispatcher,
} from '../../wire/stubs';

const capabilities: ModelCapability = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: false,
  max_context_tokens: 1000,
};

const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
];

type ProjectionKind = 'normal' | 'strict' | 'degraded' | 'stripped';

function classifyProjectionPolicy(policy: ProjectionPolicy | undefined): ProjectionKind {
  if (typeof policy?.media === 'object') return 'stripped';
  if (policy?.media === 'degraded') return 'degraded';
  if (policy?.structure === 'strict') return 'strict';
  return 'normal';
}

function recordProjectionCalls(): {
  projector: Pick<IAgentContextProjectorService, 'project'>;
  calls: ProjectionKind[];
} {
  const calls: ProjectionKind[] = [];
  return {
    projector: {
      project: (messages: readonly ContextMessage[], policy) => {
        calls.push(classifyProjectionPolicy(policy));
        return messages;
      },
    },
    calls,
  };
}

function createRequester(
  calls: { value: number },
  firstCallError?: Error | null,
  subsequentCallErrors: readonly Error[] = [],
  capturedInputs?: ModelRequestInput[],
): ModelRequester {
  const model: Model = {
    id: 'm',
    name: 'wire-model',
    aliases: [],
    protocol: 'anthropic',
    baseUrl: 'https://example.test',
    headers: {},
    capabilities,
    maxContextSize: 1000,
    alwaysThinking: false,
    providerName: 'p',
    authProvider: { getAuth: async () => undefined },
  };
  return {
    model,
    request: async function* (input) {
      calls.value += 1;
      capturedInputs?.push(input);
      const error =
        calls.value === 1
          ? firstCallError === null
            ? undefined
            : (firstCallError ??
              new APIStatusError(400, 'messages: `tool_use` ids must be unique'))
          : subsequentCallErrors[calls.value - 2];
      if (error !== undefined) throw error;
      yield {
        type: 'finish',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
        providerFinishReason: 'completed',
        rawFinishReason: 'stop',
        id: 'resp-1',
      };
    },
    compactConversation: async () => ({ kind: 'unsupported' }),
    compactionLineage: () => undefined,
  };
}

let disposables: DisposableStore;

function yieldUsage(requester: ModelRequester): ModelRequester {
  const base = requester.request.bind(requester);
  requester.request = async function* (input, signal, options) {
    yield {
      type: 'usage',
      usage: { inputOther: 40, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
      model: 'wire-model',
    };
    yield* base(input, signal, options);
  };
  return requester;
}

beforeEach(() => {
  disposables = new DisposableStore();
});

afterEach(() => disposables.dispose());

function createService(
  requester: ModelRequester,
  projector:
    | (Pick<IAgentContextProjectorService, 'project'> &
        Partial<Pick<IAgentContextProjectorService, 'captureMediaStripSnapshot'>>)
    | undefined,
  options: {
    readonly thinkingLevel?: ThinkingEffort;
    readonly mediaResolver?: Partial<IAgentMediaResolverService>;

    readonly capabilitiesOverride?: ModelCapability;
    readonly historyOverride?: readonly ContextMessage[];
    readonly contextMessages?: Message[];
    readonly configValues?: Record<string, unknown>;
    readonly tokenCounts?: { readonly size: number; readonly measured: number; readonly estimated: number };
  } = {},
) {
  const ix = disposables.add(new TestInstantiationService());
  const thinkingLevel = options.thinkingLevel ?? 'off';
  const caps = options.capabilitiesOverride ?? capabilities;
  const profile: Partial<IAgentProfileService> = {
    resolveModelContext: () => ({
      modelAlias: 'm',
      modelCapabilities: caps,
      maxOutputSize: undefined,
      alwaysThinking: undefined,
      thinkingLevel,
      reservedContextSize: undefined,
      compactionTriggerRatio: undefined,
    }),
    resolveRequestParams: () => ({}),
    getSystemPrompt: () => 'system',
    data: () => ({
      cwd: '',
      modelAlias: 'm',
      modelCapabilities: caps,
      thinkingLevel,
      systemPrompt: 'system',
    }),
  };
  const measuredCalls: { readonly messages: number; readonly usage: TokenUsage }[] = [];
  const measuredSnapshots: (readonly Message[])[] = [];
  const tokenCounting = {
    get: () => options.tokenCounts ?? { size: 0, measured: 0, estimated: 0 },
    measured: (input: readonly Message[], _output: readonly Message[], usage: TokenUsage) => {
      measuredCalls.push({ messages: input.length, usage });
      measuredSnapshots.push(input);
    },
  };
  const usage = { record: () => undefined, status: () => ({}) };
  const context = {

    get: () => options.historyOverride ?? options.contextMessages ?? history,
  };
  const tools = { list: () => [] };
  const config: Partial<IConfigService> = {
    get: ((section: string) => options.configValues?.[section]) as IConfigService['get'],
  };
  const warnings: { readonly message: string; readonly payload: unknown }[] = [];
  const infos: { readonly message: string; readonly payload: unknown }[] = [];
  const log = {
    info: (message: string, payload?: unknown) => {
      infos.push({ message, payload });
    },
    warn: (message: string, payload?: unknown) => {
      warnings.push({ message, payload });
    },
  };
  const telemetryRecords: TelemetryRecord[] = [];
  const telemetry = recordingTelemetry(telemetryRecords);
  const toolSelect: Partial<IAgentToolSelectService> = {
    enabled: () => false,
    shapeTools: (entries) => entries,
    shapeHistory: (messages) => messages,
  };
  const testSnapshot = Object.freeze({}) as MediaStripSnapshot;
  const events: Event2[] = [];
  const eventBus: IEventBus = {
    _serviceBrand: undefined,
    publish: (event) => events.push(event),
    subscribe: () => toDisposable(() => {}),
  };

  ix.stub(IAgentContextMemoryService, context);
  ix.stub(IAgentToolSelectService, toolSelect);
  ix.stub(IAgentMediaResolverService, options.mediaResolver ?? { resolve: async (messages) => messages });
  if (projector === undefined) {
    ix.set(
      IAgentContextProjectorService,
      new SyncDescriptor(AgentContextProjectorService),
    );
  } else {
    ix.stub(IAgentContextProjectorService, {
      captureMediaStripSnapshot: () => testSnapshot,
      ...projector,
    });
  }
  ix.stub(IAgentTokenCountingService, tokenCounting);
  ix.stub(IAgentToolRegistryService, tools);
  ix.stub(IAgentProfileService, profile);
  ix.stub(IAgentUsageService, usage);
  ix.stub(IConfigService, config);
  ix.stub(ILogService, log);
  ix.stub(ITelemetryService, telemetry);
  ix.stub(IModelCatalog, {
    _serviceBrand: undefined,
    get: () => requester.model,
    getRequester: () => requester,
    findByName: () => [],
  });
  ix.stub(IModelService, {
    get: () => undefined,
  });
  const records: WireRecord[] = [];
  registerTestAgentWire(ix, 'wire/llm-requester', {
    log: recordingWireLog(records),
    eventBus,
  });
  registerTestEventDispatcher(ix);
  ix.set(IAgentStateService, new AgentStateService());
  ix.set(IAgentLLMRequesterService, new SyncDescriptor(AgentLLMRequesterService));

  return {
    service: ix.get(IAgentLLMRequesterService),
    dispatcher: ix.get(IEventDispatcher),
    records,
    events,
    telemetryRecords,
    measuredCalls,
    measuredSnapshots,
    warnings,
    infos,
  };
}

describe('AgentLLMRequesterService measured anchors', () => {
  it('skips the measured anchor when the stream reports no usage', async () => {
    const { service, measuredCalls } = createService(createRequester({ value: 0 }), undefined);

    await service.request();

    expect(measuredCalls).toHaveLength(0);
  });

  it('writes the measured anchor from the reported usage', async () => {
    const requester = createRequester({ value: 0 });
    const base = requester.request.bind(requester);
    requester.request = async function* (input, signal, options) {
      yield {
        type: 'usage',
        usage: { inputOther: 40, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
        model: 'wire-model',
      };
      yield* base(input, signal, options);
    };
    const { service, measuredCalls } = createService(requester, undefined);

    await service.request();

    expect(measuredCalls).toHaveLength(1);
    expect(measuredCalls[0]?.usage.inputOther).toBe(40);
  });
});

describe('AgentLLMRequesterService Anthropic effort diagnostics', () => {
  it('warns and sends when the effort is not listed by the model', async () => {
    const calls = { value: 0 };
    const requester = createRequester(calls, null);
    Object.defineProperty(requester.model, 'supportEfforts', { value: ['max'] });
    const { service, events } = createService(requester, undefined, { thinkingLevel: 'high' });

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(1);
    expect(events.filter((event) => event.type === 'warning')).toEqual([
      expect.objectContaining({
        type: 'warning',
        code: 'anthropic-thinking-effort-not-listed',
        message:
          'Thinking effort "high" is not listed for model "wire-model" (known: max). The configured value will be sent unchanged to the Anthropic-compatible backend.',
      }),
    ]);
  });
});

describe('AgentLLMRequesterService strict resend', () => {
  it('resends once with strict projection after a recoverable structural 400', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(createRequester(calls), projection.projector);

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result.usage).toEqual(emptyUsage());
    expect(calls.value).toBe(2);
    expect(projection.calls).toEqual(['normal', 'strict']);
  });

  it('does not resend for non-recoverable errors', async () => {
    const requester = createRequester({ value: 0 });
    Object.defineProperty(requester, 'request', {
      value: async function* () {
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        throw new APIStatusError(401, 'unauthorized');
      },
    });
    const projection = recordProjectionCalls();
    const { service } = createService(requester, projection.projector);

    await expect(service.request()).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(projection.calls).toEqual(['normal']);
  });
});

describe('AgentLLMRequesterService media-stripped resend', () => {
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
  );

  it('resends once with the media-stripped projection after an image-format 400', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(createRequester(calls, IMAGE_FORMAT_400), projection.projector);

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(projection.calls).toEqual(['normal', 'stripped']);
  });

  // Verbatim from a 2026-08-02 session: an OpenAI-shaped gateway in front of a
  // text-only model rejects the content-part variant itself, not the image.
  const UNSUPPORTED_CONTENT_PART_400 = new APIStatusError(
    400,
    '400 Error from provider (Console Go): Upstream request failed: ' +
      '[invalid_request_error] Failed to deserialize the JSON body into the target type: ' +
      'messages[139]: unknown variant `image_url`, expected `text` at line 1 column 438509',
  );

  it('resends once with the media-stripped projection after an unsupported-content-part 400', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(
      createRequester(calls, UNSUPPORTED_CONTENT_PART_400),
      projection.projector,
    );

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(projection.calls).toEqual(['normal', 'stripped']);
  });

  it('keeps later steps of the same turn on the stripped projection', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(createRequester(calls, IMAGE_FORMAT_400), projection.projector);

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);
    expect(projection.calls).toEqual(['normal', 'stripped']);

    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(projection.calls).toEqual(['normal', 'stripped', 'stripped']);
  });

  it('does not resend for an unrelated 400', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(
      createRequester(calls, new APIStatusError(400, 'some other validation problem')),
      projection.projector,
    );

    await expect(service.request()).rejects.toMatchObject({ statusCode: 400 });
    expect(calls.value).toBe(1);
    expect(projection.calls).toEqual(['normal']);
  });
});

describe('AgentLLMRequesterService media-degraded resend', () => {
  const BODY_TOO_LARGE_413 = new APIRequestTooLargeError(413, 'Request Entity Too Large');

  it('resends once with the media-degraded projection after an HTTP 413', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(
      createRequester(
        calls,
        new Error2(ErrorCodes.PROVIDER_API_ERROR, 'Provider request failed', {
          cause: BODY_TOO_LARGE_413,
        }),
      ),
      projection.projector,
    );

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(projection.calls).toEqual(['normal', 'degraded']);
  });

  it('falls back to media-stripped when the media-degraded request still receives 413', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413]),
      projection.projector,
    );

    const result = await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(3);
    expect(projection.calls).toEqual(['normal', 'degraded', 'stripped']);
  });

  it('records repeated-413 recovery projections on the sticky later request', async () => {
    const calls = { value: 0 };
    const { service, dispatcher, records } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413]),
      {
        project: (messages: readonly ContextMessage[]) => messages,
      },
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    await dispatcher.flush();

    expect(
      records
        .filter((record) => record.type === 'llm.request')
        .map((record) => record['projection']),
    ).toEqual([undefined, 'media-degraded', 'media-stripped', 'media-stripped']);
  });

  it('keeps new recovery media visible on later snapshot-stripped steps', async () => {
    const calls = { value: 0 };
    const capturedInputs: ModelRequestInput[] = [];
    const oldUrl = 'data:image/png;base64,REJECTED';
    const newUrl = 'data:image/png;base64,SMALL';
    const imageMessage = (url: string, id: string): Message => ({
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url, id } }],
      toolCalls: [],
    });
    const { service } = createService(
      createRequester(
        calls,
        BODY_TOO_LARGE_413,
        [BODY_TOO_LARGE_413],
        capturedInputs,
      ),
      undefined,
    );

    await service.request({
      messages: [imageMessage(oldUrl, 'rejected-id')],
      source: { type: 'turn', turnId: 1, step: 1 },
    });
    await service.request({
      messages: [
        imageMessage(oldUrl, 'rejected-id'),
        imageMessage(newUrl, 'recovery-id'),
      ],
      source: { type: 'turn', turnId: 1, step: 2 },
    });

    const visibleUrls = capturedInputs
      .at(-1)
      ?.messages.flatMap((message) => message.content)
      .filter((part) => part.type === 'image_url')
      .map((part) => part.imageUrl.url);
    expect(visibleUrls).toEqual([newUrl]);
  });

  it('stops after the media-stripped request also receives 413', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413, BODY_TOO_LARGE_413]),
      projection.projector,
    );

    await expect(
      service.request({ source: { type: 'turn', turnId: 1, step: 1 } }),
    ).rejects.toBe(BODY_TOO_LARGE_413);
    expect(calls.value).toBe(3);
    expect(projection.calls).toEqual(['normal', 'degraded', 'stripped']);
  });

  it('keeps later steps of the same turn on the degraded projection', async () => {
    const calls = { value: 0 };
    const projection = recordProjectionCalls();
    const { service } = createService(createRequester(calls, BODY_TOO_LARGE_413), projection.projector);

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);
    expect(projection.calls).toEqual(['normal', 'degraded']);

    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(projection.calls).toEqual(['normal', 'degraded', 'degraded']);
  });

  it('does not resend for a plain 400 or a non-413 status', async () => {
    for (const error of [
      new APIStatusError(400, 'max_tokens must be positive'),
      new APIStatusError(422, 'unprocessable'),
    ]) {
      const calls = { value: 0 };
      const projection = recordProjectionCalls();
      const { service } = createService(createRequester(calls, error), projection.projector);

      await expect(service.request()).rejects.toBe(error);
      expect(calls.value).toBe(1);
      expect(projection.calls).toEqual(['normal']);
    }
  });
});

describe('AgentLLMRequesterService combined recovery projections', () => {
  const BODY_TOO_LARGE_413 = new APIRequestTooLargeError(413, 'Request Entity Too Large');
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
  );
  const STRUCTURAL_400 = new APIStatusError(400, 'messages: `tool_use` ids must be unique');

  function createPolicyRecordingProjector(policies: {
    policies: (ProjectionPolicy | undefined)[];
  }): Pick<IAgentContextProjectorService, 'project'> {
    return {
      project: (messages: readonly ContextMessage[], policy) => {
        policies.policies.push(policy);
        return messages;
      },
    };
  }

  it('accumulates media repairs on top of strict across repeated rejections', async () => {
    const calls = { value: 0 };
    const policies: (ProjectionPolicy | undefined)[] = [];
    const { service, dispatcher, records } = createService(
      createRequester(calls, STRUCTURAL_400, [BODY_TOO_LARGE_413, BODY_TOO_LARGE_413]),
      createPolicyRecordingProjector({ policies }),
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(calls.value).toBe(4);
    expect(policies).toEqual([
      undefined,
      { structure: 'strict' },
      { structure: 'strict', media: 'degraded' },
      { structure: 'strict', media: { strip: expect.anything() } },
    ]);
    await dispatcher.flush();
    expect(
      records.filter((record) => record.type === 'llm.request').map((record) => record['projection']),
    ).toEqual([undefined, 'strict', 'strict-media-degraded', 'strict-media-stripped']);
  });

  it('strips rejected images on top of strict after an image-format rejection on the strict resend', async () => {
    const calls = { value: 0 };
    const policies: (ProjectionPolicy | undefined)[] = [];
    const { service } = createService(
      createRequester(calls, STRUCTURAL_400, [IMAGE_FORMAT_400]),
      createPolicyRecordingProjector({ policies }),
    );

    await service.request();

    expect(calls.value).toBe(3);
    expect(policies.map((policy) => policy?.structure)).toEqual([undefined, 'strict', 'strict']);
    expect(typeof policies[2]?.media).toBe('object');
  });

  it('applies the strict repair on top of degraded media when a structural 400 follows a 413', async () => {
    const calls = { value: 0 };
    const policies: (ProjectionPolicy | undefined)[] = [];
    const { service } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [STRUCTURAL_400]),
      createPolicyRecordingProjector({ policies }),
    );

    await service.request();

    expect(calls.value).toBe(3);
    expect(policies).toEqual([
      undefined,
      { media: 'degraded' },
      { structure: 'strict', media: 'degraded' },
    ]);
  });
});

describe('AgentLLMRequesterService trace id', () => {
  const passthroughProjector = {
    project: (messages: readonly ContextMessage[]) => messages,
  };

  function createTracedRequester(traceId: string | null): ModelRequester {
    const model: Model = {
      id: 'm',
      name: 'wire-model',
      aliases: [],
      protocol: 'openai',
      baseUrl: 'https://example.test',
      headers: {},
      capabilities,
      maxContextSize: 1000,
      alwaysThinking: false,
      providerName: 'p',
      authProvider: { getAuth: async () => undefined },
    };
    return {
      model,
      request: async function* (_input, _signal, requestOptions) {
        requestOptions?.onTraceId?.(traceId);
        yield {
          type: 'finish',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
          providerFinishReason: 'completed',
          rawFinishReason: 'stop',
          id: 'resp-1',
          traceId: traceId ?? undefined,
        };
      },
      compactConversation: async () => ({ kind: 'unsupported' }),
      compactionLineage: () => undefined,
    };
  }

  it('exposes the request trace and returns it on finish', async () => {
    const requester = createTracedRequester('trace-req-1');
    const headersArrived = createControlledPromise<void>();
    const releaseStream = createControlledPromise<void>();
    Object.defineProperty(requester, 'request', {
      value: async function* (_input: unknown, _signal: unknown, requestOptions: {
        onTraceId?: (traceId: string | null) => void;
      }) {
        requestOptions.onTraceId?.('trace-req-1');
        headersArrived.resolve();
        await releaseStream;
        yield {
          type: 'finish',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
          providerFinishReason: 'completed',
          rawFinishReason: 'stop',
          id: 'resp-1',
          traceId: 'trace-req-1',
        } satisfies ModelRequestEvent;
      },
    });
    const { service } = createService(requester, passthroughProjector);
    const request = service.start({ source: { type: 'turn', turnId: 1, step: 1 } });
    await headersArrived;
    expect(request.trace.traceId).toBe('trace-req-1');
    releaseStream.resolve();
    const finish = await request.result;

    expect(finish.traceId).toBe('trace-req-1');
    expect(request.trace.traceId).toBe('trace-req-1');
  });

  it('reports an absent trace before a request that returns none', async () => {
    const { service } = createService(createTracedRequester(null), passthroughProjector);
    const request = service.start();
    const finish = await request.result;

    expect(finish.traceId).toBeUndefined();
    expect(request.trace.traceId).toBeUndefined();
  });

  it('attaches trace_id, turn_id and step_no to api_error from the failed request', async () => {
    const requester = createTracedRequester(null);
    Object.defineProperty(requester, 'request', {
      value: async function* () {
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        throw new APIStatusError(500, 'boom', 'req-1', null, 'trace-fail-1');
      },
    });
    const { service, telemetryRecords } = createService(requester, passthroughProjector);
    const request = service.start({ source: { type: 'turn', turnId: 3, step: 2 } });
    await expect(request.result).rejects.toMatchObject({ statusCode: 500 });

    expect(telemetryRecords).toContainEqual({
      event: 'api_error',
      properties: expect.objectContaining({
        error_type: '5xx_server',
        trace_id: 'trace-fail-1',
        turn_id: 3,
        step_no: 2,
      }),
    });
    expect(request.trace.traceId).toBe('trace-fail-1');
  });

  it('keeps the header-captured trace when the request fails after headers arrived', async () => {
    const requester = createTracedRequester(null);
    Object.defineProperty(requester, 'request', {
      value: async function* (...args: unknown[]) {
        const requestOptions = args[2] as
          | { onTraceId?: (traceId: string | null) => void }
          | undefined;
        requestOptions?.onTraceId?.('trace-mid-stream');
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        throw new APIEmptyResponseError('no content, no tool calls');
      },
    });
    const { service, telemetryRecords } = createService(requester, passthroughProjector);
    const request = service.start({ source: { type: 'turn', turnId: 4, step: 1 } });
    await expect(request.result).rejects.toThrow();

    const apiError = telemetryRecords.find((record) => record.event === 'api_error');
    expect(apiError?.properties?.['trace_id']).toBe('trace-mid-stream');
    expect(request.trace.traceId).toBe('trace-mid-stream');
  });

  it('clears the previous physical request trace before a projection retry', async () => {
    const requester = createTracedRequester(null);
    let attempts = 0;
    Object.defineProperty(requester, 'request', {
      value: async function* (...args: unknown[]) {
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        attempts += 1;
        const requestOptions = args[2] as
          | { onTraceId?: (traceId: string | null) => void }
          | undefined;
        if (attempts === 1) {
          requestOptions?.onTraceId?.('trace-first-projection');
          throw new APIRequestTooLargeError(413, 'retry with degraded media');
        }
        throw new APIConnectionError('socket hang up');
      },
    });
    const { service, telemetryRecords } = createService(requester, passthroughProjector);
    const request = service.start();
    await expect(request.result).rejects.toThrow('socket hang up');

    expect(attempts).toBe(2);
    expect(request.trace.traceId).toBeUndefined();
    expect(
      telemetryRecords.find((record) => record.event === 'api_error')?.properties?.['trace_id'],
    ).toBeUndefined();
  });
});


describe('AgentLLMRequesterService compact', () => {
  const LINEAGE = { provider: 'p', model: 'wire-model', baseUrl: 'https://example.test' };

  function checkpoint(overrides: Partial<CompactionCheckpoint> = {}): CompactionCheckpoint {
    return {
      encrypted: 'opaque-payload',
      itemType: 'compaction',
      lineage: { ...LINEAGE },
      replayInputTokens: { kind: 'unknown' },
      ...overrides,
    };
  }

  function historyWithCheckpoint(cp: CompactionCheckpoint): ContextMessage[] {
    return [
      { role: 'user', content: [{ type: 'text', text: 'kept' }], toolCalls: [] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'readable summary' }],
        toolCalls: [],
        origin: { kind: 'compaction_summary', checkpoint: cp },
      },
    ];
  }

  function compactCapableRequester(
    captured: { input?: ModelCompactionInput },
    outcome: ModelCompactionOutcome,
  ): ModelRequester {
    const requester = createRequester({ value: 0 });
    requester.compactConversation = async (input) => {
      captured.input = input;
      return outcome;
    };
    requester.compactionLineage = () => ({ ...LINEAGE });
    return requester;
  }

  const OK_OUTCOME: ModelCompactionOutcome = {
    kind: 'ok',
    result: {
      checkpoint: checkpoint(),
      retainedMessages: [],
      usage: emptyUsage(),
      traceId: 'trace-cmp',
    },
  };

  it('replays an owned checkpoint through the ordinary request path in summary position', async () => {
    const captured: ModelRequestInput[] = [];
    const requester = createRequester({ value: 0 }, null, [], captured);
    requester.compactionLineage = () => ({ ...LINEAGE });
    const cp = checkpoint({ itemType: 'compaction_summary', itemId: 'cmp-1' });
    const { service } = createService(requester, undefined, {
      historyOverride: [
        { role: 'user', content: [{ type: 'text', text: 'before' }], toolCalls: [] },
        ...historyWithCheckpoint(cp).slice(1),
        { role: 'user', content: [{ type: 'text', text: 'after' }], toolCalls: [] },
      ],
    });

    await service.request();


    const parts = captured[0]!.messages.flatMap((message) => message.content);
    expect(parts).toEqual([
      { type: 'text', text: 'before' },
      { type: 'compaction', ...cp },
      { type: 'text', text: 'after' },
    ]);
  });

  it('keeps the readable summary on the ordinary request path for foreign lineage', async () => {
    const captured: ModelRequestInput[] = [];
    const requester = createRequester({ value: 0 }, null, [], captured);
    requester.compactionLineage = () => ({ ...LINEAGE, model: 'other-model' });
    const { service } = createService(requester, undefined, {
      historyOverride: historyWithCheckpoint(checkpoint()),
    });

    await service.request();

    const parts = captured[0]!.messages.flatMap((message) => message.content);
    expect(parts).toEqual([
      { type: 'text', text: 'kept' },
      { type: 'text', text: 'readable summary' },
    ]);
    expect(parts.some((part) => (part as { type: string }).type === 'compaction')).toBe(false);
  });

  it('projects history against capability+lineage and drives the requester boundary', async () => {
    const captured: { input?: ModelCompactionInput } = {};
    const requester = compactCapableRequester(captured, OK_OUTCOME);
    const { service } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
    });
    const cp = checkpoint();

    const outcome = await service.compact({ history: historyWithCheckpoint(cp) });

    expect(outcome).toBe(OK_OUTCOME);
    const input = captured.input!;
    expect(input.systemPrompt).toBe('system');
    expect(input.history.map((item) => item.kind)).toEqual(['message', 'checkpoint']);
    const checkpointItem = input.history[1];
    expect(checkpointItem).toEqual({ kind: 'checkpoint', checkpoint: cp });
  });

  it('uses the normal request projection when no checkpoint is replayed', async () => {
    const captured: { input?: ModelCompactionInput } = {};
    const requester = compactCapableRequester(captured, OK_OUTCOME);
    const { service } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
    });
    const history: ContextMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'first' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'second' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    ];

    await service.compact({ history });

    expect(captured.input!.history).toHaveLength(1);
    expect(captured.input!.history[0]).toMatchObject({
      kind: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'first\n\nsecond' }] },
    });
  });

  it('matches the ordinary request projection around an owned checkpoint', async () => {
    const captured: { input?: ModelCompactionInput } = {};
    const requester = compactCapableRequester(captured, OK_OUTCOME);
    const { service } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
    });
    const user = (text: string): ContextMessage => ({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    const cp = checkpoint({ itemType: 'compaction_summary', itemId: 'cmp-1' });
    const history: ContextMessage[] = [
      user('before one'),
      user('before two'),
      ...historyWithCheckpoint(cp).slice(1),
      user('after one'),
      user('after two'),
    ];

    await service.compact({ history });

    expect(captured.input!.history).toEqual([
      {
        kind: 'message',
        message: expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'before one' }],
        }),
      },
      {
        kind: 'message',
        message: expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'before two' }],
        }),
      },
      { kind: 'checkpoint', checkpoint: cp },
      {
        kind: 'message',
        message: expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'after one' }],
        }),
      },
      {
        kind: 'message',
        message: expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'after two' }],
        }),
      },
    ]);
  });

  it('never calls the provider when the model does not declare remote_compaction', async () => {
    let calls = 0;
    const requester = createRequester({ value: 0 });
    requester.compactConversation = async () => {
      calls += 1;
      return OK_OUTCOME;
    };
    requester.compactionLineage = () => ({ ...LINEAGE });
    const { service } = createService(requester, undefined);

    await expect(service.compact()).resolves.toEqual({ kind: 'unsupported' });
    expect(calls).toBe(0);
  });

  it('degrades checkpoints to portable summary text when the provider reports no lineage', async () => {
    const captured: { input?: ModelCompactionInput } = {};
    const requester = compactCapableRequester(captured, OK_OUTCOME);
    requester.compactionLineage = () => undefined;
    const { service } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
    });

    await service.compact({ history: historyWithCheckpoint(checkpoint()) });

    const input = captured.input!;
    expect(input.history.every((item) => item.kind === 'message')).toBe(true);
    expect(JSON.stringify(input.history)).not.toContain('opaque-payload');
  });

  it('returns the typed unsupported outcome as-is', async () => {
    const requester = createRequester({ value: 0 });
    const { service } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
    });

    await expect(service.compact()).resolves.toEqual({ kind: 'unsupported' });
  });

  it('writes a distinguishable remote_compaction wire record before the request', async () => {
    const captured: { input?: ModelCompactionInput } = {};
    const requester = compactCapableRequester(captured, OK_OUTCOME);
    const { service, dispatcher, records } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
    });

    await service.compact({ history: historyWithCheckpoint(checkpoint()) });
    await dispatcher.flush();

    const remote = records.filter(
      (record) => record.type === 'llm.request' && record['kind'] === 'remote_compaction',
    );
    expect(remote).toHaveLength(1);
    expect(remote[0]?.['messageCount']).toBe(2);
  });

  it('writes no wire record when the capability gate refuses the request', async () => {
    const requester = compactCapableRequester({}, OK_OUTCOME);
    const { service, dispatcher, records } = createService(requester, undefined);

    await expect(service.compact()).resolves.toEqual({ kind: 'unsupported' });
    await dispatcher.flush();

    expect(records.filter((record) => record.type === 'llm.request')).toHaveLength(0);
  });

  it('passes retainedMessages through untouched', async () => {
    const captured: { input?: ModelCompactionInput } = {};
    const requester = compactCapableRequester(captured, OK_OUTCOME);
    const { service } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
    });
    const retained: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'keep me' }], toolCalls: [] },
    ];

    await service.compact({ retainedMessages: retained });

    expect(captured.input!.retainedMessages).toEqual(retained);
  });

  it('passes the compact history through the active manager transform', async () => {
    const captured: { input?: ModelCompactionInput } = {};
    const requester = compactCapableRequester(captured, OK_OUTCOME);
    let transformCalls = 0;
    const manager: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: ({ messages }) => {
        transformCalls += 1;
        return {
          accounting: 'transformed',
          messages: messages.map((message) => ({
            ...message,
            content: [{ type: 'text' as const, text: 'compressed' }],
          })),
        };
      },
    };
    const { service } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
      configValues: { [CONTEXT_MANAGER_SECTION]: 'pipe' },
    });
    service.registerContextManager(manager);

    const plain: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }], toolCalls: [] },
    ];
    await service.compact({ history: plain });

    expect(transformCalls).toBe(1);
    expect(captured.input!.history.length).toBeGreaterThan(0);
    expect(
      captured.input!.history.every(
        (item) =>
          item.kind === 'checkpoint' ||
          item.message.content.every(
            (part) =>
              (part as { type: string }).type !== 'text' ||
              (part as { text?: string }).text === 'compressed',
          ),
      ),
    ).toBe(true);
  });

  it('skips the transform for a bypass request context', async () => {
    const captured: { input?: ModelCompactionInput } = {};
    const requester = compactCapableRequester(captured, OK_OUTCOME);
    let transformCalls = 0;
    const manager: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: ({ messages }) => {
        transformCalls += 1;
        return { messages, accounting: 'transformed' };
      },
    };
    const { service } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
      configValues: { [CONTEXT_MANAGER_SECTION]: 'pipe' },
    });
    service.registerContextManager(manager);

    await service.compactInternal(
      { manager: undefined, transform: 'bypass' },
      { history: historyWithCheckpoint(checkpoint()) },
    );

    expect(transformCalls).toBe(0);
    expect(captured.input!.history.map((item) => item.kind)).toEqual(['message', 'checkpoint']);
  });

  it('accepts a transform that preserves the checkpoint carrier', async () => {
    const captured: { input?: ModelCompactionInput } = {};
    const requester = compactCapableRequester(captured, OK_OUTCOME);
    const preserving: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: ({ messages }) => ({
        accounting: 'transformed',
        messages: messages.map((message) =>
          message.content.some((part) => (part as { type: string }).type === 'compaction')
            ? message
            : { ...message, content: [{ type: 'text' as const, text: 'compressed' }] },
        ),
      }),
    };
    const { service } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
      configValues: { [CONTEXT_MANAGER_SECTION]: 'pipe' },
    });
    service.registerContextManager(preserving);
    const cp = checkpoint();

    await service.compact({ history: historyWithCheckpoint(cp) });

    expect(captured.input!.history.map((item) => item.kind)).toEqual(['message', 'checkpoint']);
    expect(captured.input!.history[0]).toMatchObject({
      kind: 'message',
      message: { content: [{ type: 'text', text: 'compressed' }] },
    });
    expect(captured.input!.history[1]).toEqual({ kind: 'checkpoint', checkpoint: cp });
  });

  it('falls back to the original messages when the transform loses the carrier', async () => {
    const captured: { input?: ModelCompactionInput } = {};
    const requester = compactCapableRequester(captured, OK_OUTCOME);
    const dropping: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: ({ messages }) => ({
        accounting: 'transformed',
        messages: messages.filter(
          (message) =>
            !message.content.some((part) => (part as { type: string }).type === 'compaction'),
        ),
      }),
    };
    const { service, warnings } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
      configValues: { [CONTEXT_MANAGER_SECTION]: 'pipe' },
    });
    service.registerContextManager(dropping);
    const cp = checkpoint();

    await service.compact({ history: historyWithCheckpoint(cp) });

    expect(captured.input!.history.map((item) => item.kind)).toEqual(['message', 'checkpoint']);
    expect(captured.input!.history[0]).toMatchObject({
      kind: 'message',
      message: { content: [{ type: 'text', text: 'kept' }] },
    });
    expect(captured.input!.history[1]).toEqual({ kind: 'checkpoint', checkpoint: cp });
    expect(warnings.some((entry) => entry.message.includes('compaction carriers'))).toBe(true);
  });

  it('falls back when a transform moves a carrier into another message envelope', async () => {
    const captured: { input?: ModelCompactionInput } = {};
    const requester = compactCapableRequester(captured, OK_OUTCOME);
    const moving: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: ({ messages }) => {
        const carrierMessage = messages.find((message) =>
          message.content.some((part) => (part as { type: string }).type === 'compaction'),
        )!;
        const carrier = carrierMessage.content.find(
          (part) => (part as { type: string }).type === 'compaction',
        )!;
        return {
          accounting: 'transformed',
          messages: [
            { ...messages[0]!, content: [...messages[0]!.content, carrier] },
            { ...carrierMessage, content: [] },
          ],
        };
      },
    };
    const { service, warnings } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
      configValues: { [CONTEXT_MANAGER_SECTION]: 'pipe' },
    });
    service.registerContextManager(moving);
    const cp = checkpoint();

    await service.compact({ history: historyWithCheckpoint(cp) });

    expect(captured.input!.history.map((item) => item.kind)).toEqual(['message', 'checkpoint']);
    expect(warnings.some((entry) => entry.message.includes('compaction carriers'))).toBe(true);
  });

  it('falls back to the original messages when the transform rewrites a carrier in place', async () => {
    const captured: { input?: ModelCompactionInput } = {};
    const requester = compactCapableRequester(captured, OK_OUTCOME);
    const mutating: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: ({ messages }) => {
        const carrier = messages
          .flatMap((message) => message.content)
          .find((part) => (part as { type: string }).type === 'compaction') as
          | ({ encrypted: string } & { type: string })
          | undefined;
        if (carrier !== undefined) carrier.encrypted = 'rewritten-in-place';
        return { messages, accounting: 'transformed' };
      },
    };
    const { service, warnings } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
      configValues: { [CONTEXT_MANAGER_SECTION]: 'pipe' },
    });
    service.registerContextManager(mutating);
    const cp = checkpoint();

    await service.compact({ history: historyWithCheckpoint(cp) });

    expect(captured.input!.history.map((item) => item.kind)).toEqual(['message', 'checkpoint']);
    const replayed = captured.input!.history[1];
    expect(replayed).toEqual({ kind: 'checkpoint', checkpoint: cp });
    expect(replayed!.kind === 'checkpoint' ? replayed!.checkpoint.encrypted : undefined).toBe(
      'opaque-payload',
    );
    expect(warnings.some((entry) => entry.message.includes('compaction carriers'))).toBe(true);
  });

  it('accepts a transform whose carrier property insertion order differs', async () => {
    const captured: { input?: ModelCompactionInput } = {};
    const requester = compactCapableRequester(captured, OK_OUTCOME);
    const reordering: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: ({ messages }) => ({
        accounting: 'transformed',
        messages: messages.map((message) => {
          if (
            !message.content.some((part) => (part as { type: string }).type === 'compaction')
          ) {
            return { ...message, content: [{ type: 'text' as const, text: 'compressed' }] };
          }
          return {
            ...message,
            content: message.content.map((part) => {
              const carrier = part as unknown as { type: 'compaction' } & CompactionCheckpoint;
              if (carrier.type !== 'compaction') return part;
              const { type, ...checkpoint } = carrier;
              return { ...checkpoint, type } as unknown as Message['content'][number];
            }),
          };
        }),
      }),
    };
    const { service, warnings } = createService(requester, undefined, {
      capabilitiesOverride: { ...capabilities, remote_compaction: true },
      configValues: { [CONTEXT_MANAGER_SECTION]: 'pipe' },
    });
    service.registerContextManager(reordering);
    const cp = checkpoint();

    await service.compact({ history: historyWithCheckpoint(cp) });

    expect(captured.input!.history.map((item) => item.kind)).toEqual(['message', 'checkpoint']);
    expect(captured.input!.history[0]).toMatchObject({
      kind: 'message',
      message: { content: [{ type: 'text', text: 'compressed' }] },
    });
    expect(captured.input!.history[1]).toEqual({ kind: 'checkpoint', checkpoint: cp });
    expect(warnings.some((entry) => entry.message.includes('compaction carriers'))).toBe(false);
  });
});

describe('AgentLLMRequesterService context manager registration', () => {
  function stubManager(id: string): ContextManager {
    return {
      id,
      version: '1',
      transformMessages: (input) => ({ messages: input.messages, accounting: 'raw-equivalent' }),
    };
  }

  it('throws on a duplicate registration and restores the slot on dispose', () => {
    const { service } = createService(createRequester({ value: 0 }), undefined, {
      configValues: { [CONTEXT_MANAGER_SECTION]: 'alpha' },
    });

    const registration = service.registerContextManager(stubManager('alpha'));
    expect(() => service.registerContextManager(stubManager('beta'))).toThrow(
      /already registered/,
    );

    registration.dispose();
    expect(service.getActiveContextManager()).toBeUndefined();

    const replacement = service.registerContextManager(stubManager('alpha'));
    expect(service.getActiveContextManager()?.id).toBe('alpha');
    replacement.dispose();
  });

  it('resolves the manager only when the config section names its id', () => {
    const { service: disabled } = createService(createRequester({ value: 0 }), undefined);
    disabled.registerContextManager(stubManager('alpha'));
    expect(disabled.getActiveContextManager()).toBeUndefined();

    const { service: enabled } = createService(createRequester({ value: 0 }), undefined, {
      configValues: { [CONTEXT_MANAGER_SECTION]: 'alpha' },
    });
    const manager = stubManager('alpha');
    enabled.registerContextManager(manager);
    expect(enabled.getActiveContextManager()).toBe(manager);
  });

  it('warns once on first resolution when the configured id has no matching registration', () => {
    const { service, warnings } = createService(createRequester({ value: 0 }), undefined, {
      configValues: { [CONTEXT_MANAGER_SECTION]: 'ghost' },
    });

    expect(service.getActiveContextManager()).toBeUndefined();
    expect(service.getActiveContextManager()).toBeUndefined();
    expect(warnings.filter((entry) => entry.message.includes('"ghost"'))).toHaveLength(1);

    service.registerContextManager(stubManager('other'));
    expect(service.getActiveContextManager()).toBeUndefined();
    expect(warnings.filter((entry) => entry.message.includes('"ghost"'))).toHaveLength(1);
  });

  it('logs once on the first successful activation and stays silent afterwards', () => {
    const { service, infos } = createService(createRequester({ value: 0 }), undefined, {
      configValues: { [CONTEXT_MANAGER_SECTION]: 'alpha' },
    });

    service.registerContextManager(stubManager('alpha'));
    expect(service.getActiveContextManager()?.id).toBe('alpha');
    expect(service.getActiveContextManager()?.id).toBe('alpha');
    expect(infos.filter((entry) => entry.message.includes('"alpha"'))).toHaveLength(1);

    const { service: quiet } = createService(createRequester({ value: 0 }), undefined);
    quiet.registerContextManager(stubManager('alpha'));
    expect(quiet.getActiveContextManager()).toBeUndefined();
  });

  // The override exists so a session-scoped choice never has to be written to
  // the shared config file. Each case below pins one row of the precedence
  // table; swapping the two reads in getActiveContextManager must redden at
  // least one of them.
  it('activates from the override with no config section set', () => {
    const { service } = createService(createRequester({ value: 0 }), undefined);
    const manager = stubManager('alpha');
    service.registerContextManager(manager);

    expect(service.getActiveContextManager()).toBeUndefined();

    service.setContextManagerOverride('alpha');
    expect(service.getActiveContextManager()).toBe(manager);
  });

  it('opts out on a null override even while the config section names the manager', () => {
    const { service } = createService(createRequester({ value: 0 }), undefined, {
      configValues: { [CONTEXT_MANAGER_SECTION]: 'alpha' },
    });
    const manager = stubManager('alpha');
    service.registerContextManager(manager);
    expect(service.getActiveContextManager()).toBe(manager);

    service.setContextManagerOverride(null);
    expect(service.getActiveContextManager()).toBeUndefined();
  });

  it('defers to the config section while the override is unset', () => {
    const { service } = createService(createRequester({ value: 0 }), undefined, {
      configValues: { [CONTEXT_MANAGER_SECTION]: 'alpha' },
    });
    const manager = stubManager('alpha');
    service.registerContextManager(manager);

    // `undefined` is the absence of a choice, not an opt-out: the section
    // still decides, so existing config-only setups keep working unchanged.
    service.setContextManagerOverride(undefined);
    expect(service.getActiveContextManager()).toBe(manager);
  });

  it('outranks a config section naming a different manager', () => {
    const { service } = createService(createRequester({ value: 0 }), undefined, {
      configValues: { [CONTEXT_MANAGER_SECTION]: 'beta' },
    });
    const manager = stubManager('alpha');
    service.registerContextManager(manager);
    expect(service.getActiveContextManager()).toBeUndefined();

    service.setContextManagerOverride('alpha');
    expect(service.getActiveContextManager()).toBe(manager);
  });

  it('keeps the once-per-id activation log deduped for an override-resolved id', () => {
    const { service, infos } = createService(createRequester({ value: 0 }), undefined);
    service.registerContextManager(stubManager('alpha'));
    service.setContextManagerOverride('alpha');

    expect(service.getActiveContextManager()?.id).toBe('alpha');
    expect(service.getActiveContextManager()?.id).toBe('alpha');
    expect(infos.filter((entry) => entry.message.includes('"alpha"'))).toHaveLength(1);
  });

  it('warns once when the override names a manager that is not registered', () => {
    const { service, warnings } = createService(createRequester({ value: 0 }), undefined);
    service.registerContextManager(stubManager('alpha'));
    service.setContextManagerOverride('ghost');

    expect(service.getActiveContextManager()).toBeUndefined();
    expect(service.getActiveContextManager()).toBeUndefined();
    expect(warnings.filter((entry) => entry.message.includes('"ghost"'))).toHaveLength(1);
  });
});

describe('AgentLLMRequesterService context transform pipeline', () => {
  const enabledConfig = { [CONTEXT_MANAGER_SECTION]: 'pipe' };
  const sentinel: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'sentinel' }], toolCalls: [] },
  ];
  const sentinelProjector = {
    project: () => sentinel,
    projectStrict: () => sentinel,
  };

  it('keeps both disabled cases byte-identical, reference-identical, and manager-free', async () => {
    const baselineCaptured: ModelRequestInput[] = [];
    const baseline = createService(
      createRequester({ value: 0 }, null, [], baselineCaptured),
      sentinelProjector,
    );
    await baseline.service.request();

    let transformCalls = 0;
    const manager: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: (input) => {
        transformCalls += 1;
        return { messages: input.messages, accounting: 'raw-equivalent' };
      },
    };
    const registeredCaptured: ModelRequestInput[] = [];
    const registered = createService(
      createRequester({ value: 0 }, null, [], registeredCaptured),
      sentinelProjector,
    );
    registered.service.registerContextManager(manager);
    await registered.service.request();

    expect(transformCalls).toBe(0);
    expect(baselineCaptured).toHaveLength(1);
    expect(registeredCaptured).toHaveLength(1);
    expect(registeredCaptured[0]).toEqual(baselineCaptured[0]);
    expect(baselineCaptured[0]!.messages).toBe(sentinel);
    expect(registeredCaptured[0]!.messages).toBe(sentinel);
  });

  it('does not poison the transform queue after a rejection', async () => {
    let calls = 0;
    const manager: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: (input) => {
        calls += 1;
        if (calls === 1) throw new Error('transform boom');
        return { messages: input.messages, accounting: 'transformed' };
      },
    };
    const captured: ModelRequestInput[] = [];
    const { service } = createService(createRequester({ value: 0 }, null, [], captured), undefined, {
      configValues: enabledConfig,
    });
    service.registerContextManager(manager);

    await expect(service.request()).rejects.toThrow('transform boom');
    await service.request();

    expect(calls).toBe(2);
    expect(captured).toHaveLength(1);
  });

  it('aborts only the cancelled queue entry', async () => {
    let calls = 0;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const manager: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: (input) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<TransformResult>((_resolve, reject) => {
            firstStarted();
            input.signal.addEventListener('abort', () => reject(input.signal.reason), {
              once: true,
            });
          });
        }
        return { messages: input.messages, accounting: 'raw-equivalent' };
      },
    };
    const { service } = createService(createRequester({ value: 0 }, null), undefined, {
      configValues: enabledConfig,
    });
    service.registerContextManager(manager);

    const controller = new AbortController();
    const first = service.request({}, undefined, controller.signal);
    await started;
    const second = service.request();
    controller.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await second;
    expect(calls).toBe(2);
  });

  it('aborts an in-flight transform when the service is disposed', async () => {
    let transformStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      transformStarted = resolve;
    });
    const manager: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: (input) =>
        new Promise<TransformResult>((_resolve, reject) => {
          transformStarted();
          input.signal.addEventListener('abort', () => reject(input.signal.reason), {
            once: true,
          });
        }),
    };
    const { service } = createService(createRequester({ value: 0 }, null), undefined, {
      configValues: enabledConfig,
    });
    service.registerContextManager(manager);

    const pending = service.request();
    await started;
    (service as unknown as { dispose(): void }).dispose();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('unblocks the transform queue when a manager ignores the abort signal', async () => {
    let calls = 0;
    let transformStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      transformStarted = resolve;
    });
    const manager: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: (input) => {
        calls += 1;
        if (calls === 1) {
          transformStarted();
          return new Promise<TransformResult>(() => {});
        }
        return { messages: input.messages, accounting: 'raw-equivalent' };
      },
    };
    const { service } = createService(createRequester({ value: 0 }, null), undefined, {
      configValues: enabledConfig,
    });
    service.registerContextManager(manager);

    const controller = new AbortController();
    const first = service.request({}, undefined, controller.signal);
    await started;
    controller.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await service.request();
    expect(calls).toBe(2);
  });

  it('settles an in-flight transform on dispose even when the manager ignores the signal', async () => {
    let transformStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      transformStarted = resolve;
    });
    const manager: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: () => {
        transformStarted();
        return new Promise<TransformResult>(() => {});
      },
    };
    const { service } = createService(createRequester({ value: 0 }, null), undefined, {
      configValues: enabledConfig,
    });
    service.registerContextManager(manager);

    const pending = service.request();
    await started;
    (service as unknown as { dispose(): void }).dispose();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('AgentLLMRequesterService identity and test transformers', () => {
  it('identity manager: manager runs yet the payload stays byte-identical to disabled', async () => {
    const baselineCaptured: ModelRequestInput[] = [];
    const baseline = createService(
      createRequester({ value: 0 }, null, [], baselineCaptured),
      undefined,
    );
    await baseline.service.request();

    let calls = 0;
    const identity: ContextManager = {
      id: 'identity',
      version: '1',
      transformMessages: (input) => {
        calls += 1;
        return { messages: input.messages, accounting: 'raw-equivalent' };
      },
    };
    const captured: ModelRequestInput[] = [];
    const { service, measuredCalls } = createService(
      yieldUsage(createRequester({ value: 0 }, null, [], captured)),
      undefined,
      { configValues: { [CONTEXT_MANAGER_SECTION]: 'identity' } },
    );
    service.registerContextManager(identity);
    await service.request();

    expect(calls).toBe(1);
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured[0])).toBe(JSON.stringify(baselineCaptured[0]));
    expect(measuredCalls).toHaveLength(1);
  });

  it('test transformer: replacement lands while adjacency, think, and toolCallId stay legal', async () => {
    const toolHistory: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'run the tool' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'thinking…', encrypted: 'enc-blob' },
          { type: 'text', text: 'calling the tool' },
        ],
        toolCalls: [{ type: 'function', id: 'call-1', name: 'Lookup', arguments: '{"q":"x"}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'x'.repeat(500) }],
        toolCalls: [],
        toolCallId: 'call-1',
      },
      { role: 'assistant', content: [{ type: 'text', text: 'final answer' }], toolCalls: [] },
    ];
    const truncating: ContextManager = {
      id: 'trunc',
      version: '1',
      transformMessages: ({ messages }) => ({
        accounting: 'transformed',
        messages: messages.map((message) =>
          message.role === 'tool'
            ? { ...message, content: [{ type: 'text' as const, text: '[truncated]' }] }
            : message,
        ),
      }),
    };
    const captured: ModelRequestInput[] = [];
    const passthrough = {
      project: (messages: readonly ContextMessage[]) => [...messages],
      projectStrict: (messages: readonly ContextMessage[]) => [...messages],
    };
    const { service } = createService(
      createRequester({ value: 0 }, null, [], captured),
      passthrough,
      {
        historyOverride: toolHistory,
        configValues: { [CONTEXT_MANAGER_SECTION]: 'trunc' },
      },
    );
    service.registerContextManager(truncating);
    await service.request();

    expect(captured).toHaveLength(1);
    const messages = captured[0]!.messages;
    const assistant = messages[1]!;
    const tool = messages[2]!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.toolCalls.map((call) => call.id)).toEqual(['call-1']);
    expect(tool.role).toBe('tool');
    expect(tool.toolCallId).toBe('call-1');
    expect(assistant.content[0]).toEqual({
      type: 'think',
      think: 'thinking…',
      encrypted: 'enc-blob',
    });
    expect(tool.content).toEqual([{ type: 'text', text: '[truncated]' }]);
    expect(JSON.stringify(messages)).not.toContain('x'.repeat(500));
  });
});

describe('AgentLLMRequesterService transform accounting', () => {
  const ACCOUNTING_LINEAGE = { provider: 'p', model: 'wire-model', baseUrl: 'https://example.test' };

  function accountingCheckpoint(): CompactionCheckpoint {
    return {
      encrypted: 'opaque-payload',
      itemType: 'compaction',
      lineage: { ...ACCOUNTING_LINEAGE },
      replayInputTokens: { kind: 'unknown' },
    };
  }

  function identityManager(id: string, captured?: { usedContextTokens?: number }): ContextManager {
    return {
      id,
      version: '1',
      transformMessages: (input) => {
        if (captured !== undefined) captured.usedContextTokens = input.usedContextTokens;
        return { messages: input.messages, accounting: 'raw-equivalent' };
      },
    };
  }

  it('writes no raw-context anchor when the call reports transformed', async () => {
    const transforming: ContextManager = {
      id: 'pipe',
      version: '1',
      transformMessages: ({ messages }) => ({
        accounting: 'transformed',
        messages: messages.map((message) => ({ ...message })),
      }),
    };
    const { service, measuredCalls } = createService(
      yieldUsage(createRequester({ value: 0 }, null)),
      undefined,
      { configValues: { [CONTEXT_MANAGER_SECTION]: 'pipe' } },
    );
    service.registerContextManager(transforming);

    await service.request();

    expect(measuredCalls).toHaveLength(0);
  });

  it('passes tokenCounting.get().size as usedContextTokens, not the measured floor', async () => {
    const captured: { usedContextTokens?: number } = {};
    const { service } = createService(createRequester({ value: 0 }, null), undefined, {
      configValues: { [CONTEXT_MANAGER_SECTION]: 'pipe' },
      tokenCounts: { size: 777, measured: 100, estimated: 677 },
    });
    service.registerContextManager(identityManager('pipe', captured));

    await service.request();

    expect(captured.usedContextTokens).toBe(777);
  });

  it('anchors against the pre-shaping snapshot even when the projector merges adjacent user messages', async () => {
    const history: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }], toolCalls: [], origin: { kind: 'user' } },
      { role: 'user', content: [{ type: 'text', text: 'second' }], toolCalls: [], origin: { kind: 'user' } },
    ];
    const captured: ModelRequestInput[] = [];
    const { service, measuredSnapshots } = createService(
      yieldUsage(createRequester({ value: 0 }, null, [], captured)),
      undefined,
      {
        historyOverride: history,
        configValues: { [CONTEXT_MANAGER_SECTION]: 'pipe' },
      },
    );
    service.registerContextManager(identityManager('pipe'));

    await service.request();

    expect(captured[0]!.messages).toHaveLength(1);
    expect(measuredSnapshots).toHaveLength(1);
    expect(measuredSnapshots[0]).toHaveLength(2);
    expect(measuredSnapshots[0]![0]).toBe(history[0]);
    expect(measuredSnapshots[0]![1]).toBe(history[1]);
  });

  it('anchors against the pre-projection snapshot around checkpoint replay', async () => {
    const cp = accountingCheckpoint();
    const history: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'kept' }], toolCalls: [], origin: { kind: 'user' } },
      {
        role: 'user',
        content: [{ type: 'text', text: 'readable summary' }],
        toolCalls: [],
        origin: { kind: 'compaction_summary', checkpoint: cp },
      },
    ];
    const captured: ModelRequestInput[] = [];
    const requester = yieldUsage(createRequester({ value: 0 }, null, [], captured));
    requester.compactionLineage = () => ({ ...ACCOUNTING_LINEAGE });
    const { service, measuredSnapshots } = createService(requester, undefined, {
      historyOverride: history,
      configValues: { [CONTEXT_MANAGER_SECTION]: 'pipe' },
    });
    service.registerContextManager(identityManager('pipe'));

    await service.request();

    const parts = captured[0]!.messages.flatMap((message) => message.content);
    expect(parts.some((part) => (part as { type: string }).type === 'compaction')).toBe(true);
    expect(measuredSnapshots).toHaveLength(1);
    expect(measuredSnapshots[0]).toHaveLength(2);
    expect(measuredSnapshots[0]![0]).toBe(history[0]);
    expect(measuredSnapshots[0]![1]).toBe(history[1]);
  });
});

describe('AgentLLMRequesterService media resolver wiring', () => {
  it('resolves the projected messages through the DI-injected media resolver', async () => {
    const requester = createRequester({ value: 0 }, null);
    const resolve = vi.fn(async (messages: readonly Message[], _requester: ModelRequester) => messages);
    const { service } = createService(requester, undefined, {
      mediaResolver: { resolve },
    });

    await service.request();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[1]).toBe(requester);
  });
});

describe('AgentLLMRequesterService tool call id normalization', () => {
  function createScriptedRequester(
    script: { ids: string[]; error?: Error }[],
  ): ModelRequester {
    const base = createRequester({ value: 0 });
    let callIndex = 0;
    return {
      model: base.model,
      request: async function* () {
        const step = script[Math.min(callIndex++, script.length - 1)]!;
        if (step.error !== undefined) {
          if (step.ids.length > 0) {
            yield {
              type: 'part',
              part: {
                type: 'function',
                id: step.ids[0]!,
                name: 'Bash',
                arguments: null,
                _streamIndex: 0,
              },
            } satisfies ModelRequestEvent;
          }
          throw step.error;
        }
        const toolCalls: ToolCall[] = [];
        for (const [index, id] of step.ids.entries()) {
          yield {
            type: 'part',
            part: { type: 'function', id, name: 'Bash', arguments: null, _streamIndex: index },
          } satisfies ModelRequestEvent;
          yield {
            type: 'part',
            part: { type: 'tool_call_part', argumentsPart: '{"command":"ls"}', index },
          } satisfies ModelRequestEvent;
          toolCalls.push({ type: 'function', id, name: 'Bash', arguments: '{"command":"ls"}' });
        }
        yield {
          type: 'finish',
          message: { role: 'assistant', content: [], toolCalls },
          providerFinishReason: 'completed',
          rawFinishReason: 'stop',
          id: 'resp-1',
        } satisfies ModelRequestEvent;
      },
      compactConversation: async () => ({ kind: 'unsupported' }),
      compactionLineage: () => undefined,
    };
  }

  it('passes provider-unique ids through unchanged', async () => {
    const parts: StreamedMessagePart[] = [];
    const { service } = createService(
      createScriptedRequester([{ ids: ['call_1', 'call_2'] }]),
      undefined,
    );

    const result = await service.request({}, (part) => {
      parts.push(part);
    });

    expect(result.message.toolCalls.map((c) => c.id)).toEqual(['call_1', 'call_2']);
    expect(parts.filter(isToolCall).map((p) => p.id)).toEqual(['call_1', 'call_2']);
  });

  it('rewrites an id repeated across responses and keeps streamed parts consistent', async () => {
    const parts: StreamedMessagePart[] = [];
    const { service } = createService(
      createScriptedRequester([{ ids: ['Bash_0'] }, { ids: ['Bash_0'] }]),
      undefined,
    );

    const first = await service.request({}, (part) => {
      parts.push(part);
    });
    const second = await service.request({}, (part) => {
      parts.push(part);
    });

    expect(first.message.toolCalls[0]!.id).toBe('Bash_0');
    expect(second.message.toolCalls[0]!.id).toBe('Bash_0__2');
    expect(parts.filter(isToolCall).map((p) => p.id)).toEqual(['Bash_0', 'Bash_0__2']);
  });

  it('rewrites duplicates within a single response', async () => {
    const { service } = createService(
      createScriptedRequester([{ ids: ['Bash_0', 'Bash_0'] }]),
      undefined,
    );

    const result = await service.request();

    expect(result.message.toolCalls.map((c) => c.id)).toEqual(['Bash_0', 'Bash_0__2']);
  });

  it('rolls claims back when the attempt fails mid-stream', async () => {
    const { service } = createService(
      createScriptedRequester([
        { ids: ['Bash_9'], error: new Error('stream boom') },
        { ids: ['Bash_9'] },
      ]),
      undefined,
    );

    await expect(service.request()).rejects.toThrow('stream boom');
    const retry = await service.request();
    expect(retry.message.toolCalls[0]!.id).toBe('Bash_9');
  });

  it('rewrites an id that already exists in the restored context', async () => {
    const { service } = createService(
      createScriptedRequester([{ ids: ['Bash_0'] }]),
      undefined,
      {
        contextMessages: [
          {
            role: 'assistant',
            content: [],
            toolCalls: [{ type: 'function', id: 'Bash_0', name: 'Bash', arguments: '{}' }],
          },
        ],
      },
    );

    const result = await service.request();
    expect(result.message.toolCalls[0]!.id).toBe('Bash_0__2');
  });
});
