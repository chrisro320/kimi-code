/**
 * `dispatch` domain — editing-capability check for resolved profiles.
 * Ported from v1 `agent/dispatch/profile.ts`.
 */

/** A profile can write when its tool set includes `Write` or `Edit`. */
export function isEditingCapableProfile(profile: { readonly tools: readonly string[] }): boolean {
  return profile.tools.includes('Write') || profile.tools.includes('Edit');
}
