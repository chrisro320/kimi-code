import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareAgoraHandoff } from '#/tui/agora-handoff';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; handoffPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-agora-adv-'));
  tempDirs.push(root);
  const taskDir = join(root, '.trellis', 'tasks', 'target');
  await mkdir(taskDir, { recursive: true });
  const implementPath = join(taskDir, 'implement.md');
  const implement = ['# Implementation', '', '## RESUME', '', 'Phase 1', '', '- [ ] Do work', ''].join('\n');
  await writeFile(implementPath, implement, 'utf8');
  const artifactRef = relative(root, implementPath).split('\\').join('/');
  const handoffPath = join(taskDir, 'agora-handoff.json');
  await writeFile(
    handoffPath,
    `${JSON.stringify({
      schemaVersion: 1,
      runId: 'run-1',
      mode: 'acceptance',
      sourceSessionId: 'source',
      targetTask: '.trellis/tasks/target',
      originDisposition: 'corrects',
      phase: 'fresh_session_pending',
      artifactPaths: [artifactRef],
      artifactRevisions: {
        [artifactRef]: `sha256:${createHash('sha256').update(implement).digest('hex')}`,
      },
      implementationResumeAnchor: 'Phase 1',
      validationState: 'confirmed',
      sourceSessionLineage: ['source'],
      createdAt: '2026-07-20T00:00:00Z',
      transition: 'fresh_session_pending',
    }, null, 2)}\n`,
    'utf8',
  );
  return { root, handoffPath };
}

async function proof(handoffPath: string) {
  return {
    runId: 'run-1',
    sourceSessionId: 'source',
    targetTask: '.trellis/tasks/target',
    digest: createHash('sha256').update(await readFile(handoffPath)).digest('hex'),
  } as const;
}

describe('Agora handoff typed materialization proof', () => {
  it('accepts the handoff only when the typed result matches its identity and digest', async () => {
    const { root, handoffPath } = await fixture();
    const prepared = await prepareAgoraHandoff(handoffPath, root, await proof(handoffPath));
    expect(prepared.handoff.runId).toBe('run-1');
  });

  it('rejects workspace JSON whose identity does not match the typed materialization result', async () => {
    const { root, handoffPath } = await fixture();
    await expect(prepareAgoraHandoff(handoffPath, root, {
      ...(await proof(handoffPath)),
      runId: 'forged-run',
    })).rejects.toThrow('identity does not match');
  });

  it('rejects a valid-looking handoff at a path not named by the typed result', async () => {
    const { root, handoffPath } = await fixture();
    await expect(prepareAgoraHandoff(handoffPath, root, {
      ...(await proof(handoffPath)),
      targetTask: '.trellis/tasks/other',
    })).rejects.toThrow('path does not match');
  });
});
