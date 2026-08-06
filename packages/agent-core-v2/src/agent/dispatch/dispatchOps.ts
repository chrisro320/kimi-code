/**
 * `dispatch` domain — wire Model (`DispatchModeModel`) and the
 * `dispatch_mode.set` Op (`setMode`) for the session's proactive-delegation
 * policy.
 *
 * Declares the mode as a scalar `wire` Model (initial `auto`) plus a replay
 * marker that distinguishes an explicit persisted mode from the default. The
 * single Op replaces the mode and sets that marker.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type { DispatchMode } from './dispatch';

export const DispatchModeModel = defineModel<DispatchMode>('dispatchMode', () => 'auto');
export const DispatchModeConfiguredModel = defineModel<boolean>(
  'dispatchMode.configured',
  () => false,
  { reducers: { 'dispatch_mode.set': () => true } },
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'dispatch_mode.set': typeof setMode;
  }
}

export const setMode = DispatchModeModel.defineOp('dispatch_mode.set', {
  schema: z.object({ mode: z.enum(['auto', 'ask', 'off']) }),
  apply: (_s, p) => p.mode,
});
