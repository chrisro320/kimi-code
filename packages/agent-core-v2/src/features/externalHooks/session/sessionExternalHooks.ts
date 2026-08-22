import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionExternalHooksService {
  readonly _serviceBrand: undefined;

  /**
   * Rendered SessionStart hook output for this session, or `undefined` while no
   * hook has produced any — forked sessions never fire the event and so never
   * get one.
   */
  readonly sessionStartContext: string | undefined;
}

export const ISessionExternalHooksService: ServiceIdentifier<ISessionExternalHooksService> =
  createDecorator<ISessionExternalHooksService>('sessionExternalHooksService');
