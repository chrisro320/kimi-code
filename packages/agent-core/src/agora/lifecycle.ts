import { createHash, randomBytes } from 'node:crypto';

import type { AgentRecordOf, AgentRecords } from '../agent/records';

export type AgoraLifecyclePhase =
  | 'decoupling'
  | 'packet_confirmation'
  | 'peer_review'
  | 'synthesis'
  | 'trellis_convergence'
  | 'task_materialization'
  | 'materialization_executing'
  | 'fresh_session_pending'
  | 'resolved_to_origin'
  | 'resolved_to_successor'
  | 'cancelled'
  | 'unresolved';

/** Phases in which peer dispatch is permitted. */
const DISPATCH_ALLOWED_PHASES: ReadonlySet<AgoraLifecyclePhase> = new Set([
  'packet_confirmation',
  'peer_review',
]);

export const TERMINAL_PHASES: ReadonlySet<AgoraLifecyclePhase> = new Set([
  'resolved_to_origin',
  'resolved_to_successor',
  'cancelled',
]);

/** Durable Agora lifecycle transition record (matches AgentRecordEvents['agora.lifecycle']). */
export interface AgoraLifecycleRecord {
  readonly runId: string;
  readonly transitionId: string;
  readonly phase: AgoraLifecyclePhase;
  readonly originTask?: string;
  readonly insertedTask?: string;
  readonly targetTask?: string;
  readonly terminalState?: string;
  readonly sourceSessionId: string;
  readonly capabilityEpoch: string;
  readonly capabilityHash: string;
  readonly envelopeRevision?: number;
  readonly materializationTransitionId?: string;
  readonly materializationHandoffPath?: string;
  readonly materializationDigest?: string;
}

/** Public projection strips every authorization-only field. */
export type AgoraLifecycleSnapshot = Omit<AgoraLifecycleRecord, 'capabilityHash' | 'capabilityEpoch'>;

/** Internal bearer token held only inside the trusted host process. */
export interface AgoraLifecycleCapabilityToken {
  readonly sessionId: string;
  readonly runId: string;
  readonly epoch: string;
  readonly secret: string;
  readonly operationId: string;
}

/** Public opaque handle. Bearer plaintext is retained in a host-local vault. */
export type AgoraLifecycleCapability = Omit<AgoraLifecycleCapabilityToken, 'secret'>;

/** Trusted pointer to a materialized handoff awaiting fresh-session binding. */
export interface AgoraLifecycleMaterializedHandoff {
  readonly runId: string;
  readonly sourceSessionId: string;
  readonly targetTask: string;
  readonly handoffPath: string;
  readonly phase: 'fresh_session_pending';
  readonly digest: string;
}

export type AgoraMaterializationDisposition =
  | { readonly kind: 'resume' }
  | {
      readonly kind: 'successor';
      readonly relation: 'supersedes' | 'extends' | 'corrects';
      /** Untrusted display data; the adapter must validate before filesystem use. */
      readonly title: string;
      /** Untrusted identifier data; the adapter must validate before filesystem use. */
      readonly slug?: string;
      readonly description?: string;
    };

export interface AgoraMaterializationProposal {
  readonly revision: number;
  readonly disposition: AgoraMaterializationDisposition;
  readonly mode: 'planning' | 'acceptance';
  readonly prd: string;
  readonly design: string;
  readonly implement: string;
  readonly resumeAnchor: string;
  readonly curatedContext?: {
    readonly implement?: string;
    readonly check?: string;
  };
  readonly acceptance: {
    readonly state: 'confirmed';
    readonly criteria: readonly string[];
  };
  readonly validation: {
    readonly state: 'confirmed';
    readonly commands: readonly string[];
  };
  readonly decisionBrief: {
    readonly decision: string;
    readonly rationale: string;
    readonly unresolved: readonly string[];
  };
  readonly peerEvidence: readonly {
    readonly peer: string;
    readonly disposition: 'accepted' | 'rejected' | 'unknown';
    readonly summary: string;
  }[];
  readonly runEvidence: readonly string[];
}

