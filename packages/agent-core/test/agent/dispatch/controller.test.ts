import { describe, expect, it } from 'vitest';

import {
  DISPATCH_MAX_ACTIVE_EDITING,
  DISPATCH_MAX_NEW_SPAWNS_PER_TURN,
  DispatchController,
} from '../../../src/agent/dispatch/controller';

function editing(requestId: string, scope: string) {
  return { requestId, isEditingCapable: true, scope: [scope] } as const;
}

function readOnly(requestId: string) {
  return { requestId, isEditingCapable: false } as const;
}

function card(id: string, dependencies?: readonly string[]) {
  return {
    id,
    title: `Card ${id}`,
    goal: `Complete ${id}`,
    dependencies,
    acceptance: `${id} passes`,
  } as const;
}

describe('DispatchController', () => {
  it('reports the live queued count and change notifications', () => {
    const changes: number[] = [];
    const controller = new DispatchController({
      onQueuedCountChange: () => changes.push(controller.queuedCount),
    });
    controller.beginTurn('1');
    const started = Array.from({ length: DISPATCH_MAX_ACTIVE_EDITING }, (_, index) =>
      controller.reserve(editing(`coder-${String(index)}`, `src/${String(index)}`)),
    );
    const queued = controller.reserve(editing('coder-queued', 'src/queued'));
    expect(queued).toMatchObject({ kind: 'queued' });
    expect(controller.queuedCount).toBe(1);
    expect(changes).toEqual([1]);

    if (queued.kind !== 'queued' || started[0]?.kind !== 'started') throw new Error('bad fixture');
    controller.release(started[0].reservationId, 'completed');
    expect(controller.queuedCount).toBe(0);
    expect(changes).toEqual([1, 0]);
  });

  it('rejects an editing spawn without scope', () => {
    const controller = new DispatchController();
    controller.beginTurn('1');

    expect(controller.reserve({ requestId: 'coder-1', isEditingCapable: true })).toMatchObject({
      kind: 'rejected',
      reason: 'malformed-scope',
    });
  });

  it('rejects overlapping editing reservations and releases ownership', () => {
    const controller = new DispatchController();
    controller.beginTurn('1');
    const first = controller.reserve(editing('coder-1', 'src/agent'));
    expect(first.kind).toBe('started');
    expect(controller.reserve(editing('coder-2', 'src/agent/index.ts'))).toMatchObject({
      kind: 'rejected',
      reason: 'scope-overlap',
    });

    if (first.kind !== 'started') throw new Error('expected started reservation');
    controller.release(first.reservationId, 'completed');
    expect(controller.reserve(editing('coder-3', 'src/agent/index.ts')).kind).toBe('started');
  });

  it('queues editing work above the concurrency limit and promotes on release', async () => {
    const controller = new DispatchController();
    controller.beginTurn('1');
    const started = Array.from({ length: DISPATCH_MAX_ACTIVE_EDITING }, (_, index) =>
      controller.reserve(editing(`coder-${String(index)}`, `src/${String(index)}`)),
    );
    const queued = controller.reserve(editing('coder-queued', 'src/queued'));
    expect(queued.kind).toBe('queued');
    if (queued.kind !== 'queued' || started[0]?.kind !== 'started') throw new Error('bad fixture');

    const promoted = controller.waitUntilStarted(queued.reservationId);
    controller.release(started[0].reservationId, 'completed');
    await expect(promoted).resolves.toBe('started');
  });

  it('resets the per-turn spawn budget after active capacity is released', async () => {
    const controller = new DispatchController();
    controller.beginTurn('1');
    const firstTurn = Array.from({ length: DISPATCH_MAX_NEW_SPAWNS_PER_TURN }, (_, index) =>
      controller.reserve(readOnly(`read-${String(index)}`)),
    );
    expect(firstTurn.every((decision) => decision.kind === 'started')).toBe(true);
    const queued = controller.reserve(readOnly('read-queued'));
    expect(queued.kind).toBe('queued');
    if (queued.kind !== 'queued') throw new Error('bad fixture');

    for (const decision of firstTurn) {
      if (decision.kind === 'started') controller.release(decision.reservationId, 'completed');
    }
    const promoted = controller.waitUntilStarted(queued.reservationId);
    controller.beginTurn('2');
    await expect(promoted).resolves.toBe('started');
  });

  it('queues work cards behind dependencies and starts them after completion', async () => {
    const controller = new DispatchController();
    controller.beginTurn('1');
    const first = controller.reserve({
      ...editing('coder-a', 'src/a.ts'),
      workCard: card('a'),
      displayProfile: 'coder',
    });
    expect(first).toMatchObject({ kind: 'started', displayName: 'coder#1' });
    const dependent = controller.reserve({
      ...editing('coder-b', 'src/b.ts'),
      workCard: card('b', ['a']),
      displayProfile: 'coder',
    });
    expect(dependent).toMatchObject({ kind: 'queued', displayName: 'coder#2' });
    if (first.kind !== 'started' || dependent.kind !== 'queued') throw new Error('bad fixture');

    const promoted = controller.waitUntilStarted(dependent.reservationId);
    controller.release(first.reservationId, 'completed');
    await expect(promoted).resolves.toBe('started');
  });

  it('does not start dependents after a dependency fails', async () => {
    const controller = new DispatchController();
    controller.beginTurn('1');
    const first = controller.reserve({
      ...editing('coder-failed', 'src/failed.ts'),
      workCard: card('failed'),
    });
    const dependent = controller.reserve({
      ...editing('coder-dependent', 'src/dependent.ts'),
      workCard: card('dependent', ['failed']),
    });
    expect(first.kind).toBe('started');
    expect(dependent.kind).toBe('queued');
    if (first.kind !== 'started' || dependent.kind !== 'queued') throw new Error('bad fixture');

    const waiting = controller.waitUntilStarted(dependent.reservationId);
    controller.release(first.reservationId, 'failed');
    await expect(waiting).resolves.toBe('dependency-failed');
  });

  it('serializes overlapping work-card scopes and reuses released display slots', async () => {
    const controller = new DispatchController();
    controller.beginTurn('1');
    const first = controller.reserve({
      ...editing('coder-a', 'src/agent'),
      workCard: card('a'),
      displayProfile: 'coder',
    });
    const overlap = controller.reserve({
      ...editing('coder-b', 'src/agent/index.ts'),
      workCard: card('b'),
      displayProfile: 'coder',
    });
    expect(first).toMatchObject({ kind: 'started', displayName: 'coder#1' });
    expect(overlap).toMatchObject({ kind: 'queued', displayName: 'coder#2' });
    if (first.kind !== 'started' || overlap.kind !== 'queued') throw new Error('bad fixture');

    const promoted = controller.waitUntilStarted(overlap.reservationId);
    controller.release(first.reservationId, 'completed');
    await expect(promoted).resolves.toBe('started');
    const third = controller.reserve({
      ...editing('coder-c', 'src/other.ts'),
      workCard: card('c'),
      displayProfile: 'coder',
    });
    expect(third).toMatchObject({ kind: 'started', displayName: 'coder#1' });
  });

  it('rejects duplicate, self-dependent, and unknown-dependency work cards', () => {
    const controller = new DispatchController();
    controller.beginTurn('1');
    expect(
      controller.reserve({ ...editing('self', 'src/self.ts'), workCard: card('self', ['self']) }),
    ).toMatchObject({ kind: 'rejected', reason: 'invalid-work-card' });
    expect(
      controller.reserve({ ...editing('unknown', 'src/u.ts'), workCard: card('u', ['missing']) }),
    ).toMatchObject({ kind: 'rejected', reason: 'invalid-work-card' });
    expect(controller.reserve({ ...editing('a', 'src/a.ts'), workCard: card('a') }).kind).toBe(
      'started',
    );
    expect(
      controller.reserve({ ...editing('a2', 'src/a2.ts'), workCard: card('a') }),
    ).toMatchObject({ kind: 'rejected', reason: 'duplicate-work-card' });
  });

  it('rejects a work-card scope that enters forbidden scope', () => {
    const controller = new DispatchController();
    controller.beginTurn('1');
    expect(
      controller.reserve({
        ...editing('forbidden', 'src/secret.ts'),
        workCard: { ...card('forbidden'), forbiddenScope: ['src/secret.ts'] },
      }),
    ).toMatchObject({ kind: 'rejected', reason: 'invalid-work-card' });
  });

  it.each(['coder-ex', 'reviewer'] as const)('permits only one %s cycle per logical scope', (escalation) => {
    const controller = new DispatchController();
    controller.beginTurn('1');
    const first = controller.reserve({
      requestId: `${escalation}-1`,
      isEditingCapable: escalation === 'coder-ex',
      scope: escalation === 'coder-ex' ? ['src/a.ts'] : undefined,
      escalation,
      logicalScopeKey: 'src/a.ts',
    });
    expect(first.kind).toBe('started');
    if (first.kind !== 'started') throw new Error('bad fixture');
    controller.release(first.reservationId, 'completed');

    expect(
      controller.reserve({
        requestId: `${escalation}-2`,
        isEditingCapable: escalation === 'coder-ex',
        scope: escalation === 'coder-ex' ? ['src/a.ts'] : undefined,
        escalation,
        logicalScopeKey: 'src/a.ts',
      }),
    ).toMatchObject({ kind: 'rejected', reason: 'cycle-exhausted' });
  });
});
