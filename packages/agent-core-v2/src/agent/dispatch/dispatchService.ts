import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  type DispatchMode,
  type DispatchModeChangedContext,
  IAgentDispatchModeService,
} from './dispatch';
import { DispatchModeSet, dispatchModeConfiguredKey, dispatchModeKey } from './dispatchOps';

export class AgentDispatchModeService extends Disposable implements IAgentDispatchModeService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChangeMode = this._register(new Emitter<DispatchModeChangedContext>());
  readonly onDidChangeMode: Event<DispatchModeChangedContext> = this._onDidChangeMode.event;

  constructor(
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
  ) {
    super();
    this.states.contributeState(dispatchModeKey);
    this.states.contributeState(dispatchModeConfiguredKey);
  }

  get mode(): DispatchMode {
    return this.states.get(dispatchModeKey);
  }

  setMode(mode: DispatchMode): void {
    const previousMode = this.mode;
    const changed = mode !== previousMode;
    if (!changed && this.states.get(dispatchModeConfiguredKey)) return;
    void this.dispatcher.dispatch(new DispatchModeSet({ mode }));
    if (changed) this._onDidChangeMode.fire({ mode, previousMode });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentDispatchModeService,
  AgentDispatchModeService,
  ScopeActivation.OnScopeCreated,
  'dispatch',
);
