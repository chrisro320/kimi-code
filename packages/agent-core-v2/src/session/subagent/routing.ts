/**
 * `subagent` domain — spawn routing resolution and weighted route pools.
 *
 * Resolves which route a subagent spawn takes: the static
 * `[subagent.routing.<profile>]` mapping (`resolveSubagentRoute`) or one
 * weighted entry out of `[[subagent.pools.<profile>]]` (`SubagentRoutePool`).
 * Both feed the spawn boundary in the `Agent`/`AgentSwarm` tools ahead of the
 * secondary-model binding; when neither hits, spawning falls back to
 * `resolveSubagentBinding` unchanged. Only in-process (`kimi`) routes are
 * implemented here — naming any other backend is a hard error, never a
 * silent downgrade to the in-process route.
 */

import { Error2, ErrorCodes } from '#/errors';
import type { IConfigService } from '#/app/config/config';
import { MODELS_SECTION } from '#/app/kosongConfig/configSection';
import type { ModelRecord } from '#/kosong/model/model';

import { SUBAGENT_SECTION, type SubagentConfig, type SubagentPoolRoute } from './configSection';

export const INTERNAL_SUBAGENT_BACKEND = 'kimi';

/**
 * The route a spawn resolves to. Only the in-process variant exists for now;
 * `kind` stays explicit so an external variant can join the union without
 * changing call sites.
 */
export interface ResolvedSubagentRoute {
  readonly kind: 'internal';
  readonly modelAlias: string | undefined;
  readonly thinkingEffort: string | undefined;
}

export function resolveSubagentRoute(
  config: IConfigService,
  profileName: string,
  modelOverride?: string,
): ResolvedSubagentRoute {
  const routing = config
    .get<SubagentConfig | undefined>(SUBAGENT_SECTION)
    ?.routing?.[profileName];
  const modelAlias = modelOverride ?? routing?.model;
  return resolveRouteByNames(config, routing?.backend, modelAlias, routing?.thinkingEffort);
}

/**
 * Shared resolution core behind {@link resolveSubagentRoute} and pool-entry
 * selection: given an explicit backend name (`undefined`/`"kimi"` for the
 * in-process subagent) and model string, validate internal Kimi aliases
 * against `config.models` and produce a `ResolvedSubagentRoute`. Any other
 * backend name is an external route, which this engine does not implement
 * yet — it fails loudly instead of silently running the in-process route.
 */
export function resolveRouteByNames(
  config: IConfigService,
  backendName: string | undefined,
  modelAlias: string | undefined,
  thinkingEffort?: string,
): ResolvedSubagentRoute {
  if (backendName === undefined || backendName === INTERNAL_SUBAGENT_BACKEND) {
    if (modelAlias !== undefined) {
      const models = config.get<Record<string, ModelRecord> | undefined>(MODELS_SECTION);
      if (models?.[modelAlias] === undefined) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `Subagent model alias "${modelAlias}" is not defined in config.models.`,
          { details: { modelAlias } },
        );
      }
    }
    return { kind: 'internal', modelAlias, thinkingEffort };
  }
  throw new Error2(
    ErrorCodes.CONFIG_INVALID,
    `Subagent backend "${backendName}" is an external backend; external subagent backends are not implemented in the v2 engine yet (batch B7).`,
    { details: { backend: backendName } },
  );
}

export interface AcquiredSubagentRoute {
  readonly route: SubagentPoolRoute;
  /** Releases this route's concurrency slot. Idempotent; call exactly once per acquire. */
  readonly release: () => void;
}

/**
 * Deterministic weighted round-robin over a profile's `subagent.pools`
 * entries. The session holds one instance per pooled profile for the life of
 * the session, so rotation state (`currentWeight`) and per-route concurrency
 * (`active`) persist across every spawn in the session.
 *
 * Uses the smooth weighted round-robin algorithm (as used by nginx
 * upstreams): each `acquire()` adds every currently-available route's
 * weight to its running total, picks the highest, then subtracts the sum of
 * available weights from it. This keeps selection frequency proportional to
 * `weight` even as routes drop in and out of availability because of
 * `maxConcurrency`.
 */
export class SubagentRoutePool {
  private readonly entries: Array<{
    readonly route: SubagentPoolRoute;
    currentWeight: number;
    active: number;
  }>;
  private readonly waiters: Array<{
    readonly resolve: (acquired: AcquiredSubagentRoute) => void;
    readonly reject: (error: unknown) => void;
    readonly cleanup: () => void;
  }> = [];

  constructor(routes: readonly SubagentRoutePoolRoute[]) {
    if (routes.length === 0) {
      throw new Error('Subagent route pool requires at least one route entry.');
    }
    this.entries = routes.map((route) => ({ route, currentWeight: 0, active: 0 }));
  }

  /**
   * Picks the next route among entries under their `maxConcurrency` cap.
   * Throws when every route is saturated. The caller must invoke the
   * returned `release()` exactly once, after the spawn settles (completion,
   * failure, or abort) — never on every attempt, only the terminal one.
   */
  acquire(): AcquiredSubagentRoute {
    const acquired = this.tryAcquire();
    if (acquired === null) {
      throw new Error(
        'Subagent route pool is exhausted: every route is at its max_concurrency limit.',
      );
    }
    return acquired;
  }

  /**
   * Queuing variant of `acquire` for spawn paths: waits FIFO until a route
   * frees up instead of throwing, so concurrent spawns behind a saturated
   * pool line up rather than fail. Rejects with the abort reason when
   * `signal` fires while queued.
   */
  acquireQueued(signal?: AbortSignal): Promise<AcquiredSubagentRoute> {
    const immediate = this.tryAcquire();
    if (immediate !== null) return Promise.resolve(immediate);
    if (signal?.aborted === true) return Promise.reject(signal.reason as unknown);
    return new Promise<AcquiredSubagentRoute>((resolvePromise, rejectPromise) => {
      const waiter = {
        resolve: resolvePromise,
        reject: rejectPromise,
        cleanup: () => {},
      };
      if (signal !== undefined) {
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          rejectPromise(signal.reason as unknown);
        };
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private tryAcquire(): AcquiredSubagentRoute | null {
    const available = this.entries.filter(
      (entry) =>
        entry.route.maxConcurrency === undefined || entry.active < entry.route.maxConcurrency,
    );
    if (available.length === 0) return null;

    const totalWeight = available.reduce((sum, entry) => sum + (entry.route.weight ?? 1), 0);
    let picked = available[0]!;
    for (const entry of available) {
      entry.currentWeight += entry.route.weight ?? 1;
      if (entry.currentWeight > picked.currentWeight) picked = entry;
    }
    picked.currentWeight -= totalWeight;
    picked.active += 1;

    let released = false;
    return {
      route: picked.route,
      release: () => {
        if (released) return;
        released = true;
        picked.active -= 1;
        this.drainWaiters();
      },
    };
  }

  private drainWaiters(): void {
    while (this.waiters.length > 0) {
      const acquired = this.tryAcquire();
      if (acquired === null) return;
      const waiter = this.waiters.shift()!;
      waiter.cleanup();
      waiter.resolve(acquired);
    }
  }
}

/** Local alias so the constructor signature reads cleanly. */
type SubagentRoutePoolRoute = SubagentPoolRoute;