export interface AgoraMaterializationConfirmationProof {
  readonly runId: string;
  readonly sourceSessionId: string;
  readonly proposalRevision: number;
  readonly proposalHash: string;
}

export interface AgoraMaterializationConfirmation extends AgoraMaterializationConfirmationProof {
  readonly confirmedBy: 'host' | 'user';
}

/** Result of a cancel or terminal transition. */
export interface AgoraLifecycleTransitionResult {
  readonly runId: string;
  readonly phase: AgoraLifecyclePhase;
  readonly terminalState?: string;
  readonly cancelled: boolean;
}

/** Trusted input assembled by core for the materialization adapter. */
export interface AgoraLifecycleMaterializeInput {
  readonly runId: string;
  readonly transitionId: string;
  readonly sourceSessionId: string;
  readonly sourceSessionLineage: readonly string[];
  readonly lifecycle: AgoraLifecycleSnapshot;
  readonly run: AgentRecordOf<'agora.run'>;
  readonly proposal: AgoraMaterializationProposal;
  readonly proposalHash: string;
  readonly confirmation: AgentRecordOf<'agora.materialization_confirmation'>;
  readonly provenance: {
    readonly runPacketRevision: number;
    readonly originTask?: string;
    readonly insertedTask: string;
    readonly targetTask?: string;
  };
}

export interface AgoraLifecycleAdapterTransitionInput {
  readonly operation: 'insert' | 'cancel';
  readonly runId: string;
  readonly sourceSessionId: string;
  readonly transitionId: string;
  readonly reconcile: true;
  readonly insert?: {
    readonly title?: string;
    readonly slug?: string;
  };
}

/** Structured insert result; no Bash stdout or caller-projected lifecycle fields. */
export interface AgoraLifecycleAdapterInsertResult {
  readonly success: boolean;
  readonly error?: string;
  readonly originTask?: string;
  readonly insertedTask?: string;
  readonly targetTask?: string;
  readonly envelopeRevision?: number;
}

/** Structured cancel result from the trusted adapter. */
export interface AgoraLifecycleAdapterCancelResult {
  readonly success: boolean;
  readonly error?: string;
  readonly terminalState?: string;
}

/** Trusted result from the materialization adapter. */
export interface AgoraLifecycleMaterializeResult {
  readonly success: boolean;
  readonly error?: string;
  readonly handoff?: AgoraLifecycleMaterializedHandoff;
  /** False proves the adapter failed before external mutation. Undefined means
   * commit status is uncertain and the same transitionId must reconcile. */
  readonly mutationCommitted?: boolean;
}

/** Narrow adapter contract for the host-side Trellis/Python broker. */
export interface AgoraLifecycleAdapter {
  readonly insert: (
    input: AgoraLifecycleAdapterTransitionInput,
  ) => Promise<AgoraLifecycleAdapterInsertResult>;
  readonly cancel: (
    input: AgoraLifecycleAdapterTransitionInput & { readonly lifecycle: AgoraLifecycleSnapshot },
  ) => Promise<AgoraLifecycleAdapterCancelResult>;
  readonly materialize: (
    input: AgoraLifecycleMaterializeInput,
  ) => Promise<AgoraLifecycleMaterializeResult>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomToken(): string {
  return randomBytes(32).toString('hex');
}

function randomEpoch(): string {
  return randomBytes(16).toString('hex');
}

function randomOperationId(): string {
  return randomBytes(16).toString('hex');
}

/** Hash a capability secret for durable storage. */
export function hashAgoraLifecycleCapability(secret: string): string {
  return sha256(secret);
}

/** Create an internal bearer token. The secret must be host-minted. */
export function createAgoraLifecycleCapability(
  sessionId: string,
  runId: string,
  epoch = randomEpoch(),
  secret = randomToken(),
  operationId = randomOperationId(),
): AgoraLifecycleCapabilityToken {
  if (sessionId.trim().length === 0) throw new Error('Agora lifecycle capability requires a session id.');
  if (runId.trim().length === 0) throw new Error('Agora lifecycle capability requires a run id.');
  if (epoch.trim().length === 0) throw new Error('Agora lifecycle capability requires a non-empty epoch.');
  if (secret.trim().length === 0) throw new Error('Agora lifecycle capability requires a non-empty secret.');
  if (operationId.trim().length === 0) throw new Error('Agora lifecycle capability requires a non-empty operation id.');
  return { sessionId, runId, epoch, secret, operationId };
}

export function toAgoraLifecycleHandle(token: AgoraLifecycleCapabilityToken): AgoraLifecycleCapability {
  const { secret: _secret, ...handle } = token;
  return handle;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).filter((key) => object[key] !== undefined).toSorted();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function hashAgoraMaterializationProposal(proposal: AgoraMaterializationProposal): string {
  return sha256(canonicalJson(proposal));
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`Agora materialization proposal requires non-empty ${field}.`);
}

