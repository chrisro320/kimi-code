import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { TodoItem } from './components/chrome/todo-panel';

const execFileAsync = promisify(execFile);

export interface AgoraFreshSessionHandoff {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly mode: 'planning' | 'acceptance';
  readonly sourceSessionId: string;
  readonly targetTask: string;
  readonly originTask?: string;
  readonly originDisposition: 'resumed' | 'supersedes' | 'extends' | 'corrects' | 'new';
  readonly phase: 'fresh_session_pending' | 'resolved_to_origin' | 'resolved_to_successor';
  readonly artifactPaths: readonly string[];
  readonly artifactRevisions: Readonly<Record<string, string>>;
  readonly implementationResumeAnchor: string;
  readonly validationState: 'confirmed' | 'pending' | 'unresolved';
  readonly sourceSessionLineage: readonly string[];
  readonly createdAt: string;
  readonly worktreeWarning?: string;
  readonly targetSessionId?: string;
  readonly transition?: 'fresh_session_pending' | 'fresh_session_ready' | 'stayed_by_user' | 'handoff_failed';
  readonly failure?: string;
}

export interface PreparedAgoraHandoff {
  readonly path: string;
  readonly handoff: AgoraFreshSessionHandoff;
  readonly todos: readonly TodoItem[];
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Agora handoff requires ${field}.`);
  }
}

function workspacePath(workDir: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(workDir, path);
  const workspaceRelative = relative(resolve(workDir), absolute);
  if (workspaceRelative === '..' || workspaceRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`Agora handoff path is outside the workspace: ${path}`);
  }
  return absolute;
}

function parseHandoff(raw: unknown): AgoraFreshSessionHandoff {
  if (raw === null || typeof raw !== 'object') throw new Error('Agora handoff must be a JSON object.');
  const value = raw as Record<string, unknown>;
  if (value['schemaVersion'] !== 1) throw new Error('Unsupported Agora handoff schema version.');
  for (const field of [
    'runId',
    'mode',
    'sourceSessionId',
    'targetTask',
    'originDisposition',
    'phase',
    'implementationResumeAnchor',
    'validationState',
    'createdAt',
  ]) {
    assertString(value[field], field);
  }
  if (value['phase'] !== 'fresh_session_pending') {
    throw new Error(`Agora handoff is not pending: ${JSON.stringify(value['phase'])}.`);
  }
  if (value['transition'] !== undefined && value['transition'] !== 'fresh_session_pending') {
    throw new Error(`Agora handoff transition is not pending: ${JSON.stringify(value['transition'])}.`);
  }
  if (value['validationState'] !== 'confirmed') {
    throw new Error('Agora handoff validation state is not confirmed.');
  }
  if (!Array.isArray(value['artifactPaths']) || value['artifactPaths'].length === 0) {
    throw new Error('Agora handoff requires artifact paths.');
  }
  if (
    value['artifactRevisions'] === null ||
    typeof value['artifactRevisions'] !== 'object' ||
    Array.isArray(value['artifactRevisions'])
  ) {
    throw new Error('Agora handoff requires artifact revisions.');
  }
  if (!Array.isArray(value['sourceSessionLineage'])) {
    throw new Error('Agora handoff requires source session lineage.');
  }
  return value as unknown as AgoraFreshSessionHandoff;
}

function rebuildTodos(implement: string, resumeAnchor: string): readonly TodoItem[] {
  if (!implement.includes(resumeAnchor)) {
    throw new Error(`Agora RESUME anchor was not found in implement.md: ${resumeAnchor}`);
  }
  const todos: TodoItem[] = [];
  for (const line of implement.split(/\r?\n/)) {
    const match = /^\s*-\s*\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    todos.push({
      title: match[2]!,
      status: match[1]!.toLowerCase() === 'x' ? 'done' : 'pending',
    });
  }
  const firstPending = todos.findIndex((todo) => todo.status === 'pending');
  if (firstPending >= 0) todos[firstPending] = { ...todos[firstPending]!, status: 'in_progress' };
  return todos;
}

export async function prepareAgoraHandoff(
  handoffPath: string,
  workDir: string,
  expected: {
    readonly runId: string;
    readonly sourceSessionId: string;
    readonly targetTask: string;
    readonly digest: string;
  },
): Promise<PreparedAgoraHandoff> {
  const absoluteHandoffPath = workspacePath(workDir, handoffPath);
  const handoffRef = relative(resolve(workDir), absoluteHandoffPath).split('\\').join('/');
  if (handoffRef !== `${expected.targetTask}/agora-handoff.json`) {
    throw new Error('Agora handoff path does not match the typed materialization result.');
  }
  const handoffBytes = await readFile(absoluteHandoffPath);
  const digest = createHash('sha256').update(handoffBytes).digest('hex');
  if (digest !== expected.digest) {
    throw new Error('Agora handoff digest does not match the typed materialization result.');
  }
  const handoff = parseHandoff(JSON.parse(handoffBytes.toString('utf8')) as unknown);
  if (
    handoff.runId !== expected.runId
    || handoff.sourceSessionId !== expected.sourceSessionId
    || handoff.targetTask !== expected.targetTask
  ) {
    throw new Error('Agora handoff identity does not match the typed materialization result.');
  }

  const revisions = handoff.artifactRevisions;
  let implement = '';
  for (const artifactPath of handoff.artifactPaths) {
    assertString(artifactPath, 'artifact path');
    const absoluteArtifactPath = workspacePath(workDir, artifactPath);
    const content = await readFile(absoluteArtifactPath);
    const expectedRevision = revisions[relative(resolve(workDir), absoluteArtifactPath).split('\\').join('/')];
    if (expectedRevision === undefined) throw new Error(`Agora artifact has no revision: ${artifactPath}`);
    const actual = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    if (actual !== expectedRevision) throw new Error(`Agora artifact revision mismatch: ${artifactPath}`);
    if (absoluteArtifactPath === join(resolve(workDir), handoff.targetTask, 'implement.md')) {
      implement = content.toString('utf8');
    }
  }
  if (implement.length === 0) throw new Error('Agora handoff does not reference target implement.md.');

  return {
    path: absoluteHandoffPath,
    handoff,
    todos: rebuildTodos(implement, handoff.implementationResumeAnchor),
  };
}

async function writeHandoff(path: string, handoff: AgoraFreshSessionHandoff): Promise<void> {
  const tempPath = join(dirname(path), `.${Date.now()}-${process.pid}-agora-handoff.tmp`);
  await writeFile(tempPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}

export async function markAgoraHandoffFailed(
  prepared: PreparedAgoraHandoff,
  error: unknown,
): Promise<void> {
  await writeHandoff(prepared.path, {
    ...prepared.handoff,
    transition: 'handoff_failed',
    failure: error instanceof Error ? error.message : String(error),
  });
}

export async function bindAgoraHandoff(
  prepared: PreparedAgoraHandoff,
  targetSessionId: string,
  workDir: string,
): Promise<AgoraFreshSessionHandoff> {
  assertString(targetSessionId, 'target session id');
  const taskScript = join(resolve(workDir), '.trellis', 'scripts', 'task.py');
  const bind = await execFileAsync(
    'python3',
    [taskScript, 'agora-bind-session', prepared.handoff.targetTask, '--session-id', targetSessionId],
    { cwd: workDir },
  );
  const [contextKey, boundTask] = bind.stdout.trim().split(/\r?\n/).slice(-2);
  if (contextKey === undefined || boundTask !== prepared.handoff.targetTask) {
    throw new Error('Trellis did not bind the expected Agora target task.');
  }
  const contextScript = join(resolve(workDir), '.trellis', 'scripts', 'get_context.py');
  const rehydrated = await execFileAsync('python3', [contextScript, '--json'], {
    cwd: workDir,
    env: { ...process.env, TRELLIS_CONTEXT_ID: contextKey },
  });
  const context = JSON.parse(rehydrated.stdout) as {
    currentTask?: { path?: unknown; name?: unknown } | null;
  };
  if (context === null || typeof context !== 'object') {
    throw new Error('Fresh Agora Trellis context could not be rehydrated.');
  }
  const currentTask = context.currentTask;
  const targetTask = prepared.handoff.targetTask.replace(/\\/g, '/');
  const boundPath = typeof currentTask?.path === 'string' ? currentTask.path.replace(/\\/g, '/') : '';
  const boundName = typeof currentTask?.name === 'string' ? currentTask.name : '';
  const identityMatches = boundPath.length > 0
    ? boundPath === targetTask
    : boundName === targetTask.split('/').pop();
  if (!identityMatches) {
    throw new Error(`Fresh Agora Trellis context is bound to the wrong task: ${boundPath || boundName || 'unknown'}.`);
  }
  const phase = prepared.handoff.originDisposition === 'resumed'
    ? 'resolved_to_origin'
    : 'resolved_to_successor';
  const bound: AgoraFreshSessionHandoff = {
    ...prepared.handoff,
    phase,
    targetSessionId,
    transition: 'fresh_session_ready',
  };
  await writeHandoff(prepared.path, bound);
  return bound;
}
