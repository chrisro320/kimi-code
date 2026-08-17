/**
 * `acp` domain — `IAcpSearchContextTool` implementation.
 *
 * Delegates the query to the ACP service (`acp`), which scores block metadata
 * and message history against durable state without mutating the journal.
 * Bound at Agent scope.
 */

import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAcpService } from '#/features/acp/acp';

import DESCRIPTION from './search-context.md?raw';
import {
  AcpSearchContextInputSchema,
  IAcpSearchContextTool,
  type AcpSearchContextInput,
} from './search-context';

export class AcpSearchContextTool implements IAcpSearchContextTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'search_context' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AcpSearchContextInputSchema);

  constructor(@IAcpService private readonly acp: IAcpService) {}

  resolveExecution(args: AcpSearchContextInput): ToolExecution {
    return {
      description: 'Searching context history',
      approvalRule: this.name,
      execute: async () => {
        const result = await this.acp.search(args);
        return result.ok
          ? { output: result.message }
          : { isError: true, output: result.message };
      },
    };
  }
}
