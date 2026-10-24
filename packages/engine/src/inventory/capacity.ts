import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import {
  availabilityChanged,
  cairoToday,
  lockBuckets,
  lockVessel,
  parseInput,
  recordInventoryEvents,
  type BucketDelta,
  type EngineContext,
  type Tx,
} from '../internal';
import { dateSchema } from '../schedule/setup';

export const changeCapacityInput = z.object({
  vesselId: z.uuid(),
  /** The change applies to legs departing on or after this date (Cairo); not in the past. */
  effectiveFrom: dateSchema,
  change: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('add'),
      number: z.string().min(1).max(16),
      categoryId: z.uuid(),
      deck: z.string().max(50).optional(),
      accessible: z.boolean().default(false),
    }),
    z.object({ kind: z.literal('remove'), cabinId: z.uuid() }),
    z.object({ kind: z.literal('recategorise'), cabinId: z.uuid(), categoryId: z.uuid() }),
  ]),
  reason: z.string().min(1).max(500),
});

export interface CapacityConflict {
  legId: string;
  departDate: string;
  categoryId: string;
  free: number;
  held: number;
  booked: number;
}

/**
 * Adds a cabin, removes it, or moves it to another category from a date. Every leg departing on
 * or after that date changes by one in the affected categories, in one transaction. A decrease
 * needs a free cabin in the pool on every affected leg; otherwise nothing changes and the
 * conflicts are returned (CAPACITY_CONFLICT) for staff to move first.
 *
 * Periods starting after the date are replaced: the new state holds from that date onward.
 */
export async function changeCapacity(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof changeCapacityInput>,
): Promise<{ cabinId: string; legsAffected: number }> {
  const data = parseInput(changeCapacityInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    applyCapacityChange(tx, ctx, data),
  );
}

