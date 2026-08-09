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
 * unchanged. Before committing to a resolved route, the service consults the
 * R-A2 circuit breaker (`ISessionSubagentCircuitService`): a route that
 * already failed non-retryably is released again and replaced by the first
 * circuit-closed entry of the user-approved `fallback_chain`; when every
 * candidate is circuit-open the spawn is rejected with the full attempt
 * history. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';

import {
  SUBAGENT_SECTION,
  type SubagentConfig,
  type SubagentPoolRoute,
} from './configSection';
import { circuitFailureDescription, subagentRouteIdentity } from './circuit';
import { ISessionSubagentCircuitService } from './circuitService';
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
  /**
   * R-A2 (Case 8) circuit key for this route. The spawn caller records
   * non-retryable provider/model/route failures under this key through
   * `ISessionSubagentCircuitService.openCircuit` so the next spawn skips
   * straight to the fallback chain.
   */
  readonly circuitKey: string;
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

  constructor(
    @IConfigService private readonly config: IConfigService,
    @ISessionSubagentCircuitService private readonly circuit: ISessionSubagentCircuitService,
  ) {}

  async resolveSpawnRoute(
    profileName: string,
    signal?: AbortSignal,
  ): Promise<ResolvedSpawnRoute | undefined> {
    const subagent = this.config.get<SubagentConfig | undefined>(SUBAGENT_SECTION);
    const resolved = await this.resolveDefault(profileName, subagent, signal);
    if (resolved === undefined) return undefined;

    // R-A2 (Case 8): before committing to the normally-resolved route, check
    // whether it already failed non-retryably. v2 has no dispatch-scope
    // protocol (D-B5C-1), so the route identity doubles as the key (v1's
    // scope-less path): a backend+model that already failed is skipped next
    // time it comes up.
    const resolvedIdentity = subagentRouteIdentity(resolved.route);
    if (!this.circuit.isCircuitOpen(resolvedIdentity, resolvedIdentity)) {
      return { ...resolved, circuitKey: resolvedIdentity };
    }
    resolved.releasePoolSlot?.();

    const chain = subagent?.fallbackChain ?? [];
    const attempts = [
      circuitFailureDescription(
        resolvedIdentity,
        this.circuit.circuitFailure(resolvedIdentity)?.errorCode,
      ),
    ];
    for (const candidate of chain) {
      const candidateRoute = resolveRouteByNames(this.config, candidate.backend, candidate.model);
      const candidateIdentity = subagentRouteIdentity(candidateRoute);
      if (!this.circuit.isCircuitOpen(candidateIdentity, candidateIdentity)) {
        return { route: candidateRoute, circuitKey: candidateIdentity };
      }
      attempts.push(
        circuitFailureDescription(
          candidateIdentity,
          this.circuit.circuitFailure(candidateIdentity)?.errorCode,
        ),
      );
    }
    throw new Error(
      `Dispatch rejected (circuit-open): every route in the fallback chain is circuit-open: ${attempts.join(' -> ')}`,
    );
  }

  private async resolveDefault(
    profileName: string,
    subagent: SubagentConfig | undefined,
    signal?: AbortSignal,
  ): Promise<Omit<ResolvedSpawnRoute, 'circuitKey'> | undefined> {
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
