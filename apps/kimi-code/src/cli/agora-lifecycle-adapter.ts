import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import type { KimiHarnessOptions } from '@moonshot-ai/kimi-code-sdk';

type AgoraCliLifecycleAdapter = NonNullable<KimiHarnessOptions['agoraLifecycleAdapter']>;
type AgoraAdapterTransitionInput = Parameters<AgoraCliLifecycleAdapter['insert']>[0];
type AgoraAdapterInsertResult = Awaited<ReturnType<AgoraCliLifecycleAdapter['insert']>>;
type AgoraAdapterCancelInput = Parameters<AgoraCliLifecycleAdapter['cancel']>[0];
type AgoraAdapterCancelResult = Awaited<ReturnType<AgoraCliLifecycleAdapter['cancel']>>;
type AgoraAdapterMaterializeInput = Parameters<AgoraCliLifecycleAdapter['materialize']>[0];
type AgoraAdapterMaterializeResult = Awaited<ReturnType<AgoraCliLifecycleAdapter['materialize']>>;

const PROCESS_OUTPUT_LIMIT = 64 * 1024;

export interface AgoraLifecycleAdapterOptions {
  readonly workDir: string;
}

function resolveTaskScript(workDir: string): string | undefined {
  try {
    const root = realpathSync(workDir);
    const scriptPath = join(root, '.trellis', 'scripts', 'task.py');
    if (!existsSync(scriptPath)) return undefined;
    const realScriptPath = realpathSync(scriptPath);
    return relative(root, realScriptPath) === '.trellis/scripts/task.py' ? realScriptPath : undefined;
  } catch {
    return undefined;
  }
}

function canonicalTaskRef(value: string, workDir: string): string | undefined {
  if (value.length === 0 || value !== value.trim() || value.includes('\n') || value.includes('\r')) {
    return undefined;
  }
  if (value.startsWith('/') || value.includes('\\')) return undefined;
  const root = realpathSync(workDir);
  const candidate = resolve(root, value);
  const rel = relative(root, candidate).split('\\').join('/');
  if (rel.length === 0 || rel === '..' || rel.startsWith('../')) return undefined;
  if (!rel.startsWith('.trellis/tasks/') || rel === '.trellis/tasks/' || rel !== value) return undefined;
  try {
    const realCandidate = realpathSync(candidate);
    const realRel = relative(root, realCandidate).split('\\').join('/');
    return realRel === rel ? rel : undefined;
  } catch {
    return undefined;
  }
}

function canonicalHandoffRef(value: string, targetTask: string, workDir: string): string | undefined {
  if (value !== `${targetTask}/agora-handoff.json`) return undefined;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\n') || value.includes('\r')) return undefined;
  try {
    const root = realpathSync(workDir);
    const candidate = realpathSync(resolve(root, value));
    const rel = relative(root, candidate).split('\\').join('/');
    return rel === value ? rel : undefined;
  } catch {
    return undefined;
  }
}

