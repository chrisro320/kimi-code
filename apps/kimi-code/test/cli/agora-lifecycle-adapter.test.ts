import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAgoraLifecycleAdapter } from '#/cli/agora-lifecycle-adapter';

const STUB_TASK_PY = `
import json
import os
import pathlib
import sys

root = pathlib.Path.cwd()
argv = sys.argv[1:]
if not argv:
    sys.exit(64)

cmd = argv[0]
if cmd == 'current':
    print('.trellis/tasks/origin')
    sys.exit(0)

if cmd == 'agora-insert':
    if os.environ.get('TRELLIS_AGORA_HOST_AUTH') or os.environ.get('TRELLIS_AGORA_HOST_REQUEST_FD'):
        print('Error: host secret leaked into unprivileged child', file=sys.stderr)
        sys.exit(3)
    observed = {'argv': argv}
    (root / '.trellis' / 'insert-observed.json').write_text(json.dumps(observed), encoding='utf-8')
    print('.trellis/tasks/agora-review')
    sys.exit(0)

if cmd == 'agora-cancel':
    if os.environ.get('TRELLIS_AGORA_HOST_AUTH') or os.environ.get('TRELLIS_AGORA_HOST_REQUEST_FD'):
        print('Error: host secret leaked into unprivileged child', file=sys.stderr)
        sys.exit(3)
    print('.trellis/tasks/origin')
    sys.exit(0)

if cmd == 'agora-materialize':
    auth = os.environ.get('TRELLIS_AGORA_HOST_AUTH')
    fd = int(os.environ.get('TRELLIS_AGORA_HOST_REQUEST_FD', '-1'))
    envelope = json.loads(os.read(fd, 1024 * 1024).decode('utf-8'))
    input_path = pathlib.Path(argv[argv.index('--input') + 1])
    caller = json.loads(input_path.read_text(encoding='utf-8'))
    if not auth or envelope.get('host_capability') != auth:
        print('Error: private host capability mismatch', file=sys.stderr)
        sys.exit(4)
    if any(key in caller for key in ('run_record', 'source_session_id', 'source_session_lineage', 'host_capability')):
        print('Error: trusted provenance leaked into caller JSON', file=sys.stderr)
        sys.exit(5)
    observed = {
        'argv': [value if value != str(input_path) else '<temporary-input>' for value in argv],
        'caller': caller,
        'envelope': {key: value for key, value in envelope.items() if key != 'host_capability'},
        'auth_matches': envelope.get('host_capability') == auth,
        'input_mode': oct(input_path.stat().st_mode & 0o777),
    }
    (root / '.trellis' / 'materialize-observed.json').write_text(json.dumps(observed), encoding='utf-8')
    target = root / '.trellis' / 'tasks' / 'successor'
    target.mkdir(parents=True, exist_ok=True)
    (target / 'agora-handoff.json').write_text('{}\\n', encoding='utf-8')
    print('.trellis/tasks/successor')
    print('.trellis/tasks/successor/agora-handoff.json')
    sys.exit(0)

print(f'Error: unknown command {cmd}', file=sys.stderr)
sys.exit(1)
`;

const FAILING_TASK_PY = `
import sys
print('Error: broker failed safely', file=sys.stderr)
sys.exit(1)
`;

const INVALID_OUTPUT_TASK_PY = `
import sys
if sys.argv[1] == 'current':
    sys.exit(1)
print('../outside')
`;

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env['TRELLIS_AGORA_HOST_AUTH'];
  delete process.env['TRELLIS_AGORA_HOST_REQUEST_FD'];
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(script = STUB_TASK_PY): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-agora-adapter-'));
  tempDirs.push(root);
  const scriptsDir = join(root, '.trellis', 'scripts');
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(join(root, '.trellis', 'tasks', 'origin'), { recursive: true });
  await mkdir(join(root, '.trellis', 'tasks', 'agora-review'), { recursive: true });
  await writeFile(join(scriptsDir, 'task.py'), script, 'utf8');
  return root;
}

function transition(operation: 'insert' | 'cancel' = 'insert') {
  return {
    operation,
    runId: 'run-1',
    sourceSessionId: 'session-1',
    transitionId: `${operation}-1`,
    reconcile: true as const,
  };
}

