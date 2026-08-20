/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

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
import { defineState } from '#/state/state';
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
import { AgentEvent2 } from '#/app/event/event2';
import { unwrapErrorCause } from '#/errors';
import {
  IAgentLoopService,
  type LoopErrorContext,
} from '#/agent/loop/loop';
import { LOOP_CONTROL_SECTION, type LoopControl } from '#/agent/loop/configSection';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { IAgentStepRetryService } from './stepRetry';

export interface TurnStepRetryingPayload {
  readonly agentId: string;
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

export class TurnStepRetrying extends AgentEvent2<TurnStepRetryingPayload> {
  static override readonly type = 'turn.step.retrying';
  static override readonly observable = true;
}
export interface TurnStepRetrying extends TurnStepRetryingPayload {}

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

export class AgentStepRetryService extends Disposable implements IAgentStepRetryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLoopService private readonly loopService: IAgentLoopService,
    @IConfigService private readonly config: IConfigService,
    @IEventBus private readonly eventBus: IEventBus,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly states: IAgentStateService,
    // Ordering edge, not a real consumer: injecting the full-compaction
    // service forces its constructor (which registers the 'full-compaction'
    // loop error handler) to run before the `before: 'full-compaction'`
    // registration below.
    @IAgentFullCompactionService private readonly _fullCompactionOrdering: IAgentFullCompactionService,
  ) {
    super();
    this.states.contributeState(stepRetryLastFailedDriverIdKey);
    this.states.contributeState(stepRetryFailedAttemptsKey);
    this.states.contributeState(stepRetryCapacityAttemptsKey);
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
    this._register(this.eventBus.subscribe(TurnStarted, () => this.resetAttempts()));
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
    void this.dispatcher.dispatch(
      new TurnStepRetrying({
        agentId: this.scopeContext.agentId,
        turnId: context.turnId,
        step,
        stepId: context.stepId,
        failedAttempt: this.failedAttempts,
        nextAttempt: this.failedAttempts + 1,
        maxAttempts,
        delayMs,
        ...retryErrorFields(error),
      }),
    );
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
    void this.dispatcher.dispatch(
      new TurnStepRetrying({
        turnId: context.turnId,
        step,
        stepId: context.stepId,
        failedAttempt: this.capacityAttempts,
        nextAttempt: this.capacityAttempts + 1,
        maxAttempts: CAPACITY_RETRY_BUDGET + 1,
        delayMs,
        ...retryErrorFields(error),
      }),
    );
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
