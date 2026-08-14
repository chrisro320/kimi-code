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

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-acp-bench',
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

interface TurnMetric {
  readonly turn: number;
  readonly chars: number;
  readonly historyText: string;
}

async function runLongSession(acpEnabled: boolean, turnCount = 8): Promise<{
  readonly metrics: TurnMetric[];
  readonly ctx: TestAgentContext;
}> {
  const metrics: TurnMetric[] = [];
  const generate: GenerateFn = async (_provider, _system, _tools, history, _callbacks, options) => {
    options?.signal?.throwIfAborted();
    const historyText = history.map(messageTexts).join('\n');
    metrics.push({ turn: metrics.length + 1, chars: historyText.length, historyText });
    return textResult(`reply ${String(metrics.length)}`);
  };
  const ctx = testAgent({ generate });
  ctx.configure({
    provider: CATALOGUED_PROVIDER,
    modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
  });
  if (acpEnabled) {
    await ctx.get(IConfigService).set(CONTEXT_MANAGER_SECTION, 'acp-kernel');
  }
  for (let turn = 1; turn <= turnCount; turn += 1) {
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: `turn ${String(turn)} ${'q'.repeat(8000)}` }],
    });
    await ctx.untilTurnEnd();
  }
  return { metrics, ctx };
}

function refFor(index: number): string {
  return `m${String(index).padStart(5, '0')}`;
}

describe('ACP long-session benchmark (synthetic)', () => {
  it('bounds input size across folds while preserving recoverability and fidelity', async () => {
    const baseline = await runLongSession(false, 13);
    const acp = await runLongSession(true);

    try {
      const baselinePeak = Math.max(...baseline.metrics.map((metric) => metric.chars));
      const acpPeakBeforeFold = acp.metrics[7]!.chars;

      const acpService = acp.ctx.get(IAcpService);
      const foldOne = await acpService.compress({
        ranges: [{ startRef: refFor(1), endRef: refFor(8), summary: `Fold A covers turns one through four of the synthetic benchmark session.` }],
      });
      expect(foldOne.ok, foldOne.message).toBe(true);

      for (let turn = 9; turn <= 12; turn += 1) {
        await acp.ctx.rpc.prompt({
          input: [{ type: 'text', text: `turn ${String(turn)} ${'q'.repeat(8000)}` }],
        });
        await acp.ctx.untilTurnEnd();
      }

      const foldTwo = await acpService.compress({
        ranges: [{ startRef: refFor(9), endRef: refFor(16), summary: `Fold B covers turns five through eight of the benchmark session.` }],
      });
      expect(foldTwo.ok, foldTwo.message).toBe(true);

      await acp.ctx.rpc.prompt({ input: [{ type: 'text', text: `turn 13 ${'q'.repeat(8000)}` }] });
      await acp.ctx.untilTurnEnd();

      const finalCall = acp.metrics.at(-1)!;
      expect(finalCall.historyText).toContain('Fold A covers turns one through four');
      expect(finalCall.historyText).toContain('Fold B covers turns five through eight');
      // The kernel always keeps the first user message, so turn 1 stays visible.
      expect(finalCall.historyText).toContain('turn 1 qqq');
      expect(finalCall.historyText).not.toContain('turn 2 qqq');
      expect(finalCall.historyText).not.toContain('turn 5 qqq');
      // Immediately after each fold the outgoing history drops back below the
      // pre-fold peak (turn 9 after fold A; turn 13 after fold B). Turns between
      // scheduled folds accumulate by design, so the bound is per-fold, not per-turn.
      expect(acp.metrics[8]!.chars).toBeLessThan(acpPeakBeforeFold);
      expect(acp.metrics[12]!.chars).toBeLessThan(acpPeakBeforeFold);

      const acpFinal = finalCall.chars;
      const reduction = 1 - acpFinal / baselinePeak;
      console.table({
        baselinePeakChars: baselinePeak,
        acpPeakBeforeFoldChars: acpPeakBeforeFold,
        acpFinalCallChars: acpFinal,
        inputReductionVsBaselinePeak: `${(reduction * 100).toFixed(1)}%`,
      });
      expect(acpFinal).toBeLessThan(acpPeakBeforeFold);
      expect(acpFinal).toBeLessThan(baselinePeak * 0.6);

      const restored = await acpService.decompress({ blockId: 'b1' });
      expect(restored.ok, restored.message).toBe(true);
      // 'turn 3 qqq' lives only inside fold b1; 'turn 1' is kernel-kept and proves nothing.
      expect(restored.message).toContain('turn 3 qqq');

      await acp.ctx.rpc.prompt({ input: [{ type: 'text', text: 'turn 14 post-restore check' }] });
      await acp.ctx.untilTurnEnd();
      const postRestoreCall = acp.metrics.at(-1)!;
      expect(postRestoreCall.historyText).toContain('turn 3 qqq');
      expect(postRestoreCall.chars).toBeGreaterThan(acpFinal);
    } finally {
      await baseline.ctx.dispose();
      await acp.ctx.dispose();
    }
  });
});
