import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import {
  availabilityChanged,
  lockBuckets,
  parseInput,
  recordInventoryEvents,
  type BucketDelta,
  type EngineContext,
  type Tx,
} from '../internal';

const cabinsByCategory = z
  .array(z.object({ categoryId: z.uuid(), cabins: z.number().int().min(1).max(200) }))
  .min(1);

export const createAllotmentInput = z.object({
  channelId: z.uuid(),
  vesselId: z.uuid(),
  legIds: z.array(z.uuid()).min(1).max(400),
  categories: cabinsByCategory,
  /** Unused cabins return to the pool this many days before each leg departs (00:00 Cairo). */
  releaseDays: z.number().int().min(0).max(400).optional(),
  notes: z.string().max(500).optional(),
});

/** Moves N free pool cabins into the allotment on each leg × category (pool total −= N). */
async function addToAllotment(
  tx: Tx,
  ctx: EngineContext,
  allotment: { id: string; vessel_id: string },
  legIds: string[],
  categories: { categoryId: string; cabins: number }[],
  cause: string,
) {
  const legs = await tx
    .selectFrom('leg')
    .select(['id', 'status', 'vessel_id'])
    .where('id', 'in', legIds)
    .execute();
  if (
    legs.length !== new Set(legIds).size ||
    legs.some((l) => l.vessel_id !== allotment.vessel_id)
  ) {
    throw new DomainError('NOT_FOUND', { message: 'Leg not found on this vessel' });
  }
  if (legs.some((l) => l.status !== 'open')) throw new DomainError('SAILING_CLOSED');
  const categoryIds = categories.map((c) => c.categoryId);
  // Allotment buckets start at 0 so they can be locked with the pools in the global order.
  await sql`
    insert into vs.inventory_bucket (operator_id, vessel_id, leg_id, category_id, kind, allotment_id, total)
    select ${ctx.operatorId}, ${allotment.vessel_id}, l, c, 'allotment', ${allotment.id}, 0
    from unnest(${legIds}::uuid[]) as l cross join unnest(${categoryIds}::uuid[]) as c
    on conflict (leg_id, allotment_id, category_id) where kind = 'allotment' do nothing`.execute(
    tx,
  );
  const locked = await lockBuckets(tx, { legIds, categoryIds });
  const deltas: BucketDelta[] = [];
  for (const { categoryId, cabins } of categories) {
    for (const legId of legIds) {
      const pool = locked.find(
        (b) => b.kind === 'pool' && b.leg_id === legId && b.category_id === categoryId,
      );
      const bucket = locked.find(
        (b) =>
          b.kind === 'allotment' &&
          b.leg_id === legId &&
          b.category_id === categoryId &&
          b.allotment_id === allotment.id,
      );
      if (!pool || !bucket) throw new DomainError('NOT_FOUND', { message: 'Bucket missing' });
      const moved = await sql`
        update vs.inventory_bucket set total = total - ${cabins}
        where id = ${pool.id} and total - held - booked >= ${cabins}`.execute(tx);
      if (Number(moved.numAffectedRows ?? 0) !== 1) {
        throw new DomainError('NOT_AVAILABLE', {
          details: {
            legId,
            categoryId,
            free: pool.total - pool.held - pool.booked,
            requested: cabins,
          },
        });
      }
      await sql`update vs.inventory_bucket set total = total + ${cabins} where id = ${bucket.id}`.execute(
        tx,
      );
      deltas.push(
        { bucketId: pool.id, legId, categoryId, total: -cabins },
        { bucketId: bucket.id, legId, categoryId, total: cabins },
      );
    }
  }
  await recordInventoryEvents(tx, ctx, deltas, cause, { entity: 'allotment', id: allotment.id });
  await availabilityChanged(
    tx,
    ctx,
    deltas.map((d) => d.bucketId),
    cause,
  );
}

export async function createAllotment(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createAllotmentInput>,
) {
  const data = parseInput(createAllotmentInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const settings = await tx
      .selectFrom('operator_setting')
      .select('allotment_release_days')
      .executeTakeFirstOrThrow();
    const allotment = await tx
      .insertInto('allotment')
      .values({
        operator_id: ctx.operatorId,
        channel_id: data.channelId,
        vessel_id: data.vesselId,
        release_days: data.releaseDays ?? settings.allotment_release_days,
        notes: data.notes ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await addToAllotment(tx, ctx, allotment, data.legIds, data.categories, 'allotment.created');
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'allotment.created',
      entity: 'allotment',
      entityId: allotment.id,
      after: { ...allotment, leg_ids: data.legIds, categories: data.categories },
    });
    return allotment;
  });
}

