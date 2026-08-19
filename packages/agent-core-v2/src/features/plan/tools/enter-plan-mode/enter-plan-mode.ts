import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

// _unused keeps properties non-empty: some OpenAI-compatible relays hang on empty function schemas.
export const EnterPlanModeInputSchema = z.object({ _unused: z.string().optional() }).strict();
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>;

export interface IEnterPlanModeTool extends AgentTool<EnterPlanModeInput> {
  readonly _serviceBrand: undefined;
}
export const IEnterPlanModeTool = createDecorator<IEnterPlanModeTool>('enterPlanModeTool');