function materializationInput() {
  const proposalHash = 'a'.repeat(64);
  return {
    runId: 'run-1',
    transitionId: 'materialize-1',
    sourceSessionId: 'session-1',
    sourceSessionLineage: ['session-0', 'session-1'],
    lifecycle: {
      runId: 'run-1',
      transitionId: 'ready-1',
      phase: 'materialization_executing' as const,
      sourceSessionId: 'session-1',
      originTask: '.trellis/tasks/origin',
      insertedTask: '.trellis/tasks/agora-review',
    },
    run: {
      type: 'agora.run' as const,
      runId: 'run-1',
      phase: 'converged',
      packetRevision: 3,
      packet: { exactQuestion: 'What should change?' },
      insertedTask: '.trellis/tasks/agora-review',
      originTask: '.trellis/tasks/origin',
      necessity: {
        outcome: 'allowed_on_request' as const,
        signals: {
          impactIfWrong: 'high' as const,
          uncertaintyOrDisagreement: 'high' as const,
          expectedInformationGain: 'high' as const,
          incrementalCostLatency: 'medium' as const,
        },
        explanation: 'User requested review.',
        normalWorkflowRecommendation: 'Continue normally otherwise.',
        forcedByUser: true,
      },
      routes: { claude: { backend: 'claude-code', modelOverride: 'opus-4.8' } },
      peers: [{
        peer: 'claude',
        backend: 'claude-code',
        model: 'opus-4.8',
        status: 'completed' as const,
        initialRawResponse: 'initial',
        repairRawResponse: 'repaired',
        normalizedResponse: { verdict: 'revise' },
        repairCount: 1,
      }],
      temporaryOverrides: { claude: 'disposed' as const },
      hostRoute: 'coder-ex' as const,
      routeUpgrade: 'coder_to_coder-ex' as const,
      terminalState: 'converged',
    },
    proposal: {
      revision: 2,
      disposition: {
        kind: 'successor' as const,
        relation: 'corrects' as const,
        title: 'Corrected implementation',
        slug: 'corrected-implementation',
        description: 'One coherent correction task.',
      },
      mode: 'acceptance' as const,
      prd: '# PRD',
      design: '# Design',
      implement: '# Implement\n\nResume at verified step.',
      resumeAnchor: 'Resume at verified step.',
      curatedContext: { implement: '{"kind":"context"}\n', check: '{"kind":"check"}\n' },
      acceptance: { state: 'confirmed' as const, criteria: ['Result matches the agreed design.'] },
      validation: { state: 'confirmed' as const, commands: ['pnpm test'] },
      decisionBrief: { decision: 'Replace the rejected result.', rationale: 'Peer evidence converged.', unresolved: [] },
      peerEvidence: [{ peer: 'claude', disposition: 'accepted' as const, summary: 'Confirmed the root issue.' }],
      runEvidence: ['Focused tests passed.'],
    },
    proposalHash,
    confirmation: {
      type: 'agora.materialization_confirmation' as const,
      runId: 'run-1',
      sourceSessionId: 'session-1',
      lifecycleEpoch: 'epoch-1',
      proposalRevision: 2,
      proposalHash,
      runPacketRevision: 3,
      state: 'confirmed' as const,
      confirmedBy: 'host' as const,
    },
    provenance: {
      runPacketRevision: 3,
      originTask: '.trellis/tasks/origin',
      insertedTask: '.trellis/tasks/agora-review',
    },
  };
}

describe('createAgoraLifecycleAdapter: insert', () => {
  it('derives origin and fixed argv inside the trusted adapter', async () => {
    const workDir = await fixture();
    process.env['TRELLIS_AGORA_HOST_AUTH'] = 'must-not-leak';
    process.env['TRELLIS_AGORA_HOST_REQUEST_FD'] = '99';

    const result = await createAgoraLifecycleAdapter({ workDir }).insert({
      ...transition('insert'),
      insert: { title: 'Review title', slug: 'review-title' },
    });

    expect(result).toEqual({
      success: true,
      insertedTask: '.trellis/tasks/agora-review',
      originTask: '.trellis/tasks/origin',
    });
    const observed = JSON.parse(await readFile(join(workDir, '.trellis', 'insert-observed.json'), 'utf8'));
    expect(observed.argv).toEqual([
      'agora-insert', '--run-id', 'run-1', '--origin', '.trellis/tasks/origin',
      '--title', 'Review title', '--slug', 'review-title',
    ]);
  });

  it('rejects the wrong typed operation before spawning', async () => {
    const workDir = await fixture();
    const result = await createAgoraLifecycleAdapter({ workDir }).insert(transition('cancel'));
    expect(result).toEqual({ success: false, error: 'Agora adapter expected a typed insert operation.' });
  });

  it('rejects invalid broker output and missing canonical task.py', async () => {
    const invalidRoot = await fixture(INVALID_OUTPUT_TASK_PY);
    await expect(createAgoraLifecycleAdapter({ workDir: invalidRoot }).insert(transition()))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('invalid canonical task path') });

    const missingRoot = await mkdtemp(join(tmpdir(), 'kimi-agora-adapter-missing-'));
    tempDirs.push(missingRoot);
    await expect(createAgoraLifecycleAdapter({ workDir: missingRoot }).insert(transition()))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('task.py not found') });
  });
});