function validateDurableMaterializationRun(run: AgentRecordOf<'agora.run'>): void {
  if (run.terminalState !== 'converged') {
    throw new Error(`Agora run ${run.runId} has not reached durable convergence.`);
  }
  if (run.peers.length === 0 || run.peers.some((peer) =>
    peer.status === 'pending'
    || peer.status === 'repair_required'
    || peer.backend === undefined
    || (peer.status === 'completed'
      && (peer.initialRawResponse === undefined || peer.normalizedResponse === undefined)))) {
    throw new Error(`Agora run ${run.runId} lacks terminal peer evidence.`);
  }
  if (Object.values(run.temporaryOverrides).some((state) => state !== 'disposed')) {
    throw new Error(`Agora run ${run.runId} still has active temporary overrides.`);
  }
}

export function validateAgoraMaterializationProposal(proposal: AgoraMaterializationProposal): void {
  if (!Number.isInteger(proposal.revision) || proposal.revision < 1) {
    throw new Error('Agora materialization proposal revision must be a positive integer.');
  }
  for (const [field, value] of [
    ['prd', proposal.prd],
    ['design', proposal.design],
    ['implement', proposal.implement],
    ['resumeAnchor', proposal.resumeAnchor],
  ] as const) requireNonEmpty(value, field);
  if (!proposal.implement.includes(proposal.resumeAnchor.trim())) {
    throw new Error('Agora materialization proposal resumeAnchor must occur in implement.');
  }
  if (proposal.acceptance.state !== 'confirmed' || proposal.acceptance.criteria.length === 0) {
    throw new Error('Agora materialization proposal requires confirmed acceptance criteria.');
  }
  if (proposal.validation.state !== 'confirmed' || proposal.validation.commands.length === 0) {
    throw new Error('Agora materialization proposal requires confirmed validation commands.');
  }
  requireNonEmpty(proposal.decisionBrief.decision, 'decisionBrief.decision');
  requireNonEmpty(proposal.decisionBrief.rationale, 'decisionBrief.rationale');
  if (proposal.peerEvidence.length === 0 || proposal.runEvidence.length === 0) {
    throw new Error('Agora materialization proposal requires peer and run evidence.');
  }
  if (proposal.disposition.kind === 'successor') {
    requireNonEmpty(proposal.disposition.title, 'disposition.title');
    if (proposal.disposition.title.length > 200) throw new Error('Agora materialization proposal title is too long.');
    if (proposal.disposition.slug !== undefined) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(proposal.disposition.slug) || proposal.disposition.slug.length > 80) {
        throw new Error('Agora materialization proposal slug must be a canonical lowercase slug.');
      }
    }
  }
}

/** Build the durable record for a lifecycle transition. */
export function buildAgoraLifecycleRecord(input: {
  readonly sessionId: string;
  readonly runId: string;
  readonly transitionId: string;
  readonly phase: AgoraLifecyclePhase;
  readonly originTask?: string;
  readonly insertedTask?: string;
  readonly targetTask?: string;
  readonly terminalState?: string;
  readonly capabilityEpoch: string;
  readonly capabilityHash: string;
  readonly envelopeRevision?: number;
  readonly materializationTransitionId?: string;
  readonly materializationHandoffPath?: string;
  readonly materializationDigest?: string;
}): AgentRecordOf<'agora.lifecycle'> {
  return {
    type: 'agora.lifecycle',
    runId: input.runId,
    transitionId: input.transitionId,
    phase: input.phase,
    originTask: input.originTask,
    insertedTask: input.insertedTask,
    targetTask: input.targetTask,
    terminalState: input.terminalState,
    sourceSessionId: input.sessionId,
    capabilityEpoch: input.capabilityEpoch,
    capabilityHash: input.capabilityHash,
    envelopeRevision: input.envelopeRevision,
    materializationTransitionId: input.materializationTransitionId,
    materializationHandoffPath: input.materializationHandoffPath,
    materializationDigest: input.materializationDigest,
  };
}

