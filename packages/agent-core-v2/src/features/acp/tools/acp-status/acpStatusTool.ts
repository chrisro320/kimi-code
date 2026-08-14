/**
 * `acp` domain — `IAcpStatusTool` implementation.
 *
 * Delegates reporting to the ACP service (`acp`), which reads durable sidecar
 * state and the last known context usage without mutating anything. Bound at
 * Agent scope.
 */

import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAcpService } from '#/features/acp/acp';

import DESCRIPTION from './acp-status.md?raw';
import {
  AcpStatusInputSchema,
  IAcpStatusTool,
  type AcpStatusToolInput,
} from './acp-status';

export class AcpStatusTool implements IAcpStatusTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'acp_status' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AcpStatusInputSchema);

  constructor(@IAcpService private readonly acp: IAcpService) {}

  resolveExecution(_args: AcpStatusToolInput): ToolExecution {
    return {
      description: 'Reporting ACP status',
      approvalRule: this.name,
      execute: async () => {
        const result = await this.acp.statusReport();
        return result.ok
          ? { output: result.message }
          : { isError: true, output: result.message };
      },
    };
  }
}
