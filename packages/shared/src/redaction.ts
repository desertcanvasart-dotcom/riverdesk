/**
 * Field names whose values must never reach logs, audit diffs, events or webhook payloads
 * (rule 9). Matching ignores case, underscores and hyphens, so `passport_number`,
 * `passportNumber` and `Passport-Number` are all caught.
 */
const SENSITIVE_KEYS = [
  'passport',
  'passportnumber',
  'passportno',
  'dateofbirth',
  'dob',
  'birthdate',
  'password',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authorization',
  'cookie',
  'apikey',
  'passportkey',
  'privatekey',
] as const;

const SENSITIVE = new Set<string>(SENSITIVE_KEYS);

export const REDACTED = '[REDACTED]';

function normalise(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE.has(normalise(key));
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
