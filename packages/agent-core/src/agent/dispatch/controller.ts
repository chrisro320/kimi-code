/**
 * Shared pre-spawn dispatch guardrail controller.
 *
 * Sits in front of `SessionSubagentHost.spawn`/`runQueued` so direct `Agent`
 * and `AgentSwarm` paths share one enforcement point for D4/D5 (hard limits
 * and scope ownership). It validates the main model's declared dispatch
 * decision; it never classifies tasks by keyword, file extension, or path.
 *
 * Concurrency limits (new spawns per turn, active editing, active read-only)
 * are queue-only: a request that is otherwise valid but currently over
 * budget waits in FIFO order and is promoted as capacity frees up on
 * `release()` or at the next turn boundary. Structural violations (malformed
 * scope, scope outside the workspace, scope overlap, exhausted escalation/
 * review cycles) are rejected outright and never queued.
 */

import { normalizeScopeList, scopesOverlap } from './scope';

export const DISPATCH_MAX_NEW_SPAWNS_PER_TURN = 8;
export const DISPATCH_MAX_ACTIVE_EDITING = 4;
export const DISPATCH_MAX_ACTIVE_READ_ONLY = 8;

export type DispatchEscalationKind = 'coder-ex' | 'reviewer';

export interface DispatchWorkCard {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly dependencies?: readonly string[];
  readonly acceptance: string;
  readonly forbiddenScope?: readonly string[];
  readonly routeOverride?: { readonly backend: string; readonly model?: string };
}

export interface DispatchSpawnRequest {
  /** Caller-supplied identifier, unique for the lifetime of this controller. */
  readonly requestId: string;
  /** Whether the resolved profile can write (see `isEditingCapableProfile`). */
  readonly isEditingCapable: boolean;
  /** Workspace-relative paths/globs; required (and validated) when editing. */
  readonly scope?: readonly string[];
  /** Set when this dispatch is a bounded repair/escalation cycle. */
  readonly escalation?: DispatchEscalationKind;
  /**
   * Groups a request with prior escalations/reviews of the same work for
   * cycle-limit bookkeeping. Defaults to the normalized, sorted scope join.
   */
  readonly logicalScopeKey?: string;
  readonly workCard?: DispatchWorkCard;
  readonly displayProfile?: string;
}

export type DispatchRejectionReason =
  | 'malformed-scope'
  | 'scope-outside-repo'
  | 'scope-overlap'
  | 'cycle-exhausted'
  | 'invalid-work-card'
  | 'duplicate-work-card'
  | 'dependency-failed';

export type DispatchOutcome = 'completed' | 'failed' | 'aborted' | 'timeout' | 'dependency-failed';

export type DispatchDecision =
  | { readonly kind: 'started'; readonly reservationId: string; readonly displayName?: string }
  | { readonly kind: 'queued'; readonly reservationId: string; readonly displayName?: string }
  | { readonly kind: 'rejected'; readonly reason: DispatchRejectionReason; readonly message: string };

export type DispatchWaitOutcome = 'started' | 'released' | 'dependency-failed';

interface Reservation {
  readonly requestId: string;
  readonly isEditingCapable: boolean;
  readonly scope: readonly string[];
  readonly logicalScopeKey?: string;
  readonly escalation?: DispatchEscalationKind;
  readonly workCard?: DispatchWorkCard;
  readonly displayName?: string;
  readonly displayProfile?: string;
  state: 'queued' | 'started';
  waiters: Array<(decision: DispatchWaitOutcome) => void>;
}

let reservationSequence = 0;

export class DispatchController {
  private turnKey: string | undefined;
  private newSpawnCount = 0;
  private readonly onQueuedCountChange: (() => void) | undefined;

  constructor(options: { readonly onQueuedCountChange?: () => void } = {}) {
    this.onQueuedCountChange = options.onQueuedCountChange;
  }

  get queuedCount(): number {
    return this.queueOrder.length;
  }

