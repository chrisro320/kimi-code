/**
 * `acp` domain — `IAcpSearchContextTool` contract.
 *
 * Public contract of the search_context tool — the ACP entry the LLM calls to
 * locate folded detail across block summaries and message history: input
 * schema and the Agent-scope identifier used to resolve the implementation
 * through the container. Search never mutates state. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const AcpSearchContextInputSchema = z
  .object({
    query: z.string(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type AcpSearchContextInput = z.infer<typeof AcpSearchContextInputSchema>;

export interface IAcpSearchContextTool extends AgentTool<AcpSearchContextInput> {
  readonly _serviceBrand: undefined;
}
export const IAcpSearchContextTool = createDecorator<IAcpSearchContextTool>(
  'acpSearchContextTool',
);
