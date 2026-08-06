/**
 * `subagent` domain — `ISessionSubagentRoutingService` implementation.
 *
 * Owns spawn-route resolution for subagent spawns: the static
 * `[subagent.routing.<profile>]` mapping and the per-profile weighted route
 * pools declared by `[[subagent.pools.<profile>]]`. One `SubagentRoutePool`
 * per pooled profile is held for the life of the session so rotation state
 * (`currentWeight`) and per-route concurrency counts (`active`) persist
 * across every spawn — rebuilding the pool per spawn would degenerate the
 * weighted round-robin into "always the heaviest route" and make
 * `max_concurrency` untestable. Pool slots are acquired here and released by
 * the spawn caller once the spawn reaches a terminal state (completion,
 * failure, or abort). When neither pool nor routing hits, resolution returns
 * `undefined` and the caller falls back to its existing binding path
 * unchanged. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';

import {
  SUBAGENT_SECTION,
  type SubagentConfig,
  type SubagentPoolRoute,
} from './configSection';
import {
  resolveRouteByNames,
  resolveSubagentRoute,
  SubagentRoutePool,
  type ResolvedSubagentRoute,
} from './routing';

export interface ResolvedSpawnRoute {
  readonly route: ResolvedSubagentRoute;
  /**
   * Pool-slot release; present only when the route came out of a route pool.
   * Idempotent; the spawn caller invokes it exactly once, after the spawn
   * settles (completion, failure, or abort) — never on every attempt.
   */
  readonly releasePoolSlot?: () => void;
}

export interface ISessionSubagentRoutingService {
  readonly _serviceBrand: undefined;

  /**
   * Resolves the spawn route for `profileName`: pool first (queuing behind a
   * saturated pool via `acquireQueued`), then the static routing entry, else
   * `undefined` (caller keeps its existing binding path).
   */
  resolveSpawnRoute(
    profileName: string,
    signal?: AbortSignal,
  ): Promise<ResolvedSpawnRoute | undefined>;
}

export const ISessionSubagentRoutingService: ServiceIdentifier<ISessionSubagentRoutingService> =
  createDecorator<ISessionSubagentRoutingService>('sessionSubagentRoutingService');

export class SessionSubagentRoutingService implements ISessionSubagentRoutingService {
  declare readonly _serviceBrand: undefined;

  private readonly routePools = new Map<string, SubagentRoutePool>();

  constructor(@IConfigService private readonly config: IConfigService) {}

  async resolveSpawnRoute(
    profileName: string,
    signal?: AbortSignal,
  ): Promise<ResolvedSpawnRoute | undefined> {
    const subagent = this.config.get<SubagentConfig | undefined>(SUBAGENT_SECTION);
    const poolRoutes = subagent?.pools?.[profileName];
    if (poolRoutes !== undefined && poolRoutes.length > 0) {
      const pool = this.getRoutePool(profileName, poolRoutes);
      const acquired = await pool.acquireQueued(signal);
      try {
        const route = resolveRouteByNames(
          this.config,
          acquired.route.backend,
          acquired.route.model,
          acquired.route.thinkingEffort,
        );
        return { route, releasePoolSlot: acquired.release };
      } catch (error) {
        acquired.release();
        throw error;
      }
    }
    if (subagent?.routing?.[profileName] === undefined) return undefined;
    return { route: resolveSubagentRoute(this.config, profileName) };
  }

  private getRoutePool(
    profileName: string,
    routes: readonly SubagentPoolRoute[],
  ): SubagentRoutePool {
    let pool = this.routePools.get(profileName);
    if (pool === undefined) {
      pool = new SubagentRoutePool(routes);
      this.routePools.set(profileName, pool);
    }
    return pool;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentRoutingService,
  SessionSubagentRoutingService,
  ScopeActivation.OnDemand,
  'subagent',
);
