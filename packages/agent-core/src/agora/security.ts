import type { AgoraPeerPacket } from './types';

export interface AgoraPacketSecurityResult {
  readonly blocked: readonly string[];
  readonly requiresConfirmation: readonly string[];
}

const BLOCKED_FILE_PATTERNS: readonly RegExp[] = [
  /(^|[/\\])\.env(?:\.[^/\\\s]+)?($|[/\\\s])/i,
  /(^|[/\\])(id_rsa|id_ed25519|credentials\.json|service-account\.json)($|[/\\\s])/i,
  /(^|[/\\])\.npmrc($|[/\\\s])/i,
];

const BLOCKED_SECRET_PATTERNS: readonly [string, RegExp][] = [
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['API secret', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['bearer credential', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i],
];

const AMBIGUOUS_SECRET_PATTERNS: readonly [string, RegExp][] = [
  ['password-like assignment', /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i],
  ['token-like assignment', /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+/i],
];

function packetStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(packetStrings);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(packetStrings);
  }
  return [];
}

export function scanAgoraPacket(packet: AgoraPeerPacket): AgoraPacketSecurityResult {
  const blocked = new Set<string>();
  const requiresConfirmation = new Set<string>();
  for (const text of packetStrings(packet)) {
    if (BLOCKED_FILE_PATTERNS.some((pattern) => pattern.test(text))) {
      blocked.add('known sensitive file reference');
    }
    for (const [label, pattern] of BLOCKED_SECRET_PATTERNS) {
      if (pattern.test(text)) blocked.add(label);
    }
    for (const [label, pattern] of AMBIGUOUS_SECRET_PATTERNS) {
      if (pattern.test(text)) requiresConfirmation.add(label);
    }
  }
  return { blocked: [...blocked], requiresConfirmation: [...requiresConfirmation] };
}
