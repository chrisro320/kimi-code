/**
 * `stepRetry` domain — `IAgentStepRetryService` implementation.
 *
 * Loop error-recovery plugin: claims retryable provider failures (HTTP 429 /
 * 5xx, connection, timeout, empty response — `isRetryableGenerateError`) from
 * the loop's error-handler registry and re-enqueues the failed step's driver
 * at the head of the queue after exponential backoff (`retryBackoffDelays`).
 * Capacity rejections mislabeled as 401/403 context overflows take a separate
 * channel with a fixed 60-second cadence and an independent 10-minute budget
 * (`CAPACITY_RETRY_BUDGET` × `CAPACITY_RETRY_INTERVAL_MS`, counted by
 * `stepRetry.capacityAttempts`); when that budget is spent, `match` stops
 * claiming the error so overflow recovery (compaction) can take it. The loop
 * only learns that the error was caught; the retry rides the normal
 * step numbering and consumes `maxSteps` budget like any other step. Each
 * claimed failure publishes `turn.step.retrying`. Consecutive attempts are
 * counted per failed driver and reset when any step succeeds (`onDidFinishStep`)
 * or a new turn starts. The mutable retry state (`lastFailedDriverId`,
 * `failedAttempts`, `capacityAttempts`) is registered into `agentState`
 * (`IAgentStateService`) and read/written through it. Bound at Agent scope and
 * constructed with the scope so the handler registers before the first turn
 * runs.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  readRetryAfterMs,
  retryBackoffDelays,
  retryErrorFields,
  sleepForRetry,
} from '#/_base/utils/retry';
import { isCapacityMarkedContextOverflow, isRetryableGenerateError } from '#/kosong/contract/errors';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { unwrapErrorCause } from '#/errors';
import {
  IAgentLoopService,
  type LoopErrorContext,
} from '#/agent/loop/loop';
import { LOOP_CONTROL_SECTION, type LoopControl } from '#/agent/loop/configSection';
import { IAgentStateService } from '#/agent/state/agentState';

import { IAgentStepRetryService } from './stepRetry';

export interface TurnStepRetryingEvent {
  readonly type: 'turn.step.retrying';
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'turn.step.retrying': TurnStepRetryingEvent;
  }
}

export const stepRetryLastFailedDriverIdKey = defineState<string | undefined>(
  'stepRetry.lastFailedDriverId',
  () => undefined as string | undefined,
);
export const stepRetryFailedAttemptsKey = defineState<number>(
  'stepRetry.failedAttempts',
  () => 0,
);
export const stepRetryCapacityAttemptsKey = defineState<number>(
  'stepRetry.capacityAttempts',
  () => 0,
);

/**
 * Dedicated channel for capacity rejections mislabeled as 401/403 context
 * overflows (`isCapacityMarkedContextOverflow`). That fault recovers on a
 * minute scale, far beyond what the exponential curve covers (~2 minutes),
 * so it gets a fixed 60-second cadence and its own 10-minute budget —
 * 10 × 60s waits. Kept separate from `failedAttempts`/`maxAttempts` on
 * purpose: widening `loop_control.maxAttemptsPerStep` would also loosen
 * 429/5xx retries, recoupling the two channels this split exists to keep
 * apart. Once the budget is spent `match` stops claiming the error, so it
 * falls through to overflow recovery (compaction) instead of failing.
 */
export const CAPACITY_RETRY_INTERVAL_MS = 60_000;
export const CAPACITY_RETRY_BUDGET = 10;