function toSnapshot(record: AgentRecordOf<'agora.lifecycle'>): AgoraLifecycleSnapshot {
  const { capabilityHash: _hash, capabilityEpoch: _epoch, ...snapshot } = record;
  return snapshot;
}

/**
 * Resolve the durable lifecycle authorization for an Agora run. Returns
 * undefined when there is no inserted task or the phase does not allow peer
 * dispatch.
 */
export function resolveAgoraLifecycleForDispatch(
  records: AgentRecords | undefined,
  runId: string,
): { readonly phase: AgoraLifecyclePhase; readonly insertedTask: string; readonly originTask?: string } | undefined {
  if (records === undefined) return undefined;
  const latest = records.latestAgoraLifecycle(runId);
  if (latest === undefined) return undefined;
  const insertedTask = latest.insertedTask;
  if (insertedTask === undefined || insertedTask.length === 0) return undefined;
  if (!DISPATCH_ALLOWED_PHASES.has(latest.phase)) return undefined;
  return { phase: latest.phase, insertedTask, originTask: latest.originTask };
}

/** Verify that an internal bearer token matches durable lifecycle state. */
export function verifyAgoraLifecycleHandle(
  records: AgentRecords | undefined,
  handle: AgoraLifecycleCapabilityToken,
): AgentRecordOf<'agora.lifecycle'> {
  if (records === undefined) {
    throw new Error('Agora lifecycle handle cannot be verified without durable records.');
  }
  const latest = records.latestAgoraLifecycle(handle.runId);
  if (latest === undefined) {
    throw new Error(`Agora run ${handle.runId} has no durable lifecycle record; refusing lifecycle operation.`);
  }
  if (latest.sourceSessionId !== handle.sessionId) {
    throw new Error('Agora lifecycle handle is bound to a different session; refusing operation.');
  }
  if (latest.capabilityEpoch !== handle.epoch) {
    throw new Error('Agora lifecycle handle epoch is stale; a transition already advanced this run.');
  }
  if (latest.capabilityHash !== hashAgoraLifecycleCapability(handle.secret)) {
    throw new Error('Agora lifecycle handle digest does not match the durable record; refusing operation.');
  }
  return latest;
}

