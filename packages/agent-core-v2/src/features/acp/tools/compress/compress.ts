/**
 * `acp` domain — `IAcpCompressTool` contract.
 *
 * Public contract of the compress tool — the ACP entry the LLM calls to fold
 * older message ranges into durable summary blocks: input schema and the
 * Agent-scope identifier used to resolve the implementation through the
 * container. Compression mutates only ACP sidecar state and stays reversible
 * through decompress. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const AcpCompressInputSchema = z
  .object({
    content: z
      .array(
        z
          .object({
            startId: z.string(),
            endId: z.string(),
            summary: z.string(),
            topic: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type AcpCompressInput = z.infer<typeof AcpCompressInputSchema>;

export interface IAcpCompressTool extends AgentTool<AcpCompressInput> {
  readonly _serviceBrand: undefined;
}
export const IAcpCompressTool = createDecorator<IAcpCompressTool>('acpCompressTool');
