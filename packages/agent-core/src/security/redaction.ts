import { createHash } from 'node:crypto';

const SECRET_PATTERNS: readonly RegExp[] = [
  /(["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)(?:["']?)\s*[:=]\s*["']?[^\s"',}]{6,}/gi,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

function normalizeSecretKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replaceAll('-', '_').toLowerCase();
}

const SECRET_KEYS = /^(?:api_key|access_token|refresh_token|client_secret|password|authorization|credential|private_key|token|secret|credentials)$/;
const MAX_REDACTION_DEPTH = 32;

function redactString(value: string): { value: string; count: number } {
  let redacted = value;
  let count = 0;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      count += 1;
      const separator = match.match(/([:=])\s*["']?[^\s"',}]{6,}$/)?.[1];
      return separator === undefined ? '[REDACTED_SECRET]' : match.slice(0, match.indexOf(separator) + 1) + '[REDACTED_SECRET]';
    });
  }
  return { value: redacted, count };
}

/** Recursively sanitize untrusted structured data before persistence or output. */
export function redactUntrustedValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACTION_DEPTH) return '[REDACTED_DEPTH]';
  if (typeof value === 'string') return redactString(value).value;
  if (Array.isArray(value)) return value.map((entry) => redactUntrustedValue(entry, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_KEYS.test(normalizeSecretKey(key)) ? '[REDACTED_SECRET]' : redactUntrustedValue(entry, depth + 1),
    ]));
  }
  return value;
}

export interface RedactedRaw {
  readonly redacted: string;
  readonly summary: string;
  readonly redactionCount: number;
  readonly originalSha256: string;
  readonly redactedSha256: string;
}

/** Redact untrusted model/tool payloads before durable persistence. */
export function redactUntrustedRaw(raw: string): RedactedRaw {
  const redactedResult = redactString(raw);
  const redacted = redactedResult.value;
  const redactionCount = redactedResult.count;
  return {
    redacted,
    summary: redactionCount > 0
      ? `redacted ${String(redactionCount)} secret pattern(s)`
      : 'no secrets redacted',
    redactionCount,
    originalSha256: createHash('sha256').update(raw).digest('hex'),
    redactedSha256: createHash('sha256').update(redacted).digest('hex'),
  };
}