export function isAgoraLifecycleTerminal(phase: AgoraLifecyclePhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/** Check whether the lifecycle phase allows proposal confirmation. */
function isConfirmablePhase(phase: AgoraLifecyclePhase): boolean {
  return phase === 'task_materialization';
}

/** Check whether the lifecycle phase allows execution or reconciliation. */
function isMaterializablePhase(phase: AgoraLifecyclePhase): boolean {
  return phase === 'task_materialization'
    || phase === 'materialization_executing'
    || phase === 'fresh_session_pending';
}

/**
 * Insert (or reconcile) a typed lifecycle transition. Idempotent when the same
 * transitionId is retried with the same runId/phase/tasks/sourceSessionId:
 * the existing durable record is returned without a duplicate append.
 */
export function recordAgoraLifecycleTransition(
  records: AgentRecords,
  input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly transitionId: string;
    readonly phase: AgoraLifecyclePhase;
    readonly originTask?: string;
    readonly insertedTask?: string;
    readonly targetTask?: string;
    readonly terminalState?: string;
    readonly capability: AgoraLifecycleCapabilityToken;
    readonly envelopeRevision?: number;
    readonly materializationTransitionId?: string;
    readonly materializationHandoffPath?: string;
    readonly materializationDigest?: string;
  },
): AgoraLifecycleSnapshot {
  const existing = records.latestAgoraLifecycle(input.runId);
  if (existing !== undefined && existing.transitionId === input.transitionId) {
    // Reconcile: verify the durable record matches the requested transition.
    if (
      existing.phase !== input.phase
      || existing.sourceSessionId !== input.sessionId
      || existing.originTask !== input.originTask
      || existing.insertedTask !== input.insertedTask
      || existing.targetTask !== input.targetTask
      || existing.terminalState !== input.terminalState
      || existing.capabilityEpoch !== input.capability.epoch
      || existing.capabilityHash !== hashAgoraLifecycleCapability(input.capability.secret)
    ) {
      throw new Error(
        `Agora lifecycle transition ${input.transitionId} for run ${input.runId} already exists with conflicting fields.`,
      );
    }
    return toSnapshot(existing);
  }
  const record = buildAgoraLifecycleRecord({
    sessionId: input.sessionId,
    runId: input.runId,
    transitionId: input.transitionId,
    phase: input.phase,
    originTask: input.originTask,
    insertedTask: input.insertedTask,
    targetTask: input.targetTask,
    terminalState: input.terminalState,
    capabilityEpoch: input.capability.epoch,
    capabilityHash: hashAgoraLifecycleCapability(input.capability.secret),
    envelopeRevision: input.envelopeRevision,
    materializationTransitionId: input.materializationTransitionId,
    materializationHandoffPath: input.materializationHandoffPath,
    materializationDigest: input.materializationDigest,
  });
  records.logRecord(record);
  return toSnapshot(record);
}

/**
 * Cancel an Agora run. Requires a valid lifecycle handle. Returns a deterministic
 * idempotent result when called again with the same handle after the run is
 * already cancelled.
 */
export async function cancelAgoraLifecycleTransition(
  records: AgentRecords,
  adapter: AgoraLifecycleAdapter | undefined,
  handle: AgoraLifecycleCapabilityToken,
  transitionId: string,
): Promise<AgoraLifecycleTransitionResult> {
  const latest = records.latestAgoraLifecycle(handle.runId);
  if (latest?.phase === 'cancelled') {
    if (latest.transitionId !== transitionId) {
      throw new Error(`Agora run ${handle.runId} is already cancelled by transition ${latest.transitionId}.`);
    }
    return { runId: handle.runId, phase: 'cancelled', terminalState: latest.terminalState, cancelled: true };
  }
  const verified = verifyAgoraLifecycleHandle(records, handle);
  if (adapter === undefined) throw new Error('Agora lifecycle adapter is not configured.');
  const transition = await adapter.cancel({
    operation: 'cancel',
    runId: handle.runId,
    sourceSessionId: verified.sourceSessionId,
    transitionId,
    reconcile: true,
    lifecycle: toSnapshot(verified),
  });
  if (!transition.success) {
    throw new Error(transition.error ?? `Agora cancel transition ${transitionId} failed.`);
  }
  const record = buildAgoraLifecycleRecord({
    sessionId: verified.sourceSessionId,
    runId: handle.runId,
    transitionId,
    phase: 'cancelled',
    originTask: verified.originTask,
    insertedTask: verified.insertedTask,
    targetTask: verified.targetTask,
    terminalState: transition.terminalState ?? 'cancelled',
    capabilityEpoch: randomEpoch(),
    capabilityHash: hashAgoraLifecycleCapability(randomToken()),
    envelopeRevision: verified.envelopeRevision,
  });
  records.logRecord(record);
  return { runId: handle.runId, phase: 'cancelled', terminalState: record.terminalState, cancelled: true };
}

/**
 * Resolve a materialized fresh-session handoff after the target task is bound.
 * The capability remains valid through `fresh_session_pending` so a failed
 * terminal flush can retry this same transition without rematerializing.
 */
