import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareAgoraHandoff } from '#/tui/agora-handoff';

const tempDirs: string[] = [];

async function fixture(): Promise<{ root: string; handoffPath: string; implementPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-agora-handoff-'));
  tempDirs.push(root);
  const taskDir = join(root, '.trellis', 'tasks', 'target');
  await mkdir(taskDir, { recursive: true });
  const implementPath = join(taskDir, 'implement.md');
  const implement = [
    '# Implementation',
    '',
    '## RESUME',
    '',
    'Phase 2 / step 1',
    '',
    '- [x] Preserve prior work',
    '- [ ] Implement the coherent correction',
    '- [ ] Run acceptance checks',
    '',
  ].join('\n');
  await writeFile(implementPath, implement, 'utf8');
  const artifactRef = relative(root, implementPath).split('\\').join('/');
  const handoffPath = join(taskDir, 'agora-handoff.json');
  // Durable run record proving a real Agora convergence — the handoff
  // verifies this exists and matches before starting a fresh session.
  await writeFile(
    join(taskDir, 'agora-run.json'),
    `${JSON.stringify({
      run_id: 'run-1',
      peers: [{ peer: 'claude', status: 'completed' }],
    }, null, 2)}
`,
    'utf8',
  );
  await writeFile(
    handoffPath,
    `${JSON.stringify({
      schemaVersion: 1,
      runId: 'run-1',
      mode: 'acceptance',
      sourceSessionId: 'source-session',
      targetTask: '.trellis/tasks/target',
      originDisposition: 'corrects',
      phase: 'fresh_session_pending',
      artifactPaths: [artifactRef],
      artifactRevisions: {
        [artifactRef]: `sha256:${createHash('sha256').update(implement).digest('hex')}`,
      },
      implementationResumeAnchor: 'Phase 2 / step 1',
      validationState: 'confirmed',
      sourceSessionLineage: ['source-session'],
      createdAt: '2026-07-19T00:00:00Z',
      transition: 'fresh_session_pending',
    }, null, 2)}\n`,
    'utf8',
  );
  return { root, handoffPath, implementPath };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function typedProof(handoffPath: string) {
  return {
    runId: 'run-1',
    sourceSessionId: 'source-session',
    targetTask: '.trellis/tasks/target',
    digest: createHash('sha256').update(await readFile(handoffPath)).digest('hex'),
  } as const;
}

describe('Agora fresh-session handoff', () => {
  it('validates typed identity, revisions, and rebuilds todos without transcript state', async () => {
    const { root, handoffPath } = await fixture();
    const prepared = await prepareAgoraHandoff(handoffPath, root, await typedProof(handoffPath));

    expect(prepared.handoff.targetTask).toBe('.trellis/tasks/target');
    expect(prepared.todos).toEqual([
      { title: 'Preserve prior work', status: 'done' },
      { title: 'Implement the coherent correction', status: 'in_progress' },
      { title: 'Run acceptance checks', status: 'pending' },
    ]);
  });

  it('rejects changed artifacts, changed handoff bytes, and paths outside the workspace', async () => {
    const { root, handoffPath, implementPath } = await fixture();
    const proof = await typedProof(handoffPath);
    await writeFile(implementPath, '# changed\n', 'utf8');
    await expect(prepareAgoraHandoff(handoffPath, root, proof)).rejects.toThrow('revision mismatch');
    await writeFile(handoffPath, '{}\n', 'utf8');
    await expect(prepareAgoraHandoff(handoffPath, root, proof)).rejects.toThrow('digest does not match');
    await expect(prepareAgoraHandoff(join(root, '..', 'outside.json'), root, proof)).rejects.toThrow(
      'outside the workspace',
    );
  });
});
