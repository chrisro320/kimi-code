import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

// _unused keeps properties non-empty: some OpenAI-compatible relays hang on empty function schemas.
export const CronListInputSchema = z.object({ _unused: z.string().optional() }).strict();
export type CronListInput = z.infer<typeof CronListInputSchema>;

export interface ICronListTool extends AgentTool<CronListInput> { readonly _serviceBrand: undefined }
export const ICronListTool = createDecorator<ICronListTool>('cronListTool');
