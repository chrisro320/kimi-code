import { Disposable } from '#/_base/di/lifecycle';
import {
  IAgentContextInjectorService,
  type ContextInjectionContent,
  type ContextInjectionContext,
} from '#/agent/contextInjector/contextInjector';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';

import { ISessionExternalHooksService } from '../session/sessionExternalHooks';
import { IAgentSessionStartInjectionService } from './sessionStartInjection';

const SESSION_START_HOOK_INJECTION_VARIANT = 'session_start_hook';

const MAIN_AGENT_ID = 'main';

export class AgentSessionStartInjectionService
  extends Disposable
  implements IAgentSessionStartInjectionService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionExternalHooksService private readonly sessionHooks: ISessionExternalHooksService,
  ) {
    super();
    this._register(
      injector.register(SESSION_START_HOOK_INJECTION_VARIANT, (ctx) => this.injection(ctx)),
    );
  }

  private injection({
    injectedPositions,
  }: ContextInjectionContext): ContextInjectionContent | undefined {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return undefined;
    if (injectedPositions.length > 0) return undefined;
    const text = this.sessionHooks.sessionStartContext;
    if (text === undefined) return undefined;
    return { message: { role: 'user', content: [{ type: 'text', text }] } };
  }
}
