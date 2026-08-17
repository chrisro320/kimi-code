import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { CONTEXT_MANAGER_SECTION } from '#/agent/llmRequester/configSection';
import { IConfigService } from '#/app/config/config';
import { IAcpService } from '#/features/acp/acp';
import type { Message } from '#/kosong/contract/message';

import {
  homeDirServices,
  InMemoryWireRecordPersistence,
  testAgent,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../../harness';

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
  readonly rawHistories: Message[][];
} {
  const historyTexts: string[] = [];
  const rawHistories: Message[][] = [];
  const generate: GenerateFn = async (_provider, _system, _tools, history, _callbacks, options) => {
    options?.signal?.throwIfAborted();
    historyTexts.push(history.map(messageTexts).join('\n'));
    rawHistories.push(structuredClone(history) as Message[]);
    const step = steps[historyTexts.length - 1];
    if (step === undefined) {
      throw new Error(`Unexpected generate call #${String(historyTexts.length)}`);
    }
    return textResult(step);
  };
  return { generate, historyTexts, rawHistories };
}

function configuredAgent(
  ...inputs: ReadonlyArray<TestAgentOptions | TestAgentServiceOverride>
): TestAgentContext {
  const ctx = testAgent(...inputs);
  ctx.configure({
    provider: CATALOGUED_PROVIDER,
    modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
  });
  return ctx;
}

function appendLifecycleHistory(ctx: TestAgentContext): void {
  ctx.appendExchange(1, `old user one ${'x'.repeat(3000)}`, 'old assistant one', 20);
  ctx.appendExchange(2, `old user two ${'y'.repeat(3000)}`, 'old assistant two', 20);
  ctx.appendExchange(3, `recent user three ${'z'.repeat(12000)}`, 'recent assistant three', 20);
  ctx.appendExchange(4, `recent user four ${'w'.repeat(12000)}`, 'recent assistant four', 20);
  ctx.appendExchange(5, `recent user five ${'v'.repeat(12000)}`, 'recent assistant five', 20);
}

function appendCarrierHistory(ctx: TestAgentContext): void {
  const context = ctx.get(IAgentContextMemoryService);
  context.append({
    role: 'user',
    content: [{ type: 'text', text: `carrier user one ${'x'.repeat(3000)}` }],
    toolCalls: [],
    origin: { kind: 'user' },
  });
  context.append({
    role: 'assistant',
    content: [
      {
        type: 'think',
        think: 'deliberating on the carrier fixture',
        encrypted: 'encrypted-think-payload',
      },
      { type: 'text', text: 'Calling the carrier tool.' },
    ],
    toolCalls: [
      {
        type: 'function',
        id: 'call_carrier',
        name: 'Lookup',
        arguments: '{"query":"carrier"}',
        extras: { thought_signature_b64: 'gemini-sig' },
      },
    ],
  });
  context.append({
    role: 'tool',
    toolCallId: 'call_carrier',
    content: [{ type: 'text', text: `carrier tool result ${'y'.repeat(6000)}` }],
    toolCalls: [],
  });
  for (const step of [2, 3, 4, 5]) {
    ctx.appendExchange(
      step,
      `recent user ${String(step)} ${'z'.repeat(12000)}`,
      `recent assistant ${String(step)}`,
      20,
    );
  }
}

