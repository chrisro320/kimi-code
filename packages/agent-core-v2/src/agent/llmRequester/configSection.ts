/**
 * `llmRequester` domain — registers the `contextManager` config section
 * into `config`.
 *
 * Owns the engine-internal opt-in switch for the request-time context
 * manager: the section value is the registered manager's `id`, and an unset
 * section means the transform path stays disabled (zero-cost passthrough).
 * Engine-internal only — not part of the v2 SDK config surface.
 * Self-registered at module load via `registerConfigSection`, so the
 * `config` domain never imports this domain's types.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const CONTEXT_MANAGER_SECTION = 'contextManager';

export const ContextManagerSectionSchema = z.string();

registerConfigSection(CONTEXT_MANAGER_SECTION, ContextManagerSectionSchema);