  private notifyQueuedCountChange(): void {
    this.onQueuedCountChange?.();
  }
  private readonly activeEditing = new Set<string>();
  private readonly activeReadOnly = new Set<string>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly queueOrder: string[] = [];
  private readonly cards = new Map<
    string,
    { readonly reservationId: string; status: 'queued' | 'started' | DispatchOutcome }
  >();
  private readonly displaySlots = new Map<string, Set<number>>();
  private readonly scopeCycles = new Map<
    string,
    { escalations: number; reviewerRepairs: number }
  >();

  /** Reset the per-turn spawn budget at a parent turn boundary; active reservations persist. */
  beginTurn(turnKey: string): void {
    if (this.turnKey === turnKey) return;
    this.turnKey = turnKey;
    this.newSpawnCount = 0;
    this.promoteQueued();
  }

  reserve(request: DispatchSpawnRequest): DispatchDecision {
    if (this.reservations.has(request.requestId)) {
      throw new Error(`Dispatch requestId "${request.requestId}" is already reserved.`);
    }

    const cardError = this.validateWorkCard(request.workCard);
    if (cardError !== undefined) return cardError;

    let scope: readonly string[] = [];
    if (request.isEditingCapable) {
      const raw = request.scope ?? [];
      if (raw.length === 0) {
        return {
          kind: 'rejected',
          reason: 'malformed-scope',
          message: 'An editing-capable dispatch requires at least one scope entry.',
        };
      }
      const normalized = normalizeScopeList(raw);
      if (!normalized.ok) {
        return {
          kind: 'rejected',
          reason: normalized.error === 'outside-repo' ? 'scope-outside-repo' : 'malformed-scope',
          message: normalized.message,
        };
      }
      scope = normalized.value;
      const forbidden = normalizeScopeList(request.workCard?.forbiddenScope ?? []);
      if (!forbidden.ok) {
        return { kind: 'rejected', reason: 'invalid-work-card', message: forbidden.message };
      }
      if (forbidden.value.some((entry) => scopesOverlap(scope, [entry]))) {
        return {
          kind: 'rejected',
          reason: 'invalid-work-card',
          message: 'Work-card scope overlaps its forbidden scope.',
        };
      }

      for (const existing of this.reservations.values()) {
        if (!existing.isEditingCapable) continue;
        if (scopesOverlap(scope, existing.scope) && request.workCard === undefined) {
          return {
            kind: 'rejected',
            reason: 'scope-overlap',
            message: `Scope overlaps an in-flight editing dispatch (requestId "${existing.requestId}").`,
          };
        }
      }
    }

    const logicalScopeKey = request.logicalScopeKey ?? defaultLogicalScopeKey(scope);
    if (request.escalation !== undefined) {
      const cycles = this.scopeCycles.get(logicalScopeKey);
      const used = request.escalation === 'coder-ex' ? cycles?.escalations : cycles?.reviewerRepairs;
      if ((used ?? 0) >= 1) {
        return {
          kind: 'rejected',
          reason: 'cycle-exhausted',
          message: `Logical scope "${logicalScopeKey}" already used its one ${request.escalation} cycle.`,
        };
      }
    }

    // Commit: from here the request is accepted, either started immediately
    // or queued for capacity. Cycle usage is charged at accept time so a
    // still-pending repair blocks a second concurrent attempt.
    if (request.escalation !== undefined) {
      const cycles = this.scopeCycles.get(logicalScopeKey) ?? { escalations: 0, reviewerRepairs: 0 };
      if (request.escalation === 'coder-ex') cycles.escalations += 1;
      else cycles.reviewerRepairs += 1;
      this.scopeCycles.set(logicalScopeKey, cycles);
    }

    const reservationId = `dispatch-${String(++reservationSequence)}`;
    const displayName = this.allocateDisplayName(request.displayProfile);
    const reservation: Reservation = {
      requestId: request.requestId,
      isEditingCapable: request.isEditingCapable,
      scope,
      logicalScopeKey: request.escalation !== undefined ? logicalScopeKey : undefined,
      escalation: request.escalation,
      workCard: request.workCard,
      displayName,
      displayProfile: request.displayProfile,
      state: 'queued',
      waiters: [],
    };
    this.reservations.set(reservationId, reservation);
    if (request.workCard !== undefined) {
      this.cards.set(request.workCard.id, { reservationId, status: 'queued' });
    }

    if (this.canStart(reservation)) {
      this.start(reservationId, reservation);
      return { kind: 'started', reservationId, displayName };
    }
    this.queueOrder.push(reservationId);
    this.notifyQueuedCountChange();
    return { kind: 'queued', reservationId, displayName };
  }

