/**
 * `dispatch` domain — editing-capability check for resolved profiles.
 * Ported from v1 `agent/dispatch/profile.ts`.
 */

import { isToolActive } from '#/agent/toolPolicy/evaluate';

const LEAN_CTX_PATCH_TOOL = 'mcp__lean-ctx__ctx_patch';

/** A profile can write through native edit tools or an MCP grant matching lean-ctx patch. */
export function isEditingCapableProfile(profile: { readonly tools: readonly string[] }): boolean {
  return (
    profile.tools.includes('Write') ||
    profile.tools.includes('Edit') ||
    isToolActive({ tools: profile.tools }, LEAN_CTX_PATCH_TOOL, 'mcp')
  );
}

/**
 * The same check against a catalog profile, whose tool list is optional: a
 * profile without an explicit one inherits the full default tool set, which
 * includes `Write`/`Edit` — editing-capable. Every caller reading a profile
 * out of the catalog must go through this, never `tools ?? []`.
 */
export function isEditingCapableCatalogProfile(
  profile: { readonly tools?: readonly string[] },
): boolean {
  return profile.tools === undefined || isEditingCapableProfile({ tools: profile.tools });
}