// NOTE: stays Disposable — its own 'config' collides with the Fiber
export class AgentStepRetryService extends Disposable implements IAgentStepRetryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLoopService private readonly loopService: IAgentLoopService,
    @IConfigService private readonly config: IConfigService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(stepRetryLastFailedDriverIdKey);
    this.states.register(stepRetryFailedAttemptsKey);
    this.states.register(stepRetryCapacityAttemptsKey);
    this._register(
      this.loopService.registerLoopErrorHandler(
        {
          id: 'step-retry',
          match: (context) => {
            const error = unwrapErrorCause(context.error);
            if (!isRetryableGenerateError(error)) return false;
            // A spent capacity budget hands the error to overflow recovery
            // (compaction): `find` keeps walking the handler list only when no
            // earlier handler matches, so the exhaustion check lives here, not
            // in `handle` (returning false there would just fail the turn).
            if (
              isCapacityMarkedContextOverflow(error) &&
              this.capacityAttempts >= CAPACITY_RETRY_BUDGET
            ) {
              return false;
            }
            return true;
          },
          handle: (context) => this.recover(context),
        },
        // Capacity retries must claim before overflow recovery; a genuine
        // overflow never matches `step-retry`, so compaction is unaffected.
        { before: 'full-compaction' },
      ),
    );
    this._register(
      this.loopService.hooks.onDidFinishStep.register('step-retry', async (_ctx, next) => {
        this.resetAttempts();
        await next();
      }),
    );
    this._register(this.eventBus.subscribe('turn.started', () => this.resetAttempts()));
  }

  private get lastFailedDriverId(): string | undefined {
    return this.states.get(stepRetryLastFailedDriverIdKey);
  }

  private set lastFailedDriverId(value: string | undefined) {
    this.states.set(stepRetryLastFailedDriverIdKey, value);
  }

  private get failedAttempts(): number {
    return this.states.get(stepRetryFailedAttemptsKey);
  }

  private set failedAttempts(value: number) {
    this.states.set(stepRetryFailedAttemptsKey, value);
  }

  private get capacityAttempts(): number {
    return this.states.get(stepRetryCapacityAttemptsKey);
  }

  private set capacityAttempts(value: number) {
    this.states.set(stepRetryCapacityAttemptsKey, value);
  }

  private resetAttempts(): void {
    this.lastFailedDriverId = undefined;
    this.failedAttempts = 0;
    this.capacityAttempts = 0;
  }

  private async recover(context: LoopErrorContext): Promise<boolean> {
    const driver = context.failedDriver;
    const step = context.step;
    if (driver === undefined || step === undefined) return false;

    const error = unwrapErrorCause(context.error);
    if (isCapacityMarkedContextOverflow(error)) {
      return this.recoverCapacity(context, step, driver, error);
    }

    if (this.lastFailedDriverId !== driver.id) {
      this.lastFailedDriverId = driver.id;
      this.failedAttempts = 0;
    }
    this.failedAttempts += 1;

    const maxAttempts = Math.max(
      this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxAttemptsPerStep ??
        DEFAULT_MAX_RETRY_ATTEMPTS,
      1,
    );
    if (this.failedAttempts >= maxAttempts) {
      this.resetAttempts();
      return false;
    }

    const delayMs =
      readRetryAfterMs(error) ?? retryBackoffDelays(maxAttempts)[this.failedAttempts - 1] ?? 0;
    this.eventBus.publish({
      type: 'turn.step.retrying',
      turnId: context.turnId,
      step,
      stepId: context.stepId,
      failedAttempt: this.failedAttempts,
      nextAttempt: this.failedAttempts + 1,
      maxAttempts,
      delayMs,
      ...retryErrorFields(error),
    });
    await sleepForRetry(delayMs, context.signal);

    if (context.currentStep?.signal.aborted === true) return false;
    context.retry(driver, { at: 'head' });
    return true;
  }

  private async recoverCapacity(
    context: LoopErrorContext,
    step: number,
    driver: NonNullable<LoopErrorContext['failedDriver']>,
    error: unknown,
  ): Promise<boolean> {
    // `match` already turned away an exhausted budget; this guard is just the
    // defensive half of that contract.
    if (this.capacityAttempts >= CAPACITY_RETRY_BUDGET) return false;
    this.capacityAttempts += 1;

    const delayMs = CAPACITY_RETRY_INTERVAL_MS;
    this.eventBus.publish({
      type: 'turn.step.retrying',
      turnId: context.turnId,
      step,
      stepId: context.stepId,
      failedAttempt: this.capacityAttempts,
      nextAttempt: this.capacityAttempts + 1,
      maxAttempts: CAPACITY_RETRY_BUDGET + 1,
      delayMs,
      ...retryErrorFields(error),
    });
    await sleepForRetry(delayMs, context.signal);

    if (context.currentStep?.signal.aborted === true) return false;
    context.retry(driver, { at: 'head' });
    return true;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentStepRetryService,
  AgentStepRetryService,
  ScopeActivation.OnScopeCreated,
  'stepRetry',
);
