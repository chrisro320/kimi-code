/**
 * `dispatch` domain — session proactive-delegation policy for the main agent.
 * `auto`: balanced proactive delegation applies.
 * `ask`: multi-worker, editing, reviewer, or coder-ex dispatch requires
 * confirmation before launch; a single read-only worker follows normal rules.
 * `off`: the system prompt tells the model not to initiate delegation; an
 * Agent/AgentSwarm call that still occurs (explicit or otherwise — the
 * runtime cannot reliably tell them apart from tool-call context alone)
 * requires confirmation rather than being silently approved. This is a
 * deliberate fail-safe, not a natural-language classifier.
 *
 * Ported from v1 `agent/dispatch/mode.ts`. v1 kept the mode in a
 * `DispatchModeState` class logging a `dispatch_mode.set` record; in v2 the
 * mode lives in the wire `DispatchModeModel`, mutated only through the
 * `dispatch_mode.set` Op, so persistence and replay come from the wire.
 */

import { createDecorator } from "#/_base/di/instantiation";
import type { Event } from '#/_base/event';

export type DispatchMode = 'auto' | 'ask' | 'off';

export const DEFAULT_DISPATCH_MODE: DispatchMode = 'auto';

export interface DispatchModeChangedContext {
  readonly mode: DispatchMode;
  readonly previousMode: DispatchMode;
}

export interface IAgentDispatchModeService {
  readonly _serviceBrand: undefined;

  readonly mode: DispatchMode;
  setMode(mode: DispatchMode): void;

  readonly onDidChangeMode: Event<DispatchModeChangedContext>;
}

export const IAgentDispatchModeService =
  createDecorator<IAgentDispatchModeService>('agentDispatchModeService');
