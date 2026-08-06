/**
 * `dispatch` domain — `IAgentDispatchModeService` implementation.
 *
 * Holds the agent's dispatch mode (`auto` / `ask` / `off`) in the `wire`
 * `DispatchModeModel`, mutating it only through the `dispatch_mode.set` Op
 * (`wire.dispatch(setMode({ mode }))`) and reading it through
 * `wire.getModel`. `setMode` emits `onDidChangeMode` after an actual change.
 * Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IWireService } from '#/wire/wire';

import {
  type DispatchMode,
  type DispatchModeChangedContext,
  IAgentDispatchModeService,
} from './dispatch';
import { DispatchModeConfiguredModel, DispatchModeModel, setMode } from './dispatchOps';

export class AgentDispatchModeService extends Disposable implements IAgentDispatchModeService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChangeMode = this._register(new Emitter<DispatchModeChangedContext>());
  readonly onDidChangeMode: Event<DispatchModeChangedContext> = this._onDidChangeMode.event;

  constructor(@IWireService private readonly wire: IWireService) {
    super();
  }

  get mode(): DispatchMode {
    return this.wire.getModel(DispatchModeModel);
  }

  setMode(mode: DispatchMode): void {
    const previousMode = this.mode;
    const changed = mode !== previousMode;
    if (!changed && this.wire.getModel(DispatchModeConfiguredModel)) return;
    this.wire.dispatch(setMode({ mode }));
    if (changed) this._onDidChangeMode.fire({ mode, previousMode });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentDispatchModeService,
  AgentDispatchModeService,
  ScopeActivation.OnDemand,
  'dispatch',
);
