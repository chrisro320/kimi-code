/**
 * Workspace-relative dispatch-scope normalization shared by the Agent/AgentSwarm
 * tool-input validation and the DispatchController's scope reservation. A
 * scope entry is a file, directory, or glob path relative to the repository
 * root; overlap uses each entry's static (non-glob) prefix so an ambiguous
 * glob conflicts rather than being assumed safe.
 */

const GLOB_METACHARACTERS = /[*?[\]{}]/;
const WINDOWS_DRIVE = /^[a-zA-Z]:[/\\]/;

export type ScopeValidationErrorCode = 'malformed' | 'outside-repo';

export interface ScopeValidationError {
  readonly ok: false;
  readonly error: ScopeValidationErrorCode;
  readonly message: string;
}

export interface ScopeValidationSuccess {
  readonly ok: true;
  readonly value: string;
}

export type ScopeEntryResult = ScopeValidationSuccess | ScopeValidationError;

/** Normalize one declared scope entry, or report why it is rejected. */
export function normalizeScopeEntry(raw: string): ScopeEntryResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'malformed', message: 'Scope entry must not be empty.' };
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('~') || WINDOWS_DRIVE.test(trimmed)) {
    return {
      ok: false,
      error: 'malformed',
      message: `Scope entry "${raw}" must be workspace-relative, not absolute.`,
    };
  }
  const normalized = trimmed.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const cleaned: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      return {
        ok: false,
        error: 'outside-repo',
        message: `Scope entry "${raw}" escapes the workspace root ("..").`,
      };
    }
    if (segment.toLowerCase() === '.git') {
      return {
        ok: false,
        error: 'malformed',
        message: `Scope entry "${raw}" targets VCS metadata (".git").`,
      };
    }
    cleaned.push(segment);
  }
  if (cleaned.length === 0) {
    return { ok: false, error: 'malformed', message: `Scope entry "${raw}" is empty after normalization.` };
  }
  return { ok: true, value: cleaned.join('/') };
}

export type ScopeListResult =
  | { readonly ok: true; readonly value: readonly string[] }
  | ScopeValidationError;

/** Normalize a full scope list, failing on the first invalid entry. */
export function normalizeScopeList(raw: readonly string[]): ScopeListResult {
  const normalized: string[] = [];
  for (const entry of raw) {
    const result = normalizeScopeEntry(entry);
    if (!result.ok) return result;
    normalized.push(result.value);
  }
  return { ok: true, value: normalized };
}

/** The literal path portion before the first glob metacharacter, trimmed to a whole segment. */
function staticPrefix(path: string): string {
  const metaIndex = path.search(GLOB_METACHARACTERS);
  if (metaIndex === -1) return path;
  const upToMeta = path.slice(0, metaIndex);
  const lastSlash = upToMeta.lastIndexOf('/');
  return lastSlash === -1 ? '' : upToMeta.slice(0, lastSlash);
}

function entriesOverlap(a: string, b: string): boolean {
  const prefixA = staticPrefix(a);
  const prefixB = staticPrefix(b);
  // An ambiguous (root-level) glob is treated as conflicting with anything.
  if (prefixA === '' || prefixB === '') return true;
  if (prefixA === prefixB) return true;
  return prefixA.startsWith(`${prefixB}/`) || prefixB.startsWith(`${prefixA}/`);
}

/** True when any entry in `a` conflicts with any entry in `b` (directory ownership included). */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const entryA of a) {
    for (const entryB of b) {
      if (entriesOverlap(entryA, entryB)) return true;
    }
  }
  return false;
}
