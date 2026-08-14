/**
 * `acp` domain — `IAcpCompressTool` implementation.
 *
 * Delegates range compression to the ACP service (`acp`), which validates the
 * cited refs against durable state and persists the new blocks before
 * reporting success. Bound at Agent scope.
 */

import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAcpService } from '#/features/acp/acp';

import DESCRIPTION from './compress.md?raw';
import { AcpCompressInputSchema, IAcpCompressTool, type AcpCompressInput } from './compress';

export class AcpCompressTool implements IAcpCompressTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'compress' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AcpCompressInputSchema);

  constructor(@IAcpService private readonly acp: IAcpService) {}

  resolveExecution(args: AcpCompressInput): ToolExecution {
    return {
      description: 'Compressing context ranges',
      approvalRule: this.name,
      execute: async (ctx) => {
        const result = await this.acp.compress({
          ranges: args.content.map((range) => ({
            startRef: range.startId,
            endRef: range.endId,
            summary: range.summary,
            ...(range.topic === undefined ? {} : { topic: range.topic }),
          })),
          toolCallId: ctx.toolCallId,
          signal: ctx.signal,
        });
        return result.ok
          ? { output: result.message }
          : { isError: true, output: result.message };
      },
    };
  }
}