describe('ACP lifecycle (harness)', () => {
  it('keeps the fold through a real process restart and runs the next turn from it', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'acp-lifecycle-'));
    const persistence = new InMemoryWireRecordPersistence();
    const first = scriptedTexts(['reply one']);
    const ctx1 = configuredAgent({ generate: first.generate, persistence }, homeDirServices(homeDir));
    try {
      appendLifecycleHistory(ctx1);
      await ctx1.get(IConfigService).set(CONTEXT_MANAGER_SECTION, 'acp-kernel');

      await ctx1.rpc.prompt({ input: [{ type: 'text', text: 'prompt one' }] });
      await ctx1.untilTurnEnd();
      expect(first.historyTexts).toHaveLength(1);

      const compressed = await ctx1.get(IAcpService).compress({
        ranges: [{ startRef: 'm00001', endRef: 'm00004', summary: SUMMARY }],
      });
      expect(compressed.ok, compressed.message).toBe(true);
    } finally {
      await ctx1.dispose();
    }

    const second = scriptedTexts(['reply two']);
    const ctx2 = configuredAgent(
      { generate: second.generate, persistence },
      homeDirServices(homeDir),
    );
    try {
      await ctx2.get(IConfigService).set(CONTEXT_MANAGER_SECTION, 'acp-kernel');
      await ctx2.restorePersisted();

      // The fold can only come from the on-disk sidecar: this fresh service
      // has not run a single transform in the new process.
      const acp2 = ctx2.get(IAcpService);
      const snapshot = await acp2.statusSnapshot();
      expect(snapshot).toMatchObject({ health: 'healthy', refs: 12, blocks: 1, activeBlocks: 1 });

      await ctx2.rpc.prompt({ input: [{ type: 'text', text: 'prompt two' }] });
      await ctx2.untilTurnEnd();

      expect(second.historyTexts).toHaveLength(1);
      const sent = second.historyTexts[0]!;
      expect(sent).toContain(SUMMARY);
      expect(sent).toContain('old user one');
      expect(sent).not.toContain('old assistant one');
      expect(sent).not.toContain('old user two');
      expect(sent).not.toContain('old assistant two');
      expect(sent).toContain('prompt two');
    } finally {
      await ctx2.dispose();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('preserves provider carriers through fold, restart, and decompress', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'acp-carriers-'));
    const persistence = new InMemoryWireRecordPersistence();
    const first = scriptedTexts(['reply one']);
    const ctx1 = configuredAgent({ generate: first.generate, persistence }, homeDirServices(homeDir));
    try {
      appendCarrierHistory(ctx1);
      await ctx1.get(IConfigService).set(CONTEXT_MANAGER_SECTION, 'acp-kernel');

      const acp1 = ctx1.get(IAcpService);
      await ctx1.rpc.prompt({ input: [{ type: 'text', text: 'prompt one' }] });
      await ctx1.untilTurnEnd();

      // Kernel refs run over core messages: m00001 is the opening user text,
      // m00002..m00004 the carrier assistant's text/reasoning/tool-call cores,
      // m00005 its tool result.
      const compressed = await acp1.compress({
        ranges: [{ startRef: 'm00001', endRef: 'm00005', summary: SUMMARY }],
      });
      expect(compressed.ok, compressed.message).toBe(true);
    } finally {
      await ctx1.dispose();
    }

    const second = scriptedTexts(['probe reply', 'carrier reply two']);
    const ctx2 = configuredAgent(
      { generate: second.generate, persistence },
      homeDirServices(homeDir),
    );
    try {
      await ctx2.get(IConfigService).set(CONTEXT_MANAGER_SECTION, 'acp-kernel');
      await ctx2.restorePersisted();

      const acp2 = ctx2.get(IAcpService);
      const snapshot = await acp2.statusSnapshot();
      expect(snapshot).toMatchObject({ health: 'healthy', refs: 13, blocks: 1, activeBlocks: 1 });

      await ctx2.rpc.prompt({ input: [{ type: 'text', text: 'carrier probe one' }] });
      await ctx2.untilTurnEnd();
      const folded = JSON.stringify(second.rawHistories[0]);
      expect(folded).toContain(SUMMARY);
      expect(folded).not.toContain('encrypted-think-payload');
      expect(folded).not.toContain('gemini-sig');

      const restored = await acp2.decompress({ blockId: 'b1' });
      expect(restored.ok, restored.message).toBe(true);

      await ctx2.rpc.prompt({ input: [{ type: 'text', text: 'carrier probe two' }] });
      await ctx2.untilTurnEnd();

      expect(second.rawHistories).toHaveLength(2);
      const carrier = second.rawHistories[1]!.find((message) =>
        message.toolCalls.some((call) => call.id === 'call_carrier'),
      );
      expect(carrier).toMatchObject({
        content: [
          {
            type: 'think',
            think: 'deliberating on the carrier fixture',
            encrypted: 'encrypted-think-payload',
          },
          { type: 'text', text: 'Calling the carrier tool.' },
        ],
        toolCalls: [{ id: 'call_carrier', extras: { thought_signature_b64: 'gemini-sig' } }],
      });
    } finally {
      await ctx2.dispose();
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
