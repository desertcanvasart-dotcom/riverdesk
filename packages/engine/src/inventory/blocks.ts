import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import {
  availabilityChanged,
  legCommitments,
  lockBuckets,
  openException,
  parseInput,
  recordInventoryEvents,
  type BucketDelta,
  type EngineContext,
  type LockedBucket,
  type Tx,
} from '../internal';

export type StopReason = 'manual' | 'emergency_block' | 'invariant';

export const blockCabinsInput = z.object({
  legIds: z.array(z.uuid()).min(1).max(400),
  categoryId: z.uuid(),
  count: z.number().int().min(1).max(500),
  reason: z.string().min(1).max(500),
  /** Optional specific cabin (count must be 1). It is recorded; cabin numbers are assigned later. */
  cabinId: z.uuid().optional(),
});

type BlockInput = z.infer<typeof blockCabinsInput>;

/** Legs of one vessel, all open; and the category and cabin belong to that vessel. */
async function validateBlockTarget(tx: Tx, data: BlockInput) {
  const legs = await tx
    .selectFrom('leg')
    .select(['id', 'vessel_id', 'status', 'depart_date'])
    .where('id', 'in', data.legIds)
    .execute();
  if (legs.length !== new Set(data.legIds).size)
    throw new DomainError('NOT_FOUND', { message: 'Leg not found' });
  const vesselIds = new Set(legs.map((leg) => leg.vessel_id));
  if (vesselIds.size !== 1)
    throw new DomainError('VALIDATION_FAILED', { message: 'Legs must belong to one vessel' });
  if (legs.some((leg) => leg.status === 'cancelled')) {
    throw new DomainError('INVALID_STATE', { message: 'Cannot block cabins on a cancelled leg' });
  }
  const vesselId = legs[0]!.vessel_id;
  const category = await tx
    .selectFrom('cabin_category')
    .select('id')
    .where('id', '=', data.categoryId)
    .where('vessel_id', '=', vesselId)
    .executeTakeFirst();
  if (!category)
    throw new DomainError('NOT_FOUND', { message: 'Category not found on this vessel' });
  if (data.cabinId) {
    if (data.count !== 1)
      throw new DomainError('VALIDATION_FAILED', { message: 'A specific cabin blocks exactly 1' });
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from vs.leg l
      where l.id = any(${data.legIds}::uuid[])
        and exists (select from vs.cabin_period p
                    where p.cabin_id = ${data.cabinId} and p.category_id = ${data.categoryId}
                      and p.during @> l.depart_date)`.execute(tx);
    if (rows[0]!.n !== data.legIds.length) {
      throw new DomainError('VALIDATION_FAILED', {
        message: 'The cabin is not in that category on every leg',
      });
    }
  }
  return vesselId;
}

async function insertBlock(
  tx: Tx,
  ctx: EngineContext,
  vesselId: string,
  data: BlockInput,
  kind: 'normal' | 'emergency',
) {
  return tx
    .insertInto('cabin_block')
    .values({
      operator_id: ctx.operatorId,
      vessel_id: vesselId,
      category_id: data.categoryId,
      cabin_id: data.cabinId ?? null,
      kind,
      count: data.count,
      reason: data.reason,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function insertBlockBuckets(
  tx: Tx,
  ctx: EngineContext,
  vesselId: string,
  blockId: string,
  pools: LockedBucket[],
  count: number,
) {
  return tx
    .insertInto('inventory_bucket')
    .values(
      pools.map((pool) => ({
        operator_id: ctx.operatorId,
        vessel_id: vesselId,
        leg_id: pool.leg_id,
        category_id: pool.category_id,
        kind: 'block',
        block_id: blockId,
        total: count,
      })),
    )
    .returning(['id', 'leg_id', 'category_id'])
    .execute();
}

async function lockPools(tx: Tx, legIds: string[], categoryId: string) {
  const pools = await lockBuckets(tx, { legIds, categoryIds: [categoryId], kind: 'pool' });
  if (pools.length !== new Set(legIds).size)
    throw new DomainError('NOT_FOUND', { message: 'Pool bucket missing on a leg' });
  return pools;
}

/** Moves cabins from the pool to a block bucket on each leg, only from free cabins. */
export async function blockCabins(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof blockCabinsInput>,
) {
  const data = parseInput(blockCabinsInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const vesselId = await validateBlockTarget(tx, data);
    const block = await insertBlock(tx, ctx, vesselId, data, 'normal');
    const pools = await lockPools(tx, data.legIds, data.categoryId);

    const deltas: BucketDelta[] = [];
    for (const pool of pools) {
      const updated = await sql`
        update vs.inventory_bucket set total = total - ${data.count}
        where id = ${pool.id} and total - held - booked >= ${data.count}`.execute(tx);
      if (Number(updated.numAffectedRows ?? 0) !== 1) {
        throw new DomainError('NOT_AVAILABLE', {
          details: {
            legId: pool.leg_id,
            free: pool.total - pool.held - pool.booked,
            requested: data.count,
          },
        });
      }
      deltas.push({
        bucketId: pool.id,
        legId: pool.leg_id,
        categoryId: pool.category_id,
        total: -data.count,
      });
    }
    const blockBuckets = await insertBlockBuckets(tx, ctx, vesselId, block.id, pools, data.count);
    deltas.push(
      ...blockBuckets.map((b) => ({
        bucketId: b.id,
        legId: b.leg_id,
        categoryId: b.category_id,
        total: data.count,
      })),
    );

    await recordInventoryEvents(tx, ctx, deltas, 'block.created', {
      entity: 'cabin_block',
      id: block.id,
    });
    await availabilityChanged(
      tx,
      ctx,
      deltas.map((d) => d.bucketId),
      'block.created',
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'cabin_block.created',
      entity: 'cabin_block',
      entityId: block.id,
      after: { ...block, leg_ids: data.legIds },
    });
    return block;
  });
}

/**
 * Takes cabins out of service now, even beyond free. Where the pool is then over-committed, its
 * overcommit counter covers the excess, sales stop on that leg × category, and an
 * oversubscription exception lists the commitments staff must move.
 */
export async function emergencyBlock(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof blockCabinsInput>,
) {
  const data = parseInput(blockCabinsInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const vesselId = await validateBlockTarget(tx, data);
    const block = await insertBlock(tx, ctx, vesselId, data, 'emergency');
    const pools = await lockPools(tx, data.legIds, data.categoryId);

    const deltas: BucketDelta[] = [];
    const overcommitted: LockedBucket[] = [];
    for (const pool of pools) {
      if (pool.total < data.count) {
        throw new DomainError('VALIDATION_FAILED', {
          message: 'Cannot block more cabins than the pool has',
          details: { legId: pool.leg_id, poolTotal: pool.total },
        });
      }
      const newTotal = pool.total - data.count;
      const newOvercommit = Math.max(pool.overcommit, pool.held + pool.booked - newTotal, 0);
      const excess = newOvercommit - pool.overcommit;
      await sql`
        update vs.inventory_bucket
        set total = ${newTotal},
            overcommit = ${newOvercommit},
            stop_sale = stop_sale or ${newOvercommit > 0},
            stop_reason = case when ${newOvercommit > 0} and not stop_sale then 'emergency_block' else stop_reason end
        where id = ${pool.id}`.execute(tx);
      deltas.push({
        bucketId: pool.id,
        legId: pool.leg_id,
        categoryId: pool.category_id,
        total: -data.count,
        overcommit: excess,
      });
      if (newOvercommit > 0) overcommitted.push(pool);
    }
    const blockBuckets = await insertBlockBuckets(tx, ctx, vesselId, block.id, pools, data.count);
    deltas.push(
      ...blockBuckets.map((b) => ({
        bucketId: b.id,
        legId: b.leg_id,
        categoryId: b.category_id,
        total: data.count,
      })),
    );

    let exceptionId: string | null = null;
    if (overcommitted.length > 0) {
      const commitments = await legCommitments(
        tx,
        overcommitted.map((pool) => pool.leg_id),
      );
      exceptionId = await openException(tx, ctx, {
        kind: 'oversubscription',
        severity: 'critical',
        summary: `Emergency block of ${data.count} cabin(s) exceeds free capacity on ${overcommitted.length} leg(s)`,
        refs: [
          { entity: 'cabin_block', id: block.id },
          ...overcommitted.map((pool) => ({ entity: 'inventory_bucket', id: pool.id })),
          ...overcommitted.map((pool) => ({ entity: 'leg', id: pool.leg_id })),
        ],
        details: {
          reason: data.reason,
          // Bookings are listed here once they exist (Batch 3); until then, the counts.
          commitments: commitments.filter((c) => c.category_id === data.categoryId),
        },
      });
      await tx
        .updateTable('cabin_block')
        .set({ exception_id: exceptionId })
        .where('id', '=', block.id)
        .execute();
    }

    await recordInventoryEvents(tx, ctx, deltas, 'block.emergency', {
      entity: 'cabin_block',
      id: block.id,
    });
    await availabilityChanged(
      tx,
      ctx,
      deltas.map((d) => d.bucketId),
      'block.emergency',
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'cabin_block.emergency',
      entity: 'cabin_block',
      entityId: block.id,
      after: {
        ...block,
        exception_id: exceptionId,
        leg_ids: data.legIds,
        overcommitted_legs: overcommitted.length,
      },
    });
    return { ...block, exception_id: exceptionId };
  });
}

export const releaseBlockInput = z.object({ blockId: z.uuid() });

/** Returns a block's cabins to the pool. Happens once: the block row's guarded update decides. */
export async function releaseBlock(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof releaseBlockInput>,
) {
  const data = parseInput(releaseBlockInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const block = await tx
      .updateTable('cabin_block')
      .set({ status: 'released', released_at: sql<Date>`now()` })
      .where('id', '=', data.blockId)
      .where('status', '=', 'active')
      .returningAll()
      .executeTakeFirst();
    if (!block) {
      const exists = await tx
        .selectFrom('cabin_block')
        .select('status')
        .where('id', '=', data.blockId)
        .executeTakeFirst();
      throw exists
        ? new DomainError('INVALID_STATE', { message: 'The block is already released' })
        : new DomainError('NOT_FOUND', { message: 'Block not found' });
    }
    const blockBuckets = await tx
      .selectFrom('inventory_bucket')
      .select(['id', 'leg_id'])
      .where('block_id', '=', block.id)
      .execute();
    const legIds = blockBuckets.map((bucket) => bucket.leg_id);
    const locked = await lockBuckets(tx, {
      bucketIds: [
        ...blockBuckets.map((bucket) => bucket.id),
        ...(
          await tx
            .selectFrom('inventory_bucket')
            .select('id')
            .where('leg_id', 'in', legIds)
            .where('category_id', '=', block.category_id)
            .where('kind', '=', 'pool')
            .execute()
        ).map((bucket) => bucket.id),
      ],
    });

    const deltas: BucketDelta[] = [];
    for (const bucket of locked) {
      if (bucket.kind === 'block') {
        await sql`update vs.inventory_bucket set total = total - ${block.count} where id = ${bucket.id}`.execute(
          tx,
        );
        deltas.push({
          bucketId: bucket.id,
          legId: bucket.leg_id,
          categoryId: bucket.category_id,
          total: -block.count,
        });
      } else {
        const newTotal = bucket.total + block.count;
        const newOvercommit = Math.min(
          bucket.overcommit,
          Math.max(0, bucket.held + bucket.booked - newTotal),
        );
        const lift = newOvercommit === 0 && bucket.stop_reason === 'emergency_block';
        await sql`
          update vs.inventory_bucket
          set total = ${newTotal}, overcommit = ${newOvercommit},
              stop_sale = case when ${lift} then false else stop_sale end,
              stop_reason = case when ${lift} then null else stop_reason end
          where id = ${bucket.id}`.execute(tx);
        deltas.push({
          bucketId: bucket.id,
          legId: bucket.leg_id,
          categoryId: bucket.category_id,
          total: block.count,
          overcommit: newOvercommit - bucket.overcommit,
        });
      }
    }
    await resolveClearedOversubscriptions(
      tx,
      locked.filter((b) => b.kind === 'pool').map((b) => b.id),
    );

    await recordInventoryEvents(tx, ctx, deltas, 'block.released', {
      entity: 'cabin_block',
      id: block.id,
    });
    await availabilityChanged(
      tx,
      ctx,
      deltas.map((d) => d.bucketId),
      'block.released',
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'cabin_block.released',
      entity: 'cabin_block',
      entityId: block.id,
      before: { status: 'active' },
      after: { status: 'released' },
    });
    return block;
  });
}

/** Resolves open oversubscription exceptions whose buckets are no longer over-committed. */
export async function resolveClearedOversubscriptions(
  tx: Tx,
  poolBucketIds: string[],
): Promise<void> {
  if (poolBucketIds.length === 0) return;
  await sql`
    update vs.exception e
    set status = 'resolved', resolved_at = now(), resolution = 'Capacity restored'
    where e.kind = 'oversubscription' and e.status in ('open', 'acknowledged')
      and exists (
        select from jsonb_array_elements(e.refs) r
        where r->>'entity' = 'inventory_bucket' and (r->>'id')::uuid = any(${poolBucketIds}::uuid[]))
      and not exists (
        select from jsonb_array_elements(e.refs) r
        join vs.inventory_bucket b on b.id = (r->>'id')::uuid
        where r->>'entity' = 'inventory_bucket' and b.overcommit > 0)`.execute(tx);
}

export const setStopSaleInput = z.object({
  legIds: z.array(z.uuid()).min(1).max(400),
  /** Omit for every category on those legs. */
  categoryIds: z.array(z.uuid()).min(1).optional(),
  stop: z.boolean(),
  reason: z.string().min(1).max(500),
});

/**
 * Stops or resumes sales on pool buckets. Resuming is refused while a bucket is over-committed
 * (the emergency must be resolved first, invariant 3).
 */
export async function setStopSale(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof setStopSaleInput>,
) {
  const data = parseInput(setStopSaleInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const pools = await lockBuckets(tx, {
      legIds: data.legIds,
      categoryIds: data.categoryIds,
      kind: 'pool',
    });
    if (pools.length === 0)
      throw new DomainError('NOT_FOUND', { message: 'No pool buckets on those legs' });
    if (!data.stop) {
      const blocked = pools.filter((pool) => pool.overcommit > 0);
      if (blocked.length > 0) {
        throw new DomainError('INVALID_STATE', {
          message: 'Over-committed buckets stay stopped until the emergency is resolved',
          details: { bucketIds: blocked.map((pool) => pool.id) },
        });
      }
    }
    const changed = pools.filter((pool) => pool.stop_sale !== data.stop);
    for (const pool of changed) {
      await tx
        .updateTable('inventory_bucket')
        .set({ stop_sale: data.stop, stop_reason: data.stop ? 'manual' : null })
        .where('id', '=', pool.id)
        .execute();
    }
    await availabilityChanged(
      tx,
      ctx,
      changed.map((pool) => pool.id),
      data.stop ? 'stop_sale.on' : 'stop_sale.off',
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: data.stop ? 'stop_sale.set' : 'stop_sale.lifted',
      entity: 'leg',
      entityId: data.legIds.length === 1 ? data.legIds[0]! : null,
      after: {
        leg_ids: data.legIds,
        category_ids: data.categoryIds ?? 'all',
        reason: data.reason,
        buckets: changed.length,
      },
    });
    return { changed: changed.length };
  });
}