  /** Resolves once a queued reservation starts or becomes terminal before launch. */
  waitUntilStarted(reservationId: string): Promise<DispatchWaitOutcome> {
    const reservation = this.reservations.get(reservationId);
    if (reservation === undefined) return Promise.resolve('released');
    if (reservation.state === 'started') return Promise.resolve('started');
    return new Promise((resolve) => {
      reservation.waiters.push(resolve);
    });
  }

  /** Release a reservation on every terminal path (completed/failed/aborted/timeout), or a still-queued cancel. */
  release(reservationId: string, outcome: DispatchOutcome = 'aborted'): void {
    const reservation = this.reservations.get(reservationId);
    if (reservation === undefined) return;
    const wasQueued = reservation.state === 'queued';
    const previousQueuedCount = this.queuedCount;
    this.removeReservation(reservationId, reservation, outcome, 'released');
    this.promoteQueued();
    if (wasQueued && previousQueuedCount !== this.queuedCount) {
      this.notifyQueuedCountChange();
    }
  }

  private validateWorkCard(
    card: DispatchWorkCard | undefined,
  ): Extract<DispatchDecision, { kind: 'rejected' }> | undefined {
    if (card === undefined) return;
    if (
      card.id.trim().length === 0 ||
      card.title.trim().length === 0 ||
      card.goal.trim().length === 0 ||
      card.acceptance.trim().length === 0
    ) {
      return {
        kind: 'rejected',
        reason: 'invalid-work-card',
        message: 'Work card id, title, goal, and acceptance must be non-empty.',
      };
    }
    if (this.cards.has(card.id)) {
      return {
        kind: 'rejected',
        reason: 'duplicate-work-card',
        message: `Work card "${card.id}" already exists.`,
      };
    }
    if (card.dependencies?.includes(card.id) === true) {
      return {
        kind: 'rejected',
        reason: 'invalid-work-card',
        message: `Work card "${card.id}" cannot depend on itself.`,
      };
    }
    for (const dependency of card.dependencies ?? []) {
      if (!this.cards.has(dependency)) {
        return {
          kind: 'rejected',
          reason: 'invalid-work-card',
          message: `Work card "${card.id}" references unknown dependency "${dependency}".`,
        };
      }
    }
    const forbidden = normalizeScopeList(card.forbiddenScope ?? []);
    if (!forbidden.ok) {
      return { kind: 'rejected', reason: 'invalid-work-card', message: forbidden.message };
    }
  }

  private dependenciesReady(reservation: Reservation): boolean {
    for (const dependency of reservation.workCard?.dependencies ?? []) {
      const status = this.cards.get(dependency)?.status;
      if (status !== 'completed') return false;
    }
    return true;
  }

  private dependencyFailed(reservation: Reservation): boolean {
    return (reservation.workCard?.dependencies ?? []).some((dependency) => {
      const status = this.cards.get(dependency)?.status;
      return status !== undefined && status !== 'queued' && status !== 'started' && status !== 'completed';
    });
  }

