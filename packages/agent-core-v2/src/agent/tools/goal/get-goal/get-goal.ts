import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

// _unused keeps properties non-empty: some OpenAI-compatible relays hang on empty function schemas.
export const GetGoalToolInputSchema = z.object({ _unused: z.string().optional() }).strict();
export type GetGoalToolInput = z.infer<typeof GetGoalToolInputSchema>;

export interface IGetGoalTool extends AgentTool<GetGoalToolInput> { readonly _serviceBrand: undefined }
export const IGetGoalTool = createDecorator<IGetGoalTool>('getGoalTool');