function outputLines(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function parseTaskRefOutput(stdout: string, workDir: string): string | undefined {
  const lines = outputLines(stdout);
  if (lines.length !== 1) return undefined;
  return canonicalTaskRef(lines[0] ?? '', workDir);
}

function unprivilegedChildEnvironment(): NodeJS.ProcessEnv {
  const {
    TRELLIS_AGORA_HOST_AUTH: _hostAuth,
    TRELLIS_AGORA_HOST_REQUEST_FD: _hostRequestFd,
    ...env
  } = process.env;
  return env;
}

function collectProcessOutput(
  scriptPath: string,
  workDir: string,
  argv: readonly string[],
  options: { readonly environment?: NodeJS.ProcessEnv; readonly requestEnvelope?: object } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('python3', [scriptPath, ...argv], {
      cwd: workDir,
      env: options.environment ?? unprivilegedChildEnvironment(),
      shell: false,
      stdio: options.requestEnvelope === undefined
        ? ['ignore', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let outputOverflow = false;

    const capture = (chunks: Buffer[], kind: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (kind === 'stdout') stdoutSize += data.length;
      else stderrSize += data.length;
      if (stdoutSize > PROCESS_OUTPUT_LIMIT || stderrSize > PROCESS_OUTPUT_LIMIT) {
        outputOverflow = true;
        child.kill();
        return;
      }
      chunks.push(data);
    };

    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (childStdout === null || childStderr === null) {
      child.kill();
      reject(new Error('Could not capture Trellis task.py output.'));
      return;
    }
    childStdout.on('data', capture(stdout, 'stdout'));
    childStderr.on('data', capture(stderr, 'stderr'));
    child.once('error', reject);
    child.once('close', (code) => {
      if (outputOverflow) {
        reject(new Error('Trellis task.py output exceeded the safe 64 KiB limit.'));
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new Error(stderrText.trim() || `Trellis task.py exited with code ${String(code)}.`));
        return;
      }
      resolvePromise({ stdout: stdoutText, stderr: stderrText });
    });

    if (options.requestEnvelope !== undefined) {
      const requestPipe = child.stdio[3];
      if (requestPipe === undefined || requestPipe === null || typeof requestPipe === 'number' || !('end' in requestPipe)) {
        child.kill();
        reject(new Error('Could not open the private Agora host request pipe.'));
        return;
      }
      requestPipe.on('error', (error: NodeJS.ErrnoException) => {
        // The child may fail validation and close FD3 before consuming the
        // envelope. Its exit code/stderr remains authoritative.
        if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') reject(error);
      });
      requestPipe.end(JSON.stringify(options.requestEnvelope));
    }
  });
}

async function runTaskPy(
  scriptPath: string,
  workDir: string,
  argv: readonly string[],
): Promise<{ readonly stdout: string }> {
  const { stdout } = await collectProcessOutput(scriptPath, workDir, argv);
  return { stdout };
}

async function resolveAgoraInsertOrigin(workDir: string, scriptPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await runTaskPy(scriptPath, workDir, ['current']);
    return parseTaskRefOutput(stdout, workDir);
  } catch {
    return undefined;
  }
}

function validateTransitionIdentity(input: AgoraAdapterTransitionInput, operation: 'insert' | 'cancel'): string | undefined {
  if (input.operation !== operation) return `Agora adapter expected a typed ${operation} operation.`;
  if (input.runId.trim().length === 0 || input.sourceSessionId.trim().length === 0 || input.transitionId.trim().length === 0) {
    return 'Agora adapter transition identity cannot be empty.';
  }
  if (input.reconcile !== true) return 'Agora adapter transition must be reconciled.';
  return undefined;
}

function buildRunRecord(input: AgoraAdapterMaterializeInput): object {
  return {
    schema_version: 1,
    run_id: input.run.runId,
    phase: input.run.phase,
    packet_revision: input.run.packetRevision,
    packet: input.run.packet,
    inserted_task: input.run.insertedTask,
    origin_task: input.run.originTask,
    necessity: input.run.necessity,
    routes: input.run.routes,
    peers: input.run.peers.map((peer) => ({
      peer: peer.peer,
      backend: peer.backend,
      model: peer.model,
      status: peer.status,
      raw_response: peer.repairRawResponse ?? peer.initialRawResponse,
      normalized_response: peer.normalizedResponse,
      error: peer.error,
      repair_count: peer.repairCount,
    })),
    temporary_overrides: input.run.temporaryOverrides,
    host_route: input.run.hostRoute,
    route_upgrade: input.run.routeUpgrade,
    host_recovery_result: input.run.hostRecoveryResult,
    terminal_state: input.run.terminalState,
    decision_brief: input.proposal.decisionBrief,
    peer_evidence: input.proposal.peerEvidence,
    run_evidence: input.proposal.runEvidence,
    proposal_hash: input.proposalHash,
    proposal_revision: input.proposal.revision,
    confirmation: {
      state: input.confirmation.state,
      confirmed_by: input.confirmation.confirmedBy,
      consumed_by: input.confirmation.consumedBy,
    },
  };
}

function buildMaterialization(input: AgoraAdapterMaterializeInput): object {
  const successor = input.proposal.disposition.kind === 'successor' ? input.proposal.disposition : undefined;
  return {
    schema_version: 1,
    run_id: input.runId,
    mode: input.proposal.mode,
    acceptance_state: input.proposal.acceptance.state,
    validation_state: input.proposal.validation.state,
    acceptance_criteria: input.proposal.acceptance.criteria,
    validation_commands: input.proposal.validation.commands,
    prd: input.proposal.prd,
    design: input.proposal.design,
    implement: input.proposal.implement,
    resume_anchor: input.proposal.resumeAnchor,
    disposition: input.proposal.disposition.kind,
    relation: successor?.relation,
    title: successor?.title,
    slug: successor?.slug,
    description: successor?.description,
    curated_context: input.proposal.curatedContext === undefined ? undefined : {
      'implement.jsonl': input.proposal.curatedContext.implement,
      'check.jsonl': input.proposal.curatedContext.check,
    },
    proposal_hash: input.proposalHash,
    proposal_revision: input.proposal.revision,
  };
}

