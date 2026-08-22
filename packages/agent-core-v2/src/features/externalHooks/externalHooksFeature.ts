import { ScopeActivation } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './configSection';
import { IAgentExternalHooksService } from './agent/agentExternalHooks';
import { AgentExternalHooksService } from './agent/agentExternalHooksService';
import { IAgentSessionStartInjectionService } from './agent/sessionStartInjection';
import { AgentSessionStartInjectionService } from './agent/sessionStartInjectionService';
import { IExternalHooksRunnerService } from './app/externalHooksRunner';
import { ExternalHooksRunnerService } from './app/externalHooksRunnerService';
import { ISessionExternalHooksService } from './session/sessionExternalHooks';
import { SessionExternalHooksService } from './session/sessionExternalHooksService';

export class ExternalHooksFeature extends Feature {
  static override readonly name = 'externalHooks';

  constructor() {
    super();
    this.contributeService(
      LifecycleScope.App,
      IExternalHooksRunnerService,
      ExternalHooksRunnerService,
    );
    this.contributeService(
      LifecycleScope.Session,
      ISessionExternalHooksService,
      SessionExternalHooksService,
    );
    this.contributeAgentService(IAgentExternalHooksService, AgentExternalHooksService);
    this.contributeAgentService(
      IAgentSessionStartInjectionService,
      AgentSessionStartInjectionService,
      { activation: ScopeActivation.OnScopeCreated },
    );
  }
}

registerFeature(ExternalHooksFeature);