export function resolveAgoraHandoffTransition(
  records: AgentRecords,
  handle: AgoraLifecycleCapabilityToken,
  transitionId: string,
  handoff: AgoraLifecycleMaterializedHandoff,
  resolution: 'resolved_to_origin' | 'resolved_to_successor',
): AgoraLifecycleTransitionResult {
  const latest = verifyAgoraLifecycleHandle(records, handle);
  if (TERMINAL_PHASES.has(latest.phase)) {
    if (latest.transitionId !== transitionId || latest.phase !== resolution) {
      throw new Error(`Agora run ${handle.runId} is already terminal by transition ${latest.transitionId}.`);
    }
    return {
      runId: handle.runId,
      phase: latest.phase,
      terminalState: latest.terminalState,
      cancelled: false,
    };
  }
  if (latest.phase !== 'fresh_session_pending') {
    throw new Error(`Agora run ${handle.runId} is not awaiting fresh-session handoff resolution.`);
  }
  if (
    handoff.runId !== handle.runId
    || handoff.sourceSessionId !== latest.sourceSessionId
    || handoff.targetTask !== latest.targetTask
    || handoff.handoffPath !== latest.materializationHandoffPath
    || handoff.digest !== latest.materializationDigest
    || handoff.phase !== 'fresh_session_pending'
  ) {
    throw new Error(`Agora run ${handle.runId} handoff provenance does not match the pending lifecycle record.`);
  }
  const terminalState = resolution === 'resolved_to_origin' ? 'resumed' : 'materialized';
  const record = recordAgoraLifecycleTransition(records, {
    sessionId: latest.sourceSessionId,
    runId: handle.runId,
    transitionId,
    phase: resolution,
    originTask: latest.originTask,
    insertedTask: latest.insertedTask,
    targetTask: latest.targetTask,
    terminalState,
    capability: handle,
    envelopeRevision: latest.envelopeRevision,
    materializationTransitionId: latest.materializationTransitionId,
    materializationHandoffPath: latest.materializationHandoffPath,
    materializationDigest: latest.materializationDigest,
  });
  return {
    runId: handle.runId,
    phase: record.phase,
    terminalState: record.terminalState,
    cancelled: false,
  };
}

export function recordAgoraLifecycleToTaskMaterialization(
  records: AgentRecords,
  handle: AgoraLifecycleCapabilityToken,
): AgoraLifecycleSnapshot {
  const lifecycle = verifyAgoraLifecycleHandle(records, handle);
  const run = records.latestAgoraRun(handle.runId);
  if (run === undefined || run.runId !== lifecycle.runId) {
    throw new Error(`Agora run ${handle.runId} has no durable run evidence.`);
  }
  validateDurableMaterializationRun(run);
  if (lifecycle.insertedTask === undefined) {
    throw new Error(`Agora run ${handle.runId} has no durable inserted task provenance.`);
  }
  return recordAgoraLifecycleTransition(records, {
    sessionId: lifecycle.sourceSessionId,
    runId: handle.runId,
    transitionId: `${lifecycle.transitionId}-materialization`,
    phase: 'task_materialization',
    originTask: lifecycle.originTask,
    insertedTask: lifecycle.insertedTask,
    targetTask: lifecycle.targetTask,
    terminalState: 'converged',
    capability: handle,
    envelopeRevision: lifecycle.envelopeRevision,
  });
}

