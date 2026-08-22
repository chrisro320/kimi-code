import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentSessionStartInjectionService {
  readonly _serviceBrand: undefined;
}

export const IAgentSessionStartInjectionService: ServiceIdentifier<IAgentSessionStartInjectionService> =
  createDecorator<IAgentSessionStartInjectionService>('agentSessionStartInjectionService');
