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

  it('unblocks a Read ENOENT after a successful Write creates the file', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    const args = { path: '/missing.txt' };
    fingerprint.recordIfDeterministic('Read', args, enoentResult('/missing.txt'));
    expect(fingerprint.checkFingerprint('Read', args)).not.toBeNull();

    fingerprint.invalidateOnSuccess('Write', { path: '/missing.txt' });
    expect(fingerprint.checkFingerprint('Read', args)).toBeNull();
  });

  it('keeps blocking a repeated deterministic failure when no mutation happened', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    const args = { path: '/missing.txt' };
    fingerprint.recordIfDeterministic('Read', args, enoentResult('/missing.txt'));

    fingerprint.invalidateOnSuccess('Read', { path: '/missing.txt' });
    expect(fingerprint.checkFingerprint('Read', args)).not.toBeNull();
  });

  it('does not invalidate failures on unrelated paths', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    const args = { path: '/b.txt' };
    fingerprint.recordIfDeterministic('Read', args, enoentResult('/b.txt'));

    fingerprint.invalidateOnSuccess('Write', { path: '/a.txt' });
    expect(fingerprint.checkFingerprint('Read', args)).not.toBeNull();
  });

  it('clears all records after a successful Bash call', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    const readArgs = { path: '/missing.txt' };
    const editArgs = { path: '/dir-not-file' };
    fingerprint.recordIfDeterministic('Read', readArgs, enoentResult('/missing.txt'));
    fingerprint.recordIfDeterministic('Edit', editArgs, eisdirResult('/dir-not-file'));

    fingerprint.invalidateOnSuccess('Bash', { command: 'mkdir -p /missing-dir' });
    expect(fingerprint.checkFingerprint('Read', readArgs)).toBeNull();
    expect(fingerprint.checkFingerprint('Edit', editArgs)).toBeNull();
  });

  it('normalizes ./-prefixed and plain relative paths to the same record', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    const recorded = { path: './src/new.ts' };
    fingerprint.recordIfDeterministic('Read', recorded, enoentResult('./src/new.ts'));

    fingerprint.invalidateOnSuccess('Write', { path: 'src/new.ts' });
    expect(fingerprint.checkFingerprint('Read', recorded)).toBeNull();
  });

  it('invalidates an ancestor-path failure when a mutation creates the missing directory', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    const args = { path: '/a/b' };
    fingerprint.recordIfDeterministic('Read', args, enoentResult('/a/b'));

    fingerprint.invalidateOnSuccess('Write', { path: '/a/b/c.ts' });
    expect(fingerprint.checkFingerprint('Read', args)).toBeNull();
  });

  it('invalidates a deeper-path failure when the mutation target is an ancestor of it', () => {
    const fingerprint = new DeterministicFailureFingerprint();
    const args = { path: '/a/b/c.ts' };
    fingerprint.recordIfDeterministic('Read', args, enoentResult('/a/b/c.ts'));

    fingerprint.invalidateOnSuccess('Write', { path: '/a/b' });
    expect(fingerprint.checkFingerprint('Read', args)).toBeNull();
  });
});