async function lockAllotment(tx: Tx, allotmentId: string) {
  const allotment = await tx
    .selectFrom('allotment')
    .selectAll()
    .where('id', '=', allotmentId)
    .forUpdate()
    .executeTakeFirst();
  if (!allotment) throw new DomainError('NOT_FOUND', { message: 'Allotment not found' });
  if (allotment.status !== 'active')
    throw new DomainError('INVALID_STATE', { message: 'The allotment is released' });
  return allotment;
}

export const extendAllotmentInput = z.object({
  allotmentId: z.uuid(),
  legIds: z.array(z.uuid()).min(1).max(400),
  categories: cabinsByCategory,
});

/** More cabins, or more legs, from free pool cabins. */
export async function extendAllotment(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof extendAllotmentInput>,
) {
  const data = parseInput(extendAllotmentInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const allotment = await lockAllotment(tx, data.allotmentId);
    const released = await tx
      .selectFrom('inventory_bucket')
      .select('id')
      .where('allotment_id', '=', allotment.id)
      .where('leg_id', 'in', data.legIds)
      .where('released_at', 'is not', null)
      .executeTakeFirst();
    if (released)
      throw new DomainError('INVALID_STATE', {
        message: 'A leg of this allotment is already released',
      });
    await addToAllotment(tx, ctx, allotment, data.legIds, data.categories, 'allotment.extended');
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'allotment.extended',
      entity: 'allotment',
      entityId: allotment.id,
      after: { leg_ids: data.legIds, categories: data.categories },
    });
    return allotment;
  });
}

export const reduceAllotmentInput = z.object({
  allotmentId: z.uuid(),
  legIds: z.array(z.uuid()).min(1).max(400),
  categoryId: z.uuid(),
  cabins: z.number().int().min(1).max(200),
});

/** Returns unused cabins to the pool early; refuses to take held or booked ones. */
export async function reduceAllotment(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof reduceAllotmentInput>,
) {
  const data = parseInput(reduceAllotmentInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const allotment = await lockAllotment(tx, data.allotmentId);
    const locked = await lockBuckets(tx, { legIds: data.legIds, categoryIds: [data.categoryId] });
    const deltas: BucketDelta[] = [];
    for (const legId of data.legIds) {
      const pool = locked.find((b) => b.kind === 'pool' && b.leg_id === legId);
      const bucket = locked.find(
        (b) => b.kind === 'allotment' && b.leg_id === legId && b.allotment_id === allotment.id,
      );
      if (!pool || !bucket)
        throw new DomainError('NOT_FOUND', { message: 'The allotment has no cabins on that leg' });
      const reduced = await sql`
        update vs.inventory_bucket set total = total - ${data.cabins}
        where id = ${bucket.id} and released_at is null and total - held - booked >= ${data.cabins}`.execute(
        tx,
      );
      if (Number(reduced.numAffectedRows ?? 0) !== 1) {
        throw new DomainError('NOT_AVAILABLE', {
          message: 'Only unused allotment cabins can be removed',
          details: { legId, unused: bucket.total - bucket.held - bucket.booked },
        });
      }
      await sql`update vs.inventory_bucket set total = total + ${data.cabins} where id = ${pool.id}`.execute(
        tx,
      );
      deltas.push(
        { bucketId: bucket.id, legId, categoryId: data.categoryId, total: -data.cabins },
        { bucketId: pool.id, legId, categoryId: data.categoryId, total: data.cabins },
      );
    }
    await recordInventoryEvents(tx, ctx, deltas, 'allotment.reduced', {
      entity: 'allotment',
      id: allotment.id,
    });
    await availabilityChanged(
      tx,
      ctx,
      deltas.map((d) => d.bucketId),
      'allotment.reduced',
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'allotment.reduced',
      entity: 'allotment',
      entityId: allotment.id,
      after: data,
    });
    return allotment;
  });
}

/**
 * Releases allotment buckets: unused = total − held − booked moves to the pool and the bucket
 * is marked released. Whoever locks the bucket second (a cancellation or hold expiry) sees the
 * flag and moves its unit to the pool itself, so capacity is counted once (spec test 4).
 */
