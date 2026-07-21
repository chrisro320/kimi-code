import type { AgoraMode, AgoraPhase } from './types';

/** Durable bridge from an Agora planning session to a fresh implementation session. */
export interface AgoraSessionHandoff {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly mode: AgoraMode;
  readonly sourceSessionId: string;
  readonly targetTask: string;
  readonly originTask?: string;
  readonly originDisposition: 'resumed' | 'supersedes' | 'extends' | 'corrects' | 'new';
  readonly phase: Extract<AgoraPhase, 'fresh_session_pending' | 'resolved_to_origin' | 'resolved_to_successor'>;
  readonly artifactPaths: readonly string[];
  readonly artifactRevisions: Readonly<Record<string, string>>;
  readonly implementationResumeAnchor: string;
  readonly validationState: 'confirmed' | 'pending' | 'unresolved';
  readonly worktreeWarning?: string;
  readonly sourceSessionLineage: readonly string[];
  readonly createdAt: string;
  readonly targetSessionId?: string;
}

export function createAgoraSessionHandoff(input: Omit<AgoraSessionHandoff, 'schemaVersion' | 'createdAt'> & {
  readonly createdAt?: string;
}): AgoraSessionHandoff {
  return {
    schemaVersion: 1,
    ...input,
    createdAt: input.createdAt ?? new Date().toISOString(),
    artifactPaths: [...input.artifactPaths],
    sourceSessionLineage: [...input.sourceSessionLineage],
    artifactRevisions: { ...input.artifactRevisions },
  };
}

export function bindAgoraSessionHandoff(
  handoff: AgoraSessionHandoff,
  targetSessionId: string,
): AgoraSessionHandoff {
  if (handoff.phase !== 'fresh_session_pending') {
    throw new Error(`Cannot bind a handoff from phase "${handoff.phase}".`);
  }
  if (targetSessionId.trim().length === 0) {
    throw new Error('Agora handoff requires a target session id.');
  }
  return { ...handoff, targetSessionId };
}
