/**
 * `subagent` domain — R-A2 (Case 8) dispatch circuit-breaker primitives.
 *
 * Ported from v1 (`agent/dispatch/controller.ts` circuit section +
 * `session/subagent-host.ts`): a circuit records non-retryable
 * provider/model/route failures so future spawns skip straight to the
 * user-approved fallback chain instead of retrying a route that already
 * failed deterministically. Transient failures (rate limit, connection,
 * overload) stay the retry layer's job and never open a circuit; a user
 * cancellation is not a route problem at all.
 *
 * Each key tracks *every* failed route, not just the last one (`219f5a807`):
 * a scoped fallback chain must not overwrite the primary's entry and trick
 * the next spawn into retrying a known-dead route.
 */

import { ErrorCodes, isError2, type ErrorCode } from '#/errors';

import { INTERNAL_SUBAGENT_BACKEND, type ResolvedSubagentRoute } from './routing';

/**
 * R-A2 fallback dispatch-circuit key when a spawn has no scope (and thus no
 * logical scope key) — the route identity doubles as the key.
 */
export function dispatchCircuitFallbackKey(backend: string, model: string | undefined): string {
  return `${backend}::${model ?? ''}`;
}

/**
 * Opaque per-route identity string used as the circuit-breaker key component
 * — two `ResolvedSubagentRoute`s that would launch the same backend+model
 * combination must produce the same identity regardless of `kind`.
 */
export function subagentRouteIdentity(route: ResolvedSubagentRoute): string {
  // v2 routes are internal-only for now; the switch keeps the v1 shape so
  // the external variant (B7) joins without changing call sites.
  switch (route.kind) {
    case 'internal':
      return dispatchCircuitFallbackKey(INTERNAL_SUBAGENT_BACKEND, route.modelAlias);
  }
}

/**
 * Scope-key derivation shared by the circuit key and any future escalation
 * bookkeeping. Sorted by UTF-16 code unit (default `sort()`), matching v1 —
 * never `localeCompare` (`fbc784ec0`). v2 has no dispatch-scope protocol yet
 * (D-B5C-1); this lands with the scope consumers (B6).
 */
export function logicalScopeKeyOf(scope: readonly string[] | undefined): string | undefined {
  return scope !== undefined && scope.length > 0
    ? [...scope].map((entry) => entry.trim()).sort().join('|')
    : undefined;
}

/**
 * Non-retryable provider/model/route failures — only these open the circuit
 * for the resolved route. v1 also listed `AGENT_NOT_RESUMABLE`; v2 has no
 * such code (resume rejections use `agent.not_a_subagent` / `agent.not_owned`
 * / `agent.already_running`, which are ownership/state problems, not route
 * problems) so it is deliberately absent.
 */
export const CIRCUIT_OPENING_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCodes.PROVIDER_AUTH_ERROR,
  ErrorCodes.PROVIDER_API_ERROR,
  ErrorCodes.PROVIDER_FILTERED,
  ErrorCodes.MODEL_NOT_CONFIGURED,
  ErrorCodes.MODEL_CONFIG_INVALID,
  ErrorCodes.AUTH_LOGIN_REQUIRED,
]);

/**
 * The error code that should open the circuit for `error`, or `undefined`
 * when the failure is transient/user-initiated and must not be recorded.
 */
export function circuitOpeningErrorCode(error: unknown): ErrorCode | undefined {
  if (isError2(error)) {
    return CIRCUIT_OPENING_CODES.has(error.code) ? error.code : undefined;
  }
  // A failure serialized across a boundary can arrive as a plain Error with
  // the `[code] message` convention (v1 parity) — recover the code so a real
  // route failure still opens the circuit.
  if (error instanceof Error) {
    const code = /^\[([a-z][a-z0-9_.]*)\]/.exec(error.message)?.[1] as ErrorCode | undefined;
    if (code !== undefined && CIRCUIT_OPENING_CODES.has(code)) return code;
  }
  return undefined;
}

/** Renders one fallback-chain attempt for the all-routes-open rejection message (v1 parity). */
export function circuitFailureDescription(
  identity: string,
  errorCode: ErrorCode | undefined,
): string {
  return errorCode === undefined ? identity : `${identity} (${errorCode})`;
}
