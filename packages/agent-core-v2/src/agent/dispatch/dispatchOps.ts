/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { DispatchMode } from './dispatch';

const dispatchModeSetSchema = z.object({ mode: z.enum(['auto', 'ask', 'off']) });

export class DispatchModeSet extends Event2<z.infer<typeof dispatchModeSetSchema>> {
  static override readonly type = 'dispatch_mode.set';
  static override readonly durable = true;
  static override readonly schema = dispatchModeSetSchema;
}
export interface DispatchModeSet extends z.infer<typeof dispatchModeSetSchema> {}

export const dispatchModeKey = defineState('dispatchMode', (): DispatchMode => 'auto')
  .replayable({ schema: z.custom<DispatchMode>() })
  .on(DispatchModeSet, (_s, e) => e.mode);

export const dispatchModeConfiguredKey = defineState('dispatchMode.configured', () => false)
  .replayable({ schema: z.custom<boolean>() })
  .on(DispatchModeSet, () => true);