describe('createAgoraLifecycleAdapter: cancel', () => {
  it('uses only durable lifecycle provenance and fixed positional argv', async () => {
    const workDir = await fixture();
    const result = await createAgoraLifecycleAdapter({ workDir }).cancel({
      ...transition('cancel'),
      lifecycle: materializationInput().lifecycle,
    });
    expect(result).toEqual({ success: true, terminalState: 'cancelled' });
  });

  it('fails closed on forged run/session or task escape', async () => {
    const workDir = await fixture();
    const adapter = createAgoraLifecycleAdapter({ workDir });
    await expect(adapter.cancel({
      ...transition('cancel'),
      lifecycle: { ...materializationInput().lifecycle, runId: 'forged' },
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining('run/session') });
    await expect(adapter.cancel({
      ...transition('cancel'),
      lifecycle: { ...materializationInput().lifecycle, insertedTask: '../outside' },
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining('not a canonical') });
  });
});

describe('createAgoraLifecycleAdapter: materialize', () => {
  it('passes trusted provenance through FD3, excludes it from caller JSON, and returns a pending handoff', async () => {
    const workDir = await fixture();
    const result = await createAgoraLifecycleAdapter({ workDir }).materialize(materializationInput());

    expect(result).toEqual({
      success: true,
      handoff: {
        runId: 'run-1',
        sourceSessionId: 'session-1',
        targetTask: '.trellis/tasks/successor',
        handoffPath: '.trellis/tasks/successor/agora-handoff.json',
        phase: 'fresh_session_pending',
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    const observed = JSON.parse(await readFile(join(workDir, '.trellis', 'materialize-observed.json'), 'utf8'));
    expect(observed.auth_matches).toBe(true);
    expect(observed.input_mode).toBe('0o600');
    expect(observed.argv).toEqual([
      'agora-materialize', '.trellis/tasks/agora-review', '--input', '<temporary-input>',
    ]);
    expect(observed.caller).not.toHaveProperty('run_record');
    expect(observed.caller).not.toHaveProperty('source_session_id');
    expect(observed.caller).not.toHaveProperty('source_session_lineage');
    expect(observed.caller).not.toHaveProperty('host_capability');
    expect(observed.caller).toMatchObject({
      run_id: 'run-1',
      proposal_hash: 'a'.repeat(64),
      disposition: 'successor',
      curated_context: {
        'implement.jsonl': '{"kind":"context"}\n',
        'check.jsonl': '{"kind":"check"}\n',
      },
    });
    expect(observed.envelope).toMatchObject({
      schema_version: 1,
      operation: 'materialize',
      transition_id: 'materialize-1',
      source_session_id: 'session-1',
      source_session_lineage: ['session-0', 'session-1'],
      run_record: {
        run_id: 'run-1',
        packet_revision: 3,
        decision_brief: { decision: 'Replace the rejected result.' },
        peers: [{
          peer: 'claude',
          backend: 'claude-code',
          raw_response: 'repaired',
          normalized_response: { verdict: 'revise' },
          repair_count: 1,
        }],
      },
    });
    expect(await readdir(join(workDir, '.trellis'))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.agora-materialize-/)]),
    );
  });

  it.each([
    ['run', (input: ReturnType<typeof materializationInput>) => ({ ...input, runId: 'forged' })],
    ['session', (input: ReturnType<typeof materializationInput>) => ({ ...input, sourceSessionId: 'forged' })],
    ['packet revision', (input: ReturnType<typeof materializationInput>) => ({
      ...input,
      provenance: { ...input.provenance, runPacketRevision: 99 },
    })],
    ['inserted task', (input: ReturnType<typeof materializationInput>) => ({
      ...input,
      provenance: { ...input.provenance, insertedTask: '../outside' },
    })],
    ['confirmation', (input: ReturnType<typeof materializationInput>) => ({
      ...input,
      confirmation: { ...input.confirmation, proposalHash: 'b'.repeat(64) },
    })],
  ])('rejects forged %s provenance before spawning', async (_name, mutate) => {
    const workDir = await fixture();
    const result = await createAgoraLifecycleAdapter({ workDir }).materialize(mutate(materializationInput()));
    expect(result.success).toBe(false);
    await expect(readFile(join(workDir, '.trellis', 'materialize-observed.json'), 'utf8')).rejects.toThrow();
  });

  it('returns a safe broker error and removes the private temporary input', async () => {
    const workDir = await fixture(FAILING_TASK_PY);
    const result = await createAgoraLifecycleAdapter({ workDir }).materialize(materializationInput());
    expect(result).toEqual({ success: false, error: 'Error: broker failed safely' });
    expect(await readdir(join(workDir, '.trellis'))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.agora-materialize-/)]),
    );
  });
});