/** One capacity change inside the caller's transaction (also used to add many cabins at once). */
export async function applyCapacityChange(
  tx: Tx,
  ctx: EngineContext,
  data: z.output<typeof changeCapacityInput>,
): Promise<{ cabinId: string; legsAffected: number }> {
  const from = data.effectiveFrom;
  await lockVessel(tx, data.vesselId);
  if (from < (await cairoToday(tx))) {
    throw new DomainError('VALIDATION_FAILED', { message: 'effectiveFrom is in the past' });
  }
  const change = data.change;

  if (change.kind !== 'remove') {
    const category = await tx
      .selectFrom('cabin_category')
      .select('id')
      .where('id', '=', change.categoryId)
      .where('vessel_id', '=', data.vesselId)
      .executeTakeFirst();
    if (!category)
      throw new DomainError('NOT_FOUND', { message: 'Category not found on this vessel' });
  }

  let cabinId: string;
  if (change.kind === 'add') {
    const cabin = await tx
      .insertInto('cabin')
      .values({
        operator_id: ctx.operatorId,
        vessel_id: data.vesselId,
        number: change.number,
        deck: change.deck ?? null,
        accessible: change.accessible,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    cabinId = cabin.id;
  } else {
    const cabin = await tx
      .selectFrom('cabin')
      .select('id')
      .where('id', '=', change.cabinId)
      .where('vessel_id', '=', data.vesselId)
      .forUpdate()
      .executeTakeFirst();
    if (!cabin) throw new DomainError('NOT_FOUND', { message: 'Cabin not found on this vessel' });
    cabinId = cabin.id;
  }

  // Category of this cabin on every affected leg, before the change.
  const { rows: legs } = await sql<{
    leg_id: string;
    depart_date: string;
    old_category: string | null;
  }>`
    select l.id as leg_id, l.depart_date::text as depart_date,
           (select p.category_id from vs.cabin_period p
            where p.cabin_id = ${cabinId} and p.during @> l.depart_date) as old_category
    from vs.leg l
    where l.vessel_id = ${data.vesselId} and l.depart_date >= ${from}::date`.execute(tx);

  const activeNow = await sql<{ category_id: string }>`
    select category_id from vs.cabin_period where cabin_id = ${cabinId} and during @> ${from}::date`.execute(
    tx,
  );
  const currentCategory = activeNow.rows[0]?.category_id ?? null;
  if (change.kind !== 'add' && !currentCategory) {
    throw new DomainError('INVALID_STATE', {
      message: 'The cabin is not in service on that date',
    });
  }
  if (change.kind === 'recategorise' && currentCategory === change.categoryId) {
    throw new DomainError('VALIDATION_FAILED', {
      message: 'The cabin is already in that category',
    });
  }

  // Rewrite the periods from `from` onward.
  await sql`delete from vs.cabin_period where cabin_id = ${cabinId} and lower(during) >= ${from}::date`.execute(
    tx,
  );
  await sql`
    update vs.cabin_period set during = daterange(lower(during), ${from}::date)
    where cabin_id = ${cabinId} and during @> ${from}::date`.execute(tx);
  const newCategory = change.kind === 'remove' ? null : change.categoryId;
  if (newCategory) {
    await sql`
      insert into vs.cabin_period (operator_id, vessel_id, cabin_id, category_id, during)
      values (${ctx.operatorId}, ${data.vesselId}, ${cabinId}, ${newCategory}, daterange(${from}::date, null))`.execute(
      tx,
    );
  }

  const deltas = new Map<string, number>(); // `${leg}|${category}` → change in cabins
  for (const leg of legs) {
    if (leg.old_category === newCategory) continue;
    if (leg.old_category) deltas.set(`${leg.leg_id}|${leg.old_category}`, -1);
    if (newCategory) deltas.set(`${leg.leg_id}|${newCategory}`, 1);
  }

  if (deltas.size > 0) {
    const affectedLegs = [...new Set(legs.map((leg) => leg.leg_id))];
    if (newCategory) {
      // A category can be new to existing legs: give them a pool bucket first.
      await sql`
        insert into vs.inventory_bucket (operator_id, vessel_id, leg_id, category_id, kind, total)
        select ${ctx.operatorId}, ${data.vesselId}, l, ${newCategory}, 'pool', 0
        from unnest(${affectedLegs}::uuid[]) as l
        on conflict (leg_id, category_id) where kind = 'pool' do nothing`.execute(tx);
    }
    const categories = [...new Set([...deltas.keys()].map((key) => key.split('|')[1]!))];
    const buckets = await lockBuckets(tx, {
      legIds: affectedLegs,
      categoryIds: categories,
      kind: 'pool',
    });

    const conflicts: CapacityConflict[] = [];
    for (const bucket of buckets) {
      const delta = deltas.get(`${bucket.leg_id}|${bucket.category_id}`) ?? 0;
      const free = bucket.total - bucket.held - bucket.booked;
      if (delta < 0 && free < -delta) {
        conflicts.push({
          legId: bucket.leg_id,
          departDate: bucket.depart_date,
          categoryId: bucket.category_id,
          free,
          held: bucket.held,
          booked: bucket.booked,
        });
      }
    }
    if (conflicts.length > 0) {
      throw new DomainError('CAPACITY_CONFLICT', { details: { conflicts } });
    }

    const changed: BucketDelta[] = [];
    for (const bucket of buckets) {
      const delta = deltas.get(`${bucket.leg_id}|${bucket.category_id}`) ?? 0;
      if (delta === 0) continue;
      const updated = await sql`
        update vs.inventory_bucket set total = total + ${delta}
        where id = ${bucket.id} and total - held - booked + ${delta} >= 0`.execute(tx);
      if (Number(updated.numAffectedRows ?? 0) !== 1) {
        throw new DomainError('CAPACITY_CONFLICT', { details: { legId: bucket.leg_id } });
      }
      changed.push({
        bucketId: bucket.id,
        legId: bucket.leg_id,
        categoryId: bucket.category_id,
        total: delta,
      });
    }
    await recordInventoryEvents(tx, ctx, changed, `capacity.${change.kind}`, {
      entity: 'cabin',
      id: cabinId,
    });
    await availabilityChanged(
      tx,
      ctx,
      changed.map((d) => d.bucketId),
      `capacity.${change.kind}`,
    );
  }

  await audit(tx, ctx.operatorId, ctx.actor, {
    action: `cabin.${change.kind === 'add' ? 'added' : change.kind === 'remove' ? 'removed' : 'recategorised'}`,
    entity: 'cabin',
    entityId: cabinId,
    before: { category_id: currentCategory },
    after: { category_id: newCategory, effective_from: from, reason: data.reason },
  });
  return {
    cabinId,
    legsAffected: new Set([...deltas.keys()].map((key) => key.split('|')[0])).size,
  };
}
