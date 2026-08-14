import { describe, expect, it } from 'vitest';

import { CONTEXT_MANAGER_SECTION } from '#/agent/llmRequester/configSection';
import { IConfigService } from '#/app/config/config';
import { IAcpService } from '#/features/acp/acp';
import type { Message } from '#/kosong/contract/message';

import { testAgent, type TestAgentContext, type TestAgentOptions } from '../../harness';

type GenerateFn = NonNullable<TestAgentOptions['generate']>;

const CATALOGUED_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  baseUrl: 'https://api.example/v1',
  model: 'kimi-code',
} as const;
const CATALOGUED_MODEL_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

const SUMMARY =
  'Folded the opening three messages of the lifecycle fixture into one durable block.';

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-acp-lifecycle',
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
    usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
    finishReason: 'completed',
    rawFinishReason: 'stop',
    traceId: null,
  };
}

function messageTexts(message: Message): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function scriptedTexts(steps: readonly string[]): {
  readonly generate: GenerateFn;
  readonly historyTexts: string[];
} {
  const historyTexts: string[] = [];
  const generate: GenerateFn = async (_provider, _system, _tools, history, _callbacks, options) => {
    options?.signal?.throwIfAborted();
    historyTexts.push(history.map(messageTexts).join('\n'));
    const step = steps[historyTexts.length - 1];
    if (step === undefined) {
      throw new Error(`Unexpected generate call #${String(historyTexts.length)}`);
    }
    return textResult(step);
  };
  return { generate, historyTexts };
}

function configuredAgent(options: TestAgentOptions): TestAgentContext {
  const ctx = testAgent(options);
  ctx.configure({
    provider: CATALOGUED_PROVIDER,
    modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
  });
  ctx.appendExchange(1, `old user one ${'x'.repeat(3000)}`, 'old assistant one', 20);
  ctx.appendExchange(2, `old user two ${'y'.repeat(3000)}`, 'old assistant two', 20);
  ctx.appendExchange(3, `recent user three ${'z'.repeat(12000)}`, 'recent assistant three', 20);
  ctx.appendExchange(4, `recent user four ${'w'.repeat(12000)}`, 'recent assistant four', 20);
  ctx.appendExchange(5, `recent user five ${'v'.repeat(12000)}`, 'recent assistant five', 20);
  return ctx;
}

describe('ACP lifecycle (harness)', () => {
  it('keeps the fold through a wire resume and runs the next turn from it', async () => {
    const { generate, historyTexts } = scriptedTexts(['reply one', 'reply two']);
    const ctx = configuredAgent({ generate });
    await ctx.get(IConfigService).set(CONTEXT_MANAGER_SECTION, 'acp-kernel');

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'prompt one' }] });
    await ctx.untilTurnEnd();
    expect(historyTexts).toHaveLength(1);

    const acp = ctx.get(IAcpService);
    const compressed = await acp.compress({
      ranges: [{ startRef: 'm00001', endRef: 'm00004', summary: SUMMARY }],
    });
    expect(compressed.ok, compressed.message).toBe(true);

    await ctx.expectResumeMatches();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'prompt two' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({ event: 'turn.ended', args: expect.objectContaining({ reason: 'completed' }) }),
    );
    expect(historyTexts).toHaveLength(2);
    expect(historyTexts[1]).toContain(SUMMARY);
    expect(historyTexts[1]).toContain('old user one');
    expect(historyTexts[1]).not.toContain('old assistant one');
    expect(historyTexts[1]).not.toContain('old user two');
    expect(historyTexts[1]).not.toContain('old assistant two');
    expect(historyTexts[1]).toContain('prompt two');
  });
});