function validateMaterializationInput(input: AgoraAdapterMaterializeInput, workDir: string): string | undefined {
  if (
    input.runId.trim().length === 0
    || input.transitionId.trim().length === 0
    || input.sourceSessionId.trim().length === 0
  ) return 'Agora materialization identity cannot be empty.';
  if (
    input.lifecycle.runId !== input.runId
    || input.lifecycle.sourceSessionId !== input.sourceSessionId
    || input.run.runId !== input.runId
    || input.confirmation.runId !== input.runId
    || input.confirmation.sourceSessionId !== input.sourceSessionId
  ) return 'Agora materialization run/session provenance does not match.';
  if (!input.sourceSessionLineage.includes(input.sourceSessionId)) {
    return 'Agora materialization lineage does not include the source session.';
  }
  if (
    input.lifecycle.phase !== 'task_materialization'
    && input.lifecycle.phase !== 'materialization_executing'
    && input.lifecycle.phase !== 'fresh_session_pending'
  ) return 'Agora lifecycle is not in a materializable phase.';
  if (
    (input.confirmation.state !== 'confirmed' && input.confirmation.state !== 'consumed')
    || (input.confirmation.state === 'consumed' && input.confirmation.consumedBy !== input.transitionId)
    || input.confirmation.proposalRevision !== input.proposal.revision
    || input.confirmation.proposalHash !== input.proposalHash
    || input.confirmation.runPacketRevision !== input.run.packetRevision
  ) return 'Agora materialization confirmation is stale or was not consumed by this transition.';
  if (!/^[0-9a-f]{64}$/.test(input.proposalHash)) return 'Agora proposal hash is not canonical.';
  if (
    input.provenance.runPacketRevision !== input.run.packetRevision
    || input.provenance.insertedTask !== input.lifecycle.insertedTask
    || input.provenance.insertedTask !== input.run.insertedTask
    || input.provenance.originTask !== input.lifecycle.originTask
    || input.provenance.originTask !== input.run.originTask
    || input.provenance.targetTask !== input.lifecycle.targetTask
  ) return 'Agora materialization durable task provenance does not match.';
  if (canonicalTaskRef(input.provenance.insertedTask, workDir) === undefined) {
    return 'Agora materialization insertedTask is not a canonical in-workDir task path.';
  }
  for (const task of [input.provenance.originTask, input.provenance.targetTask]) {
    if (task !== undefined && canonicalTaskRef(task, workDir) === undefined) {
      return 'Agora materialization contains a non-canonical durable task path.';
    }
  }
  return undefined;
}

