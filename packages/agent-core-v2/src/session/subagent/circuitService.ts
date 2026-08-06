/**
 * `subagent` domain — `ISessionSubagentCircuitService` implementation.
 *
 * Holds the R-A2 (Case 8) dispatch circuit state: per-key records of
 * non-retryable provider/model/route failures. Independent of route pools —
 * a circuit can be open with no in-flight spawn, and outlives any single
 * dispatch. Each key tracks *every* failed route (not just the last one), so
 * a scoped fallback chain cannot overwrite the primary's entry and trick the
 * next spawn into retrying a route that already failed deterministically.
 *
 * The state is in-memory for the life of the session (v1 parity:
 * `DispatchController.circuitState` lived on the session's controller), which
 * is why this service is bound at Session scope — circuit state must persist
 * across every spawn in the session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { ErrorCode } from '#/errors';

export interface CircuitFailureRecord {
  readonly failedRoute: string;
  readonly errorCode: ErrorCode;
}

export interface ISessionSubagentCircuitService {
  readonly _serviceBrand: undefined;

  /** Record a non-retryable provider/model/route failure so future spawns skip straight to a fallback. */
  openCircuit(key: string, route: string, errorCode: ErrorCode): void;

  /** Whether `route` already failed deterministically under `key` and should not be retried as-is. */
  isCircuitOpen(key: string, route: string): boolean;

  /** The most recently recorded failure for `key`, if any — used to report a full fallback-chain failure history. */
  circuitFailure(key: string): CircuitFailureRecord | undefined;
}

export const ISessionSubagentCircuitService: ServiceIdentifier<ISessionSubagentCircuitService> =
  createDecorator<ISessionSubagentCircuitService>('sessionSubagentCircuitService');

export class SessionSubagentCircuitService implements ISessionSubagentCircuitService {
  declare readonly _serviceBrand: undefined;

  private readonly circuitState = new Map<
    string,
    Map<string, { readonly openSince: number; readonly errorCode: ErrorCode }>
  >();

  openCircuit(key: string, route: string, errorCode: ErrorCode): void {
    let routes = this.circuitState.get(key);
    if (routes === undefined) {
      routes = new Map();
      this.circuitState.set(key, routes);
    }
    // Delete-then-set moves a re-recorded route to the end so iteration order
    // reflects recency (Date.now() alone ties within the same millisecond).
    routes.delete(route);
    routes.set(route, { openSince: Date.now(), errorCode });
  }

  isCircuitOpen(key: string, route: string): boolean {
    return this.circuitState.get(key)?.has(route) ?? false;
  }

  circuitFailure(key: string): CircuitFailureRecord | undefined {
    const routes = this.circuitState.get(key);
    if (routes === undefined || routes.size === 0) return undefined;
    let latest: CircuitFailureRecord | undefined;
    for (const [failedRoute, entry] of routes) {
      latest = { failedRoute, errorCode: entry.errorCode };
    }
    return latest;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentCircuitService,
  SessionSubagentCircuitService,
  ScopeActivation.OnDemand,
  'subagent',
);
