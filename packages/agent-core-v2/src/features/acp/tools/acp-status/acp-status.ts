/**
 * `acp` domain — `IAcpStatusTool` contract.
 *
 * Public contract of the acp_status tool — the ACP entry the LLM calls to
 * read activation, health, context usage, and compression blocks: input
 * schema and the Agent-scope identifier used to resolve the implementation
 * through the container. Status never mutates state. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

// _unused keeps properties non-empty: some OpenAI-compatible relays hang on empty function schemas.
export const AcpStatusInputSchema = z.object({ _unused: z.string().optional() }).strict();
export type AcpStatusToolInput = z.infer<typeof AcpStatusInputSchema>;

export interface IAcpStatusTool extends AgentTool<AcpStatusToolInput> {
  readonly _serviceBrand: undefined;
}
export const IAcpStatusTool = createDecorator<IAcpStatusTool>('acpStatusTool');