export function createAgoraLifecycleAdapter(
  options: AgoraLifecycleAdapterOptions,
): AgoraCliLifecycleAdapter {
  const { workDir } = options;

  async function insert(input: AgoraAdapterTransitionInput): Promise<AgoraAdapterInsertResult> {
    const identityError = validateTransitionIdentity(input, 'insert');
    if (identityError !== undefined) return { success: false, error: identityError };
    const scriptPath = resolveTaskScript(workDir);
    if (scriptPath === undefined) {
      return { success: false, error: 'Trellis task.py not found at the canonical workDir path.' };
    }
    const originTask = await resolveAgoraInsertOrigin(workDir, scriptPath);
    const argv = [
      'agora-insert',
      '--run-id',
      input.runId,
      ...(originTask === undefined ? [] : ['--origin', originTask]),
      ...(input.insert?.title === undefined ? [] : ['--title', input.insert.title]),
      ...(input.insert?.slug === undefined ? [] : ['--slug', input.insert.slug]),
    ];
    try {
      const { stdout } = await runTaskPy(scriptPath, workDir, argv);
      const insertedTask = parseTaskRefOutput(stdout, workDir);
      if (insertedTask === undefined) {
        return {
          success: false,
          error: 'agora-insert produced an invalid canonical task path (expected exactly one .trellis/tasks/... line).',
        };
      }
      return { success: true, insertedTask, originTask };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function cancel(input: AgoraAdapterCancelInput): Promise<AgoraAdapterCancelResult> {
    const identityError = validateTransitionIdentity(input, 'cancel');
    if (identityError !== undefined) return { success: false, error: identityError };
    if (input.lifecycle.runId !== input.runId || input.lifecycle.sourceSessionId !== input.sourceSessionId) {
      return { success: false, error: 'Agora lifecycle snapshot does not match the transition run/session.' };
    }
    const insertedTask = input.lifecycle.insertedTask;
    if (insertedTask === undefined || insertedTask.length === 0) {
      return { success: true, terminalState: 'cancelled' };
    }
    if (canonicalTaskRef(insertedTask, workDir) === undefined) {
      return { success: false, error: 'Agora lifecycle insertedTask is not a canonical in-workDir task path.' };
    }
    const scriptPath = resolveTaskScript(workDir);
    if (scriptPath === undefined) {
      return { success: false, error: 'Trellis task.py not found at the canonical workDir path.' };
    }
    try {
      const { stdout } = await runTaskPy(scriptPath, workDir, ['agora-cancel', insertedTask]);
      if (input.lifecycle.originTask === undefined) {
        if (stdout !== '(none)\n') {
          return { success: false, error: 'agora-cancel produced unexpected stdout for a run without an origin.' };
        }
      } else if (parseTaskRefOutput(stdout, workDir) !== input.lifecycle.originTask) {
        return { success: false, error: 'agora-cancel produced an unexpected restored task path.' };
      }
      return { success: true, terminalState: 'cancelled' };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function materialize(input: AgoraAdapterMaterializeInput): Promise<AgoraAdapterMaterializeResult> {
    const validationError = validateMaterializationInput(input, workDir);
    if (validationError !== undefined) return { success: false, error: validationError, mutationCommitted: false };
    const scriptPath = resolveTaskScript(workDir);
    if (scriptPath === undefined) {
      return { success: false, error: 'Trellis task.py not found at the canonical workDir path.', mutationCommitted: false };
    }

    const root = realpathSync(workDir);
    let tempDir: string | undefined;
    try {
      tempDir = await mkdtemp(join(root, '.trellis', '.agora-materialize-'));
      const inputPath = join(tempDir, 'proposal.json');
      await writeFile(inputPath, `${JSON.stringify(buildMaterialization(input))}\n`, { encoding: 'utf8', mode: 0o600 });

      const hostCapability = randomBytes(32).toString('hex');
      const requestEnvelope = {
        schema_version: 1,
        operation: 'materialize',
        transition_id: input.transitionId,
        host_capability: hostCapability,
        run_record: buildRunRecord(input),
        source_session_id: input.sourceSessionId,
        source_session_lineage: [...input.sourceSessionLineage],
      };
      const environment = {
        ...unprivilegedChildEnvironment(),
        TRELLIS_AGORA_HOST_AUTH: hostCapability,
        TRELLIS_AGORA_HOST_REQUEST_FD: '3',
      };
      const { stdout } = await collectProcessOutput(
        scriptPath,
        workDir,
        ['agora-materialize', input.provenance.insertedTask, '--input', inputPath],
        { environment, requestEnvelope },
      );
      const lines = outputLines(stdout);
      if (lines.length !== 2) {
        return { success: false, error: 'agora-materialize produced an invalid two-line handoff response.' };
      }
      const targetTask = canonicalTaskRef(lines[0] ?? '', workDir);
      if (targetTask === undefined) {
        return { success: false, error: 'agora-materialize produced a non-canonical target task path.' };
      }
      const handoffPath = canonicalHandoffRef(lines[1] ?? '', targetTask, workDir);
      if (handoffPath === undefined) {
        return { success: false, error: 'agora-materialize produced a non-canonical handoff path.' };
      }
      const digest = createHash('sha256').update(await readFile(join(root, handoffPath))).digest('hex');
      return {
        success: true,
        handoff: {
          runId: input.runId,
          sourceSessionId: input.sourceSessionId,
          targetTask,
          handoffPath,
          phase: 'fresh_session_pending',
          digest,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
    }
  }

  return { insert, cancel, materialize };
}
