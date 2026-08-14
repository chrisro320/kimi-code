/**
 * `acp` domain — `IAcpDecompressTool` contract.
 *
 * Public contract of the decompress tool — the ACP entry the LLM calls to
 * restore a compressed block's originals: input schema and the Agent-scope
 * identifier used to resolve the implementation through the container.
 * Restoration mutates only ACP sidecar state. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const AcpDecompressInputSchema = z
  .object({
    blockId: z.string(),
    full: z.boolean().optional(),
  })
  .strict();
export type AcpDecompressInput = z.infer<typeof AcpDecompressInputSchema>;

export interface IAcpDecompressTool extends AgentTool<AcpDecompressInput> {
  readonly _serviceBrand: undefined;
}
export const IAcpDecompressTool = createDecorator<IAcpDecompressTool>('acpDecompressTool');
