import type { Agent } from '..';

/**
 * Session-scoped proactive-delegation policy for the main agent.
 * `auto`: balanced proactive delegation applies (D2).
 * `ask`: multi-worker, editing, reviewer, or coder-ex dispatch requires
 * confirmation before launch; a single read-only worker follows normal rules.
 * `off`: the system prompt tells the model not to initiate delegation; an
 * Agent/AgentSwarm call that still occurs (explicit or otherwise — the
 * runtime cannot reliably tell them apart from tool-call context alone)
 * requires confirmation rather than being silently approved. This is a
 * deliberate fail-safe, not a natural-language classifier.
 */
export type DispatchMode = 'auto' | 'ask' | 'off';

export const DEFAULT_DISPATCH_MODE: DispatchMode = 'auto';

export class DispatchModeState {
  private current: DispatchMode = DEFAULT_DISPATCH_MODE;

  constructor(protected readonly agent: Agent) {}

  get mode(): DispatchMode {
    return this.current;
  }

  /** Change the mode for the live session; logs a record and emits status. */
  set(mode: DispatchMode): void {
    if (mode === this.current) return;
    this.agent.records.logRecord({ type: 'dispatch_mode.set', mode });
    this.current = mode;
    this.agent.emitStatusUpdated();
  }

  /** Rebuild in-memory state from a persisted record; no side effects. */
  restoreSet(mode: DispatchMode): void {
    this.current = mode;
  }
}