export function confirmAgoraMaterializationProposal(
  records: AgentRecords,
  handle: AgoraLifecycleCapabilityToken,
  proposal: AgoraMaterializationProposal,
  confirmedBy: AgoraMaterializationConfirmation['confirmedBy'],
): AgoraMaterializationConfirmation {
  let lifecycle = verifyAgoraLifecycleHandle(records, handle);
  const run = records.latestAgoraRun(handle.runId);
  if (run === undefined || run.runId !== lifecycle.runId) {
    throw new Error(`Agora run ${handle.runId} has no durable run evidence.`);
  }
  if (!isConfirmablePhase(lifecycle.phase)) {
    const autoAdvance: ReadonlySet<AgoraLifecyclePhase> = new Set([
      'packet_confirmation', 'peer_review', 'synthesis', 'trellis_convergence',
    ]);
    if (!autoAdvance.has(lifecycle.phase)) {
      throw new Error(`Agora run ${handle.runId} is not in a materializable phase (phase=${lifecycle.phase}).`);
    }
    recordAgoraLifecycleToTaskMaterialization(records, handle);
    lifecycle = verifyAgoraLifecycleHandle(records, handle);
  }
  validateAgoraMaterializationProposal(proposal);
  validateDurableMaterializationRun(run);
  const proposalHash = hashAgoraMaterializationProposal(proposal);
  const existing = records.latestAgoraMaterializationConfirmation(handle.runId);
  if (existing !== undefined) {
    if (
      existing.state === 'confirmed'
      && existing.sourceSessionId === lifecycle.sourceSessionId
      && existing.lifecycleEpoch === lifecycle.capabilityEpoch
      && existing.proposalRevision === proposal.revision
      && existing.proposalHash === proposalHash
      && existing.runPacketRevision === run.packetRevision
      && existing.confirmedBy === confirmedBy
    ) {
      return {
        runId: existing.runId,
        sourceSessionId: existing.sourceSessionId,
        proposalRevision: existing.proposalRevision,
        proposalHash: existing.proposalHash,
        confirmedBy: existing.confirmedBy,
      };
    }
    throw new Error(`Agora run ${handle.runId} already has a different or consumed materialization confirmation.`);
  }
  records.logRecord({
    type: 'agora.materialization_confirmation',
    runId: handle.runId,
    sourceSessionId: lifecycle.sourceSessionId,
    lifecycleEpoch: lifecycle.capabilityEpoch,
    proposalRevision: proposal.revision,
    proposalHash,
    runPacketRevision: run.packetRevision,
    state: 'confirmed',
    confirmedBy,
  });
  return {
    runId: handle.runId,
    sourceSessionId: lifecycle.sourceSessionId,
    proposalRevision: proposal.revision,
    proposalHash,
    confirmedBy,
  };
}

