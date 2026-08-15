/**
 * `agentsMdReminder` domain — AGENTS.md discovery-reminder contract.
 *
 * Defines the `IAgentAgentsMdReminderService`, the seed side of the domain:
 * `profile` reports the AGENTS.md paths it injected into the system prompt
 * (on every profile apply, with the agent's effective cwd), and `sessionInit`
 * re-seeds after `/init` regenerates the file, so the reminder hook can tell
 * "already injected" apart from newly discovered instruction files. `profile`
 * also reports whether the bound model runs in `minimal_mode`, whose prompt
 * carries no workspace instructions at all: without suppression the seed would
 * be empty, every AGENTS.md the agent walks past would read as newly
 * discovered, and the reminder would put back the very text the mode removed.
 * Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentAgentsMdReminderService {
  readonly _serviceBrand: undefined;

  seedInjected(paths: readonly string[], cwd: string): void;
}

export const IAgentAgentsMdReminderService: ServiceIdentifier<IAgentAgentsMdReminderService> =
  createDecorator<IAgentAgentsMdReminderService>('agentAgentsMdReminderService');
