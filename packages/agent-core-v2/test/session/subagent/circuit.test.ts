import { describe, expect, it } from 'vitest';

import { Error2, ErrorCodes } from '#/errors';
import {
  CIRCUIT_OPENING_CODES,
  circuitOpeningErrorCode,
  dispatchCircuitFallbackKey,
  logicalScopeKeyOf,
  subagentRouteIdentity,
} from '#/session/subagent/circuit';
import { SessionSubagentCircuitService } from '#/session/subagent/circuitService';

describe('dispatchCircuitFallbackKey / subagentRouteIdentity (AC4)', () => {
  it('is backend::model with an empty model segment when unset (v1 parity)', () => {
    expect(dispatchCircuitFallbackKey('kimi', 'fast')).toBe('kimi::fast');
    expect(dispatchCircuitFallbackKey('kimi', undefined)).toBe('kimi::');
  });

  it('gives two routes launching the same backend+model the same identity', () => {
    const a = subagentRouteIdentity({ kind: 'internal', modelAlias: 'fast', thinkingEffort: 'high' });
    const b = subagentRouteIdentity({
      kind: 'internal',
      modelAlias: 'fast',
      thinkingEffort: undefined,
    });
    expect(a).toBe(b);
    expect(a).toBe(dispatchCircuitFallbackKey('kimi', 'fast'));
  });

  it('distinguishes routes by model', () => {
    expect(
      subagentRouteIdentity({ kind: 'internal', modelAlias: 'fast', thinkingEffort: undefined }),
    ).not.toBe(
      subagentRouteIdentity({ kind: 'internal', modelAlias: 'precise', thinkingEffort: undefined }),
    );
  });
});

describe('logicalScopeKeyOf (v1 parity, code-unit sort)', () => {
  it('sorts entries by UTF-16 code unit and joins with |', () => {
    expect(logicalScopeKeyOf(['b', 'A', 'a'])).toBe('A|a|b');
  });

  it('trims entries and ignores empty/undefined scopes', () => {
    expect(logicalScopeKeyOf([' src ', 'docs'])).toBe('docs|src');
    expect(logicalScopeKeyOf([])).toBeUndefined();
    expect(logicalScopeKeyOf(undefined)).toBeUndefined();
  });
});

describe('circuitOpeningErrorCode', () => {
  it('opens on non-retryable provider/model/route failures', () => {
    for (const code of CIRCUIT_OPENING_CODES) {
      expect(circuitOpeningErrorCode(new Error2(code, 'boom'))).toBe(code);
    }
  });

  it('ignores transient and user-initiated failures', () => {
    expect(
      circuitOpeningErrorCode(new Error2(ErrorCodes.PROVIDER_RATE_LIMIT, 'slow down')),
    ).toBeUndefined();
    expect(
      circuitOpeningErrorCode(new Error2(ErrorCodes.PROVIDER_CONNECTION_ERROR, 'down')),
    ).toBeUndefined();
    expect(
      circuitOpeningErrorCode(new Error2(ErrorCodes.PROVIDER_OVERLOADED, 'busy')),
    ).toBeUndefined();
    expect(circuitOpeningErrorCode(new Error('plain failure'))).toBeUndefined();
    expect(circuitOpeningErrorCode(undefined)).toBeUndefined();
  });

  it('recovers the code from the serialized `[code] message` convention (v1 parity)', () => {
    expect(circuitOpeningErrorCode(new Error('[provider.auth_error] token rejected'))).toBe(
      'provider.auth_error',
    );
    expect(circuitOpeningErrorCode(new Error('[provider.rate_limit] slow down'))).toBeUndefined();
  });
});

describe('SessionSubagentCircuitService (AC3)', () => {
  it('records and queries circuit state per key and route', () => {
    const circuit = new SessionSubagentCircuitService();
    expect(circuit.isCircuitOpen('k', 'kimi::fast')).toBe(false);
    circuit.openCircuit('k', 'kimi::fast', 'provider.auth_error');
    expect(circuit.isCircuitOpen('k', 'kimi::fast')).toBe(true);
    expect(circuit.isCircuitOpen('k', 'kimi::precise')).toBe(false);
    expect(circuit.isCircuitOpen('other', 'kimi::fast')).toBe(false);
  });

  it('tracks every failed route under a key, not just the last one (219f5a807)', () => {
    const circuit = new SessionSubagentCircuitService();
    circuit.openCircuit('scope', 'kimi::fast', 'provider.auth_error');
    circuit.openCircuit('scope', 'kimi::precise', 'model.config_invalid');
    // A scoped fallback chain must not overwrite the primary's record.
    expect(circuit.isCircuitOpen('scope', 'kimi::fast')).toBe(true);
    expect(circuit.isCircuitOpen('scope', 'kimi::precise')).toBe(true);
  });

  it('circuitFailure reports the most recently recorded route', () => {
    const circuit = new SessionSubagentCircuitService();
    expect(circuit.circuitFailure('k')).toBeUndefined();
    circuit.openCircuit('k', 'kimi::fast', 'provider.auth_error');
    circuit.openCircuit('k', 'kimi::precise', 'model.config_invalid');
    expect(circuit.circuitFailure('k')).toEqual({
      failedRoute: 'kimi::precise',
      errorCode: 'model.config_invalid',
    });
    // Re-recording the older route moves it to the recency end.
    circuit.openCircuit('k', 'kimi::fast', 'provider.auth_error');
    expect(circuit.circuitFailure('k')).toEqual({
      failedRoute: 'kimi::fast',
      errorCode: 'provider.auth_error',
    });
  });
});
