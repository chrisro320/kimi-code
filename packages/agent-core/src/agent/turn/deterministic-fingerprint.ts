import type { ExecutableToolResult } from '../../loop/types';

import { canonicalTelemetryArgs } from './canonical-args';

export type DeterministicErrorCode = 'EISDIR' | 'ENOENT' | 'ENOTDIR';

interface DeterministicPattern {
  readonly code: DeterministicErrorCode;
  readonly test: (output: string) => boolean;
}

/**
 * Builtin file tools -> path-shape error patterns. `ExecutableToolResult`
 * has no structured error-code field (see loop/types.ts), so these tools'
 * ENOENT/ENOTDIR/EISDIR-equivalent conditions are recognized from their own
 * fixed, quoted-path error strings instead. Any tool not listed here, or an
 * error message that doesn't match, is treated as non-deterministic and is
 * never fingerprinted — under-detecting is safe, over-detecting would wrongly
 * block a call that could actually succeed on retry.
 */
const DETERMINISTIC_PATTERNS: Record<string, readonly DeterministicPattern[]> = {
  Read: [
    { code: 'ENOENT', test: (o) => /^".*" does not exist\.$/.test(o) },
    { code: 'EISDIR', test: (o) => /^".*" is not a file\.$/.test(o) },
  ],
  Write: [{ code: 'ENOENT', test: (o) => o.endsWith('parent directory does not exist.') }],
  Edit: [{ code: 'EISDIR', test: (o) => o.endsWith(' is not a file.') }],
  Glob: [
    { code: 'ENOENT', test: (o) => o.endsWith('does not exist') },
    { code: 'ENOTDIR', test: (o) => o.endsWith('is not a directory') },
  ],
};

function outputText(result: ExecutableToolResult): string {
  if (typeof result.output === 'string') return result.output;
  return result.output
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function classifyDeterministicError(
  toolName: string,
  result: ExecutableToolResult,
): DeterministicErrorCode | undefined {
  if (result.isError !== true) return undefined;
  const patterns = DETERMINISTIC_PATTERNS[toolName];
  if (patterns === undefined) return undefined;
  const text = outputText(result);
  for (const pattern of patterns) {
    if (pattern.test(text)) return pattern.code;
  }
  return undefined;
}

function makeKey(toolName: string, args: unknown): string {
  return `${toolName} ${canonicalTelemetryArgs(args)}`;
}

interface RecordedFailure {
  readonly code: DeterministicErrorCode;
  readonly output: string;
}

/**
 * Pre-flight guard against re-running a tool call whose (toolName, args)
 * pair already failed for a reason that cannot change between calls: the
 * filesystem shape at the given path. Complements `ToolCallDeduplicator`
 * (which only suppresses same-*step* identical re-execution but still lets
 * cross-step repeats really run); this blocks *before* execution, for the
 * lifetime of the owning Agent — not reset each turn or step.
 */
export class DeterministicFailureFingerprint {
  private readonly failures = new Map<string, RecordedFailure>();

  /**
   * Called from `prepareToolExecution`. Returns a synthetic blocked result if
   * this exact call already produced a recorded deterministic failure;
   * otherwise `null` so the normal execution path proceeds.
   */
  checkFingerprint(toolName: string, args: unknown): ExecutableToolResult | null {
    const key = makeKey(toolName, args);
    const prior = this.failures.get(key);
    if (prior === undefined) return null;
    return {
      isError: true,
      output:
        `Blocked: this exact ${toolName} call already failed with a ${prior.code} condition that ` +
        `will not change on retry (${prior.output}). Change the input instead of repeating the call.`,
    };
  }

  /**
   * Called from `finalizeToolResult`. Records the fingerprint only when the
   * result classifies as a deterministic path-shape failure; transient
   * failures (EBUSY, network errors, ...) are intentionally never recorded.
   */
  recordIfDeterministic(toolName: string, args: unknown, result: ExecutableToolResult): void {
    const code = classifyDeterministicError(toolName, result);
    if (code === undefined) return;
    this.failures.set(makeKey(toolName, args), { code, output: outputText(result) });
  }
}
