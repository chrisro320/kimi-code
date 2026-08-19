/**
 * Scenario: the ACP context manager takes over compaction rounds end to end.
 *
 * Responsibilities: assert the overflow-blocked takeover drives its own bypass
 * summarizer request (never the built-in worker), that a stale cached view
 * declines back to the built-in round, and that disabling the manager section
 * returns ownership mid-session. Wiring: testAgent harness with a scripted
 * generate; ACP is activated through the real `contextManager` config section.
 */

import { describe, expect, it } from 'vitest';

import { APIContextOverflowError } from '#/kosong/contract/errors';
import type { Message } from '#/kosong/contract/message';
import { CONTEXT_MANAGER_SECTION } from '#/agent/llmRequester/configSection';
import { IConfigService } from '#/app/config/config';

import { testAgent, type TestAgentContext } from '../../harness';
import type { TestAgentOptions } from '../../harness';

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

/** Marker sentence unique to the ACP-owned compaction template. */
const ACP_INSTRUCTION_MARKER = 'the references go dead';
/** Marker word unique to the built-in compaction template. */
const BUILTIN_INSTRUCTION_MARKER = 'size-capped';

interface SeenRequest {
  readonly toolCount: number;
  readonly historyLength: number;
  readonly historyText: string;
  readonly lastRole: string | undefined;
}

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-acp-takeover',
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

/**
 * A generate script: each entry answers one call — `'overflow'` throws a
 * context-overflow error, anything else is the response text.
 */
function scriptedCalls(steps: readonly string[]): {
  readonly generate: GenerateFn;
  readonly seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  const generate: GenerateFn = async (_provider, _system, tools, history, _callbacks, options) => {
    options?.signal?.throwIfAborted();
    seen.push({
      toolCount: tools.length,
      historyLength: history.length,
      historyText: history.map(messageTexts).join('\n'),
      lastRole: history.at(-1)?.role,
    });
    const step = steps[seen.length - 1];
    if (step === undefined) {
      throw new Error(`Unexpected generate call #${String(seen.length)}`);
    }
    if (step === 'overflow') {
      throw new APIContextOverflowError(400, 'Context length exceeded', 'req-acp-overflow');
    }
    return textResult(step);
  };
  return { generate, seen };
}

function configuredAgent(options: TestAgentOptions): TestAgentContext {
  const ctx = testAgent(options);
  ctx.configure({
    provider: CATALOGUED_PROVIDER,
    modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
  });
  ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
  ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
  return ctx;
}

function countEvents(events: ReturnType<TestAgentContext['newEvents']>, event: string): number {
  return events.filter((entry) => (entry as { readonly event?: unknown }).event === event).length;
}

