/**
 * `skillCatalog` domain — registers the `compact-skill-listing` experimental
 * flag into `flag`.
 *
 * Gates the compact rendering of the model-facing skill listing: one line
 * per skill (name + normalized, truncated description), without the
 * `When to use:` / `Path:` lines. Off by default; enable via
 * `KIMI_CODE_EXPERIMENTAL_COMPACT_SKILL_LISTING`, the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config section.
 * Imported for its side effect (registers the definition) from the package
 * barrel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const COMPACT_SKILL_LISTING_FLAG_ID = 'compact-skill-listing';
export const COMPACT_SKILL_LISTING_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_COMPACT_SKILL_LISTING';

export const compactSkillListingFlag: FlagDefinitionInput = {
  id: COMPACT_SKILL_LISTING_FLAG_ID,
  title: 'Compact skill listing',
  description:
    'Render a short, path-free catalog of invocable skills in the system prompt; selected skills still load their full instructions.',
  env: COMPACT_SKILL_LISTING_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(compactSkillListingFlag);