/** Durable confirmed -> executing -> applied materialization transaction. */
export async function materializeAgoraLifecycleTransition(
  records: AgentRecords,
  adapter: AgoraLifecycleAdapter | undefined,
  handle: AgoraLifecycleCapabilityToken,
  transitionId: string,
  sourceSessionLineage: readonly string[],
  proposal: AgoraMaterializationProposal,
  confirmation: AgoraMaterializationConfirmationProof,
): Promise<AgoraLifecycleMaterializeResult> {
  let latest = verifyAgoraLifecycleHandle(records, handle);
  if (!isMaterializablePhase(latest.phase)) {
    return { success: false, error: `Agora run ${handle.runId} is not in a materializable phase (phase=${latest.phase}); peer review is not terminal.` };
  }
  if (adapter === undefined) return { success: false, error: 'Agora materialization adapter is not configured.' };
  validateAgoraMaterializationProposal(proposal);
  const proposalHash = hashAgoraMaterializationProposal(proposal);
  if (
    confirmation.runId !== handle.runId
    || confirmation.sourceSessionId !== latest.sourceSessionId
    || confirmation.proposalRevision !== proposal.revision
    || confirmation.proposalHash !== proposalHash
  ) return { success: false, error: 'Agora materialization confirmation does not match this run, session, revision, or proposal hash.' };
  const run = records.latestAgoraRun(handle.runId);
  const insertedTask = latest.insertedTask;
  if (run === undefined || insertedTask === undefined) return { success: false, error: 'Agora materialization lacks durable run or inserted-task provenance.' };
  try {
    validateDurableMaterializationRun(run);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (latest.phase === 'fresh_session_pending' && latest.materializationTransitionId === transitionId) {
    if (latest.targetTask === undefined || latest.materializationHandoffPath === undefined || latest.materializationDigest === undefined) {
      return { success: false, error: 'Agora materialization applied record is missing durable result fields.' };
    }
    await records.flush();
    return { success: true, handoff: {
      runId: handle.runId,
      sourceSessionId: latest.sourceSessionId,
      targetTask: latest.targetTask,
      handoffPath: latest.materializationHandoffPath,
      phase: 'fresh_session_pending',
      digest: latest.materializationDigest,
    } };
  }
  if (latest.phase === 'materialization_executing' && latest.materializationTransitionId !== transitionId) {
    return { success: false, error: `Agora run ${handle.runId} is already being materialized by another transition.` };
  }
  if (latest.phase === 'fresh_session_pending') {
    return { success: false, error: `Agora run ${handle.runId} was already materialized by a different transition.` };
  }
  const durableConfirmation = records.latestAgoraMaterializationConfirmation(handle.runId);
  if (
    durableConfirmation === undefined
    || durableConfirmation.sourceSessionId !== latest.sourceSessionId
    || durableConfirmation.lifecycleEpoch !== latest.capabilityEpoch
    || durableConfirmation.proposalRevision !== proposal.revision
    || durableConfirmation.proposalHash !== proposalHash
    || durableConfirmation.runPacketRevision !== run.packetRevision
    || (durableConfirmation.state === 'consumed' && durableConfirmation.consumedBy !== transitionId)
  ) {
    return { success: false, error: 'Agora materialization confirmation is missing, stale, consumed, or does not match durable run evidence.' };
  }
  if (latest.phase === 'task_materialization') {
    recordAgoraLifecycleTransition(records, {
      sessionId: latest.sourceSessionId,
      runId: handle.runId,
      transitionId: `executing-${transitionId}`,
      phase: 'materialization_executing',
      originTask: latest.originTask,
      insertedTask,
      targetTask: latest.targetTask,
      terminalState: 'converged',
      capability: handle,
      envelopeRevision: latest.envelopeRevision,
      materializationTransitionId: transitionId,
    });
    await records.flush();
  }
  latest = verifyAgoraLifecycleHandle(records, handle);
  const result = await adapter.materialize({
    runId: handle.runId,
    transitionId,
    sourceSessionId: latest.sourceSessionId,
    sourceSessionLineage,
    lifecycle: toSnapshot(latest),
    run,
    proposal,
    proposalHash,
    confirmation: durableConfirmation,
    provenance: {
      runPacketRevision: run.packetRevision,
      originTask: latest.originTask,
      insertedTask,
      targetTask: latest.targetTask,
    },
  });
  if (!result.success) {
    if (result.mutationCommitted === false) {
      recordAgoraLifecycleTransition(records, {
        sessionId: latest.sourceSessionId,
        runId: handle.runId,
        transitionId: `released-${transitionId}`,
        phase: 'task_materialization',
        originTask: latest.originTask,
        insertedTask,
        targetTask: latest.targetTask,
        terminalState: 'converged',
        capability: handle,
        envelopeRevision: latest.envelopeRevision,
      });
      await records.flush();
    }
    return result;
  }
  if (
    result.handoff === undefined
    || result.handoff.runId !== handle.runId
    || result.handoff.sourceSessionId !== latest.sourceSessionId
    || result.handoff.phase !== 'fresh_session_pending'
    || result.handoff.digest.length === 0
  ) return { success: false, error: 'Agora materialization adapter returned an invalid pending handoff.' };
  if (!(durableConfirmation.state === 'consumed' && durableConfirmation.consumedBy === transitionId)) {
    records.logRecord({
      type: 'agora.materialization_confirmation',
      runId: handle.runId,
      sourceSessionId: latest.sourceSessionId,
      lifecycleEpoch: latest.capabilityEpoch,
      proposalRevision: proposal.revision,
      proposalHash,
      runPacketRevision: run.packetRevision,
      state: 'consumed',
      consumedBy: transitionId,
      confirmedBy: durableConfirmation.confirmedBy,
    });
  }
  recordAgoraLifecycleTransition(records, {
    sessionId: latest.sourceSessionId,
    runId: handle.runId,
    transitionId,
    phase: 'fresh_session_pending',
    originTask: latest.originTask,
    insertedTask,
    targetTask: result.handoff.targetTask,
    terminalState: 'materialized',
    capability: handle,
    envelopeRevision: latest.envelopeRevision,
    materializationTransitionId: transitionId,
    materializationHandoffPath: result.handoff.handoffPath,
    materializationDigest: result.handoff.digest,
  });
  await records.flush();
  return result;
}
