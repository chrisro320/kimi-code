import { describe, expect, it } from 'vitest';

import type { ExecutableToolResult } from '../../../src/loop/types';
import { DeterministicFailureFingerprint } from '../../../src/agent/turn/deterministic-fingerprint';

function eisdirResult(path: string): ExecutableToolResult {
  return { output: `${path} is not a file.`, isError: true };
}

function enoentResult(path: string): ExecutableToolResult {
  return { output: `"${path}" does not exist.`, isError: true };
}

function transientResult(): ExecutableToolResult {
  return { output: 'EBUSY: resource busy or locked', isError: true };
}

function outputText(result: ExecutableToolResult | null): string {
  return typeof result?.output === 'string' ? result.output : '';
}

describe('DeterministicFailureFingerprint', () => {
  it('does not block the first occurrence of a call', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    expect(fingerprint.checkFingerprint('Edit', { path: '/a' })).toBeNull();
  });

  it('blocks a same-args repeat of a deterministic EISDIR failure without re-executing', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    const args = { path: '/dir-not-file' };
    fingerprint.recordIfDeterministic('Edit', args, eisdirResult('/dir-not-file'));

    const blocked = fingerprint.checkFingerprint('Edit', args);
    expect(blocked).not.toBeNull();
    expect(blocked?.isError).toBe(true);
    expect(outputText(blocked)).toContain('EISDIR');
    expect(outputText(blocked)).toContain('Blocked');
  });

  it('blocks a same-args repeat of a deterministic ENOENT failure on Read', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    const args = { path: '/missing.txt' };
    fingerprint.recordIfDeterministic('Read', args, enoentResult('/missing.txt'));

    const blocked = fingerprint.checkFingerprint('Read', args);
    expect(blocked).not.toBeNull();
    expect(outputText(blocked)).toContain('ENOENT');
  });

  it('does not block a call with different args, even for the same tool', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    fingerprint.recordIfDeterministic('Edit', { path: '/a' }, eisdirResult('/a'));
    expect(fingerprint.checkFingerprint('Edit', { path: '/b' })).toBeNull();
  });

  it('never records a transient failure, so a repeat is not blocked', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    const args = { command: 'flock /tmp/x' };
    fingerprint.recordIfDeterministic('Bash', args, transientResult());
    expect(fingerprint.checkFingerprint('Bash', args)).toBeNull();
  });

  it('never records a successful result', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    const args = { path: '/a' };
    fingerprint.recordIfDeterministic('Read', args, { output: 'file contents' });
    expect(fingerprint.checkFingerprint('Read', args)).toBeNull();
  });

  it('does not classify an unlisted tool as deterministic, even with matching wording', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    const args = { path: '/a' };
    fingerprint.recordIfDeterministic('SomeOtherTool', args, eisdirResult('/a'));
    expect(fingerprint.checkFingerprint('SomeOtherTool', args)).toBeNull();
  });
});
