import type { Transaction } from 'kysely';
import type { DB } from '@vs/db';
import { isSensitiveKey, redactDeep, type Actor } from '@vs/shared';

type Row = Record<string, unknown>;

/** JSON-safe copy: bigint → string, Date → ISO string. */
function toJson(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toJson(inner)]));
  }
  return value;
}

/**
 * Field-level diff between two versions of a record. Sensitive fields (rule 9) record only that
 * they changed, never a value; other values are deep-redacted as a second line of defence.
 */
export function buildDiff(before: Row | null | undefined, after: Row | null | undefined): Row {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const diff: Row = {};
  for (const key of [...keys].sort()) {
    if (key === 'updated_at' || key === 'created_at') continue;
    const from = toJson(before?.[key]);
    const to = toJson(after?.[key]);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    diff[key] = isSensitiveKey(key)
      ? { changed: true }
      : redactDeep({ from: from ?? null, to: to ?? null });
  }
  return diff;
}

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  before?: Row | null;
  after?: Row | null;
  requestKey?: string | null;
}

/** Writes one audit_log row in the caller's transaction (rule 11). */
export async function audit(
  tx: Transaction<DB>,
  operatorId: string,
  actor: Actor,
  entry: AuditEntry,
): Promise<void> {
  await tx
    .insertInto('audit_log')
    .values({
      operator_id: operatorId,
      actor_type: actor.type,
      actor_id: actor.type === 'system' ? null : actor.id,
      actor_label: actor.label ?? null,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId ?? null,
      diff: JSON.stringify(buildDiff(entry.before, entry.after)),
      request_key: entry.requestKey ?? null,
    })
    .execute();
}
