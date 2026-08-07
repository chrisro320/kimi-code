/**
 * `dispatch` domain — editing-capability check for resolved profiles.
 * Ported from v1 `agent/dispatch/profile.ts`.
 */

/** A profile can write when its tool set includes `Write` or `Edit`. */
export function isEditingCapableProfile(profile: { readonly tools: readonly string[] }): boolean {
  return profile.tools.includes('Write') || profile.tools.includes('Edit');
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