async function releaseBuckets(
  tx: Tx,
  ctx: EngineContext,
  bucketIds: string[],
  cause: string,
): Promise<number> {
  if (bucketIds.length === 0) return 0;
  const targets = await tx
    .selectFrom('inventory_bucket')
    .select(['leg_id', 'category_id'])
    .where('id', 'in', bucketIds)
    .execute();
  const pools = await tx
    .selectFrom('inventory_bucket')
    .select('id')
    .where('kind', '=', 'pool')
    .where((eb) =>
      eb.or(
        targets.map((t) =>
          eb.and([eb('leg_id', '=', t.leg_id), eb('category_id', '=', t.category_id)]),
        ),
      ),
    )
    .execute();
  const locked = await lockBuckets(tx, { bucketIds: [...bucketIds, ...pools.map((p) => p.id)] });
  const stillOpen = new Set(
    (
      await tx
        .selectFrom('inventory_bucket')
        .select('id')
        .where('id', 'in', bucketIds)
        .where('released_at', 'is', null)
        .execute()
    ).map((b) => b.id),
  );
  const deltas: BucketDelta[] = [];
  let released = 0;
  for (const bucket of locked) {
    if (bucket.kind !== 'allotment' || !stillOpen.has(bucket.id)) continue;
    const unused = bucket.total - bucket.held - bucket.booked;
    const pool = locked.find(
      (b) =>
        b.kind === 'pool' && b.leg_id === bucket.leg_id && b.category_id === bucket.category_id,
    )!;
    await sql`update vs.inventory_bucket set total = total - ${unused}, released_at = now() where id = ${bucket.id}`.execute(
      tx,
    );
    await sql`update vs.inventory_bucket set total = total + ${unused} where id = ${pool.id}`.execute(
      tx,
    );
    if (unused > 0) {
      deltas.push(
        {
          bucketId: bucket.id,
          legId: bucket.leg_id,
          categoryId: bucket.category_id,
          total: -unused,
        },
        { bucketId: pool.id, legId: pool.leg_id, categoryId: pool.category_id, total: unused },
      );
    }
    released += 1;
  }
  await recordInventoryEvents(tx, ctx, deltas, cause, null);
  await availabilityChanged(
    tx,
    ctx,
    deltas.map((d) => d.bucketId),
    cause,
  );
  // An allotment with no open bucket left is released.
  await sql`
    update vs.allotment a set status = 'released'
    where a.status = 'active'
      and a.id in (select allotment_id from vs.inventory_bucket where id = any(${bucketIds}::uuid[]))
      and not exists (select from vs.inventory_bucket b where b.allotment_id = a.id and b.released_at is null)`.execute(
    tx,
  );
  return released;
}

export const releaseAllotmentLegInput = z.object({
  allotmentId: z.uuid(),
  legIds: z.array(z.uuid()).min(1).max(400),
});

/** Staff release of chosen legs now (before the release date). */
export async function releaseAllotmentLeg(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof releaseAllotmentLegInput>,
) {
  const data = parseInput(releaseAllotmentLegInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const buckets = await tx
      .selectFrom('inventory_bucket')
      .select('id')
      .where('allotment_id', '=', data.allotmentId)
      .where('leg_id', 'in', data.legIds)
      .where('released_at', 'is', null)
      .execute();
    const released = await releaseBuckets(
      tx,
      ctx,
      buckets.map((b) => b.id),
      'allotment.released',
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'allotment.released',
      entity: 'allotment',
      entityId: data.allotmentId,
      after: { leg_ids: data.legIds, buckets: released },
    });
    return { released };
  });
}

/**
 * Worker job (every 15 minutes): releases every allotment leg whose release date has come, by
 * the Cairo date from the database clock — `depart_date − release_days ≤ today`. Running often
 * also catches up anything missed.
 */
export async function releaseDueAllotments(
  db: VsDatabase,
  ctx: EngineContext,
  options: { limit?: number } = {},
) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{ id: string }>`
      select b.id from vs.inventory_bucket b
      join vs.allotment a on a.id = b.allotment_id
      join vs.leg l on l.id = b.leg_id
      where b.kind = 'allotment' and b.released_at is null and a.status = 'active'
        and l.depart_date - a.release_days <= (now() at time zone 'Africa/Cairo')::date
      order by l.depart_date, b.id
      limit ${options.limit ?? 500}`.execute(tx);
    const released = await releaseBuckets(
      tx,
      ctx,
      rows.map((r) => r.id),
      'allotment.release_due',
    );
    if (released > 0)
      await audit(tx, ctx.operatorId, ctx.actor, {
        action: 'allotments.released',
        entity: 'allotment',
        entityId: null,
        after: { buckets: released },
      });
    return { released };
  });
}
