import { sql, type Transaction } from 'kysely';
import type { DB, VsDatabase } from '@vs/db';
import type { Actor } from '@vs/shared';
import { audit } from './audit';
import { availabilityChanged, lockBuckets, openException, type EngineContext } from './internal';

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
 * Rule 6: for each violation, opens one critical `invariant` exception (not duplicated while
 * open) and stops sales on the leg × category it concerns. Returns the number of new exceptions.
 */
export async function recordInvariantViolations(
  tx: Transaction<DB>,
  operatorId: string,
  actor: Actor,
  violations: InvariantViolation[],
): Promise<number> {
  const ctx = { operatorId, actor };
  let opened = 0;
  const stops = new Map<string, { legId: string; categoryId: string }>();
  for (const violation of violations) {
    const detail = (violation.detail ?? {}) as { leg_id?: string; category_id?: string };
    if (detail.leg_id && detail.category_id) {
      stops.set(`${detail.leg_id}|${detail.category_id}`, {
        legId: detail.leg_id,
        categoryId: detail.category_id,
      });
    }
    const id = await openException(tx, ctx, {
      kind: 'invariant',
      severity: 'critical',
      summary: `Invariant ${violation.invariant} violated on ${violation.entity}`,
      refs: violation.entity_id ? [{ entity: violation.entity, id: violation.entity_id }] : [],
      details: { invariant: violation.invariant, detail: violation.detail },
      dedupeKey: `invariant:${violation.invariant}:${violation.entity}:${violation.entity_id ?? '-'}`,
    });
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
  await stopSalesOnViolations(tx, ctx, [...stops.values()]);
  return opened;
}

/** Stops sales on the pool bucket of each violated leg × category (locked in the global order). */
async function stopSalesOnViolations(
  tx: Transaction<DB>,
  ctx: EngineContext,
  targets: { legId: string; categoryId: string }[],
): Promise<void> {
  if (targets.length === 0) return;
  const pools = (
    await lockBuckets(tx, {
      legIds: [...new Set(targets.map((t) => t.legId))],
      categoryIds: [...new Set(targets.map((t) => t.categoryId))],
      kind: 'pool',
    })
  ).filter(
    (pool) =>
      !pool.stop_sale &&
      targets.some((t) => t.legId === pool.leg_id && t.categoryId === pool.category_id),
  );
  for (const pool of pools) {
    await tx
      .updateTable('inventory_bucket')
      .set({ stop_sale: true, stop_reason: 'invariant' })
      .where('id', '=', pool.id)
      .execute();
  }
  await availabilityChanged(
    tx,
    ctx,
    pools.map((pool) => pool.id),
    'invariant.violation',
  );
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