  private removeReservation(
    reservationId: string,
    reservation: Reservation,
    outcome: DispatchOutcome,
    waitOutcome: DispatchWaitOutcome,
  ): void {
    this.reservations.delete(reservationId);
    if (reservation.workCard !== undefined) {
      const card = this.cards.get(reservation.workCard.id);
      if (card !== undefined) card.status = outcome;
    }
    this.releaseDisplayName(reservation.displayProfile, reservation.displayName);
    if (reservation.state === 'started') {
      (reservation.isEditingCapable ? this.activeEditing : this.activeReadOnly).delete(reservationId);
    } else {
      const index = this.queueOrder.indexOf(reservationId);
      if (index !== -1) this.queueOrder.splice(index, 1);
    }
    for (const waiter of reservation.waiters.splice(0)) waiter(waitOutcome);
  }

  private scopeAvailable(reservation: Reservation): boolean {
    if (!reservation.isEditingCapable || reservation.workCard === undefined) return true;
    for (const existing of this.reservations.values()) {
      if (existing === reservation || existing.state !== 'started' || !existing.isEditingCapable) continue;
      if (scopesOverlap(reservation.scope, existing.scope)) return false;
    }
    return true;
  }

  private canStart(reservation: Reservation): boolean {
    return (
      this.hasCapacity(reservation.isEditingCapable) &&
      this.dependenciesReady(reservation) &&
      this.scopeAvailable(reservation)
    );
  }

  private allocateDisplayName(profile: string | undefined): string | undefined {
    if (profile === undefined) return undefined;
    const used = this.displaySlots.get(profile) ?? new Set<number>();
    let slot = 1;
    while (used.has(slot)) slot += 1;
    used.add(slot);
    this.displaySlots.set(profile, used);
    return `${profile}#${String(slot)}`;
  }

  private releaseDisplayName(profile: string | undefined, displayName: string | undefined): void {
    if (profile === undefined || displayName === undefined) return;
    const slot = Number(displayName.slice(profile.length + 1));
    this.displaySlots.get(profile)?.delete(slot);
  }

  private hasCapacity(isEditingCapable: boolean): boolean {
    if (this.newSpawnCount >= DISPATCH_MAX_NEW_SPAWNS_PER_TURN) return false;
    return isEditingCapable
      ? this.activeEditing.size < DISPATCH_MAX_ACTIVE_EDITING
      : this.activeReadOnly.size < DISPATCH_MAX_ACTIVE_READ_ONLY;
  }

  private start(reservationId: string, reservation: Reservation): void {
    reservation.state = 'started';
    if (reservation.workCard !== undefined) {
      const card = this.cards.get(reservation.workCard.id);
      if (card !== undefined) card.status = 'started';
    }
    this.newSpawnCount += 1;
    (reservation.isEditingCapable ? this.activeEditing : this.activeReadOnly).add(reservationId);
    const waiters = reservation.waiters.splice(0);
    for (const waiter of waiters) waiter('started');
  }

  private promoteQueued(): void {
    const previousQueuedCount = this.queuedCount;
    let index = 0;
    while (index < this.queueOrder.length) {
      const reservationId = this.queueOrder[index]!;
      const reservation = this.reservations.get(reservationId);
      if (reservation === undefined) {
        this.queueOrder.splice(index, 1);
        continue;
      }
      if (this.dependencyFailed(reservation)) {
        this.queueOrder.splice(index, 1);
        this.removeReservation(reservationId, reservation, 'dependency-failed', 'dependency-failed');
        continue;
      }
      if (!this.canStart(reservation)) {
        index += 1;
        continue;
      }
      this.queueOrder.splice(index, 1);
      this.start(reservationId, reservation);
      // Do not advance `index`: re-check the new item now occupying it.
    }
    if (previousQueuedCount !== this.queuedCount) this.notifyQueuedCountChange();
  }
}

function defaultLogicalScopeKey(scope: readonly string[]): string {
  return [...scope].sort().join('|');
}