describe('ACP compaction takeover (harness)', () => {
  it('takes over an overflow-blocked compaction through its own bypass request, then runs the next turn from the fold', async () => {
    const { generate, seen } = scriptedCalls([
      'overflow',
      'ACP takeover fold summary.',
      'Turn reply.',
      'Second turn reply.',
    ]);
    const ctx = configuredAgent({ generate });
    await ctx.get(IConfigService).set(CONTEXT_MANAGER_SECTION, 'acp-kernel');
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'prompt that overflows' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.started',
        // Event2 payloads also carry `time` / `instruction` — match the
        // trigger field only.
        args: expect.objectContaining({ trigger: 'auto' }),
      }),
    );
    expect(countEvents(events, 'compaction.completed')).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'turn.ended', args: expect.objectContaining({ reason: 'completed' }) }),
    );

    // Three calls: the overflowing turn request, the ACP-owned summarizer, the
    // retried turn request. The summarizer is the ACP shape: no tools, the
    // ACP instruction template as a trailing user message.
    expect(seen).toHaveLength(3);
    expect(seen[0]!.toolCount).toBeGreaterThan(0);
    expect(seen[1]!.toolCount).toBe(0);
    expect(seen[1]!.lastRole).toBe('user');
    expect(seen[1]!.historyText).toContain(ACP_INSTRUCTION_MARKER);
    expect(seen[1]!.historyText).not.toContain(BUILTIN_INSTRUCTION_MARKER);
    expect(seen[1]!.historyText).toContain('old user one');
    // The retried turn starts from the fold: the assistant messages are gone,
    // the summary is in. (Recent real user input survives the fold, as with
    // the built-in round.)
    expect(seen[2]!.historyText).toContain('ACP takeover fold summary.');
    expect(seen[2]!.historyText).not.toContain('old assistant one');
    expect(seen[2]!.historyLength).toBeLessThan(seen[0]!.historyLength);
    expect(ctx.compactHistory().some((entry) => entry.text.includes('ACP takeover fold summary.'))).toBe(
      true,
    );
    await ctx.expectResumeMatches();

    // The next turn transforms from the reset kernel state without incident.
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    const secondEvents = await ctx.untilTurnEnd();
    expect(secondEvents).toContainEqual(
      expect.objectContaining({ event: 'turn.ended', args: expect.objectContaining({ reason: 'completed' }) }),
    );
    expect(seen).toHaveLength(4);
    expect(seen[3]!.historyText).toContain('ACP takeover fold summary.');
    await ctx.expectResumeMatches();
  });

  it('declines a post-turn manual compaction so the built-in round runs it', async () => {
    const ctx = configuredAgent({});
    await ctx.get(IConfigService).set(CONTEXT_MANAGER_SECTION, 'acp-kernel');

    ctx.mockNextResponse({ type: 'text', text: 'Ordinary turn reply.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    ctx.mockNextResponse({ type: 'text', text: 'Built-in fold summary.' });
    const completed = ctx.once('compaction.completed');
    await ctx.rpc.beginCompaction({});
    await completed;

    // Turn request + built-in summarizer — and the summarizer is the built-in
    // shape: the stock tool list and the built-in instruction template.
    expect(ctx.llmCalls).toHaveLength(2);
    const summarizer = ctx.llmCalls[1]!;
    expect(summarizer.tools.length).toBeGreaterThan(0);
    const summarizerText = summarizer.history.map(messageTexts).join('\n');
    expect(summarizerText).toContain(BUILTIN_INSTRUCTION_MARKER);
    expect(summarizerText).not.toContain(ACP_INSTRUCTION_MARKER);
    expect(ctx.compactHistory().some((entry) => entry.text.includes('Built-in fold summary.'))).toBe(
      true,
    );
    await ctx.expectResumeMatches();
  });

  it('returns compaction ownership to the built-in round once the manager section is cleared, and back on re-enable', async () => {
    const { generate, seen } = scriptedCalls([
      'overflow',
      'ACP takeover fold summary.',
      'Turn reply one.',
      'overflow',
      'Built-in fold summary.',
      'Turn reply two.',
      'overflow',
      'ACP takeover fold summary two.',
      'Turn reply three.',
    ]);
    const ctx = configuredAgent({ generate });
    const config = ctx.get(IConfigService);
    await config.set(CONTEXT_MANAGER_SECTION, 'acp-kernel');
    ctx.newEvents();

    // 1) Enabled: the overflow round is taken over (calls 1-3).
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'overflow one' }] });
    await ctx.untilTurnEnd();
    expect(seen).toHaveLength(3);
    expect(seen[1]!.toolCount).toBe(0);
    expect(seen[1]!.historyText).toContain(ACP_INSTRUCTION_MARKER);

    // 2) Disabled: the same overflow shape falls to the built-in round (calls 4-6).
    await config.set(CONTEXT_MANAGER_SECTION, '');
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'overflow two' }] });
    await ctx.untilTurnEnd();
    expect(seen).toHaveLength(6);
    expect(seen[4]!.toolCount).toBeGreaterThan(0);
    expect(seen[4]!.historyText).toContain(BUILTIN_INSTRUCTION_MARKER);
    expect(seen[4]!.historyText).not.toContain(ACP_INSTRUCTION_MARKER);

    // 3) Re-enabled: takeover again (calls 7-9).
    await config.set(CONTEXT_MANAGER_SECTION, 'acp-kernel');
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'overflow three' }] });
    const events = await ctx.untilTurnEnd();
    expect(seen).toHaveLength(9);
    expect(seen[7]!.toolCount).toBe(0);
    expect(seen[7]!.historyText).toContain(ACP_INSTRUCTION_MARKER);
    expect(countEvents(events, 'compaction.completed')).toBe(1);
    await ctx.expectResumeMatches();
  });
});
