/**
 * Field names whose values must never reach logs, audit diffs, events or webhook payloads
 * (rule 9). Matching ignores case, underscores and hyphens and looks for these words anywhere in
 * the name, so `passport_number`, `passportCountry`, `visa_ciphertext`, `medical_notes`,
 * `allergies`, `client_secret` and `X-Api-Key` are all caught.
 */
const SENSITIVE_PARTS = [
  'passport',
  'visa',
  'medical',
  'allerg',
  'ciphertext',
  'dateofbirth',
  'birthdate',
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
] as const;
/** Too short to look for inside other words: matched as the whole name. */
const SENSITIVE_EXACT = new Set(['dob']);

export const REDACTED = '[REDACTED]';

function normalise(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const name = normalise(key);
  return SENSITIVE_EXACT.has(name) || SENSITIVE_PARTS.some((part) => name.includes(part));
}

/**
 * Error text without the values in it: Postgres quotes the offending value in its messages
 * (`invalid input syntax for type uuid: "…"`, `Key (email)=(…)`), and any message may carry an
 * email address.
 */
export function scrubErrorText(text: string, fromDatabase = false): string {
  let out = text.replace(/[^\s@"'()]+@[^\s@"'()]+\.[^\s@"'()]+/g, '[email]');
  if (fromDatabase)
    out = out.replace(/"[^"]*"/g, '"[REDACTED]"').replace(/=\([^)]*\)/g, '=([REDACTED])');
  return out;
}

/** A Postgres error (node-postgres DatabaseError): a five-character SQLSTATE code. */
export function isDatabaseError(error: unknown): error is Error & { code: string } {
  const code: unknown = error instanceof Error ? (error as Error & { code?: unknown }).code : null;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

/** Returns a deep copy with every sensitive field's value replaced by `[REDACTED]`. */
export function redactDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return '[Circular]' as T;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, seen)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactDeep(inner, seen);
  }
  return out as T;
}
