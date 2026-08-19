import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

const TaskOutputInspectInputSchema = z.object({
  action: z.literal('inspect').optional(),
  task_id: z.string().describe('The background task ID to inspect.'),
  block: z
    .boolean()
    .default(false)
    .describe(
      'Whether to wait for the task to finish before returning. Discouraged — background tasks notify automatically on completion; use only when the user explicitly asked you to wait.',
    )
    .optional(),
  timeout: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .default(30)
    .describe('Maximum number of seconds to wait when block=true.')
    .optional(),
});

const TaskOutputResolutionInputSchema = z.object({
  action: z.enum(['approve_scope_expansion', 'deny_scope_expansion']),
  task_id: z.string().describe('The background agent task ID whose candidate should be resolved.'),
  candidate_hash: z.string().describe('The exact candidate hash reported by TaskOutput inspect.'),
  requested_scope: z
    .array(z.string())
    .min(1)
    .describe('The exact requested scope revision reported by TaskOutput inspect.'),
});

export const TaskOutputInputSchema = z.union([
  TaskOutputResolutionInputSchema,
  TaskOutputInspectInputSchema,
]);

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;

export interface ITaskOutputTool extends AgentTool<TaskOutputInput> { readonly _serviceBrand: undefined }
export const ITaskOutputTool = createDecorator<ITaskOutputTool>('taskOutputTool');
