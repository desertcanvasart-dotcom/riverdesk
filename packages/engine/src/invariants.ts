import { sql, type Transaction } from 'kysely';
import type { DB, VsDatabase } from '@vs/db';
import type { Actor } from '@vs/shared';
import { audit } from './audit';

export interface InvariantViolation {
  operator_id: string;
  invariant: number;
  entity: string;
  entity_id: string | null;
  detail: unknown;
}

/** vs.check_invariants() for the transaction's tenant (RLS limits it to one operator). */
export async function checkInvariants(tx: Transaction<DB>): Promise<InvariantViolation[]> {
  const { rows } = await sql<InvariantViolation>`select * from vs.check_invariants()`.execute(tx);
  return rows;
}

/**
 * Opens one critical `invariant` exception per violation. A violation that already has an open
 * exception is not duplicated (dedupe key). Returns the number of new exceptions.
 *
 * Stopping sales on the affected leg × category is added in Batch 1, when buckets exist.
 */
export async function recordInvariantViolations(
  tx: Transaction<DB>,
  operatorId: string,
  actor: Actor,
  violations: InvariantViolation[],
): Promise<number> {
  let opened = 0;
  for (const violation of violations) {
    const dedupeKey = `invariant:${violation.invariant}:${violation.entity}:${violation.entity_id ?? '-'}`;
    const { rows } = await sql<{ id: string }>`
      insert into vs.exception (operator_id, kind, severity, summary, refs, details, dedupe_key)
      values (
        ${operatorId}, 'invariant', 'critical',
        ${`Invariant ${violation.invariant} violated on ${violation.entity}`},
        ${JSON.stringify(violation.entity_id ? [{ entity: violation.entity, id: violation.entity_id }] : [])}::jsonb,
        ${JSON.stringify({ invariant: violation.invariant, detail: violation.detail })}::jsonb,
        ${dedupeKey}
      )
      on conflict (operator_id, dedupe_key) where dedupe_key is not null and status in ('open', 'acknowledged')
      do nothing
      returning id`.execute(tx);
    const id = rows[0]?.id;
    if (!id) continue;
    opened += 1;
    await audit(tx, operatorId, actor, {
      action: 'exception.opened',
      entity: 'exception',
      entityId: id,
      after: {
        kind: 'invariant',
        invariant: violation.invariant,
        entity: violation.entity,
        entity_id: violation.entity_id,
      },
    });
  }
  return opened;
}

/** Operator ids for jobs that process every tenant (worker only, via vs.list_operator_ids). */
export async function listOperatorIds(db: VsDatabase): Promise<string[]> {
  const { rows } = await db.withLookupTx((tx) =>
    sql<{ id: string }>`select id from vs.list_operator_ids() as id`.execute(tx),
  );
  return rows.map((row) => row.id);
}

export interface InvariantRunResult {
  operatorId: string;
  violations: number;
  opened: number;
}

/** The nightly reconciliation: check every operator in its own tenant transaction. */
export async function runInvariantChecks(
  db: VsDatabase,
  actor: Actor,
): Promise<InvariantRunResult[]> {
  const results: InvariantRunResult[] = [];
  for (const operatorId of await listOperatorIds(db)) {
    results.push(
      await db.withTenantTx(operatorId, actor, async ({ db: tx }) => {
        const violations = await checkInvariants(tx);
        const opened = await recordInvariantViolations(tx, operatorId, actor, violations);
        return { operatorId, violations: violations.length, opened };
      }),
    );
  }
  return results;
}
