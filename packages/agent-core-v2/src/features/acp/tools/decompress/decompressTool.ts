/**
 * `acp` domain — `IAcpDecompressTool` implementation.
 *
 * Delegates block restoration to the ACP service (`acp`), which resolves the
 * block against durable state, persists the visibility change, and returns
 * the restored content. Bound at Agent scope.
 */

import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAcpService } from '#/features/acp/acp';

import DESCRIPTION from './decompress.md?raw';
import {
  AcpDecompressInputSchema,
  IAcpDecompressTool,
  type AcpDecompressInput,
} from './decompress';

export class AcpDecompressTool implements IAcpDecompressTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'decompress' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AcpDecompressInputSchema);

  constructor(@IAcpService private readonly acp: IAcpService) {}

  resolveExecution(args: AcpDecompressInput): ToolExecution {
    return {
      description: 'Restoring a compressed block',
      approvalRule: this.name,
      execute: async (ctx) => {
        const result = await this.acp.decompress({ ...args, signal: ctx.signal });
        return result.ok
          ? { output: result.message }
          : { isError: true, output: result.message };
      },
    };
  }
}
