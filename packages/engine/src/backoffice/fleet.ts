import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { pgErrorCode } from '@vs/shared';
import { audit } from '../audit';
import { applyCapacityChange } from '../inventory/capacity';
import { cairoToday, lockVessel, parseInput, type EngineContext } from '../internal';
import {
  createCabinCategory,
  createCabinCategoryInput,
  createVessel,
  createVesselInput,
  dateSchema,
} from '../schedule/setup';

/**
 * Ships & cabins screen (Batch 8, step 1): a company sets up its own fleet. Creating ships and
 * categories reuses the setup functions; cabins go through the capacity change, so every leg
 * that already exists gets its counts in the same transaction.
 */

export interface FleetCategory {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  deck: string | null;
  view: string | null;
  bedConfig: string | null;
  maxAdults: number;
  maxOccupancy: number;
  extraBedAllowed: boolean;
  sortOrder: number;
  /** Cabins in this category today (or from their first future date). */
  cabins: number;
}

export interface FleetVessel {
  id: string;
  code: string;
  name: string;
  type: 'cruise_ship' | 'dahabiya' | 'steam';
  maxGuests: number;
  categories: FleetCategory[];
  /** Cabins with no category ahead: added, then taken out of service. */
  cabins: number;
  /** Departures from today on: once there are some, cabin changes also change availability. */
  upcomingLegs: number;
}

export async function getFleet(db: VsDatabase, ctx: EngineContext): Promise<FleetVessel[]> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const vessels = await tx
      .selectFrom('vessel')
      .select(['id', 'code', 'name', 'type', 'max_guests'])
      .where('active', '=', true)
      .orderBy('name')
      .execute();
    const categories = await tx
      .selectFrom('cabin_category')
      .selectAll()
      .orderBy('sort_order')
      .orderBy('code')
      .execute();
    // The category each cabin is in today, or from its next future period.
    const { rows: counts } = await sql<{ vessel_id: string; category_id: string; n: number }>`
      select c.vessel_id, p.category_id, count(*)::int as n
      from vs.cabin c
      join lateral (
        select category_id from vs.cabin_period
        where cabin_id = c.id
          and (upper_inf(during) or upper(during) > (now() at time zone 'Africa/Cairo')::date)
        order by lower(during) limit 1) p on true
      group by c.vessel_id, p.category_id`.execute(tx);
    const { rows: legs } = await sql<{ vessel_id: string; n: number }>`
      select vessel_id, count(*)::int as n from vs.leg
      where depart_date >= (now() at time zone 'Africa/Cairo')::date
      group by vessel_id`.execute(tx);
    return vessels.map((v) => {
      const own = categories.filter((c) => c.vessel_id === v.id);
      const cabinsIn = (id: string) => counts.find((x) => x.category_id === id)?.n ?? 0;
      return {
        id: v.id,
        code: v.code,
        name: v.name,
        type: v.type as FleetVessel['type'],
        maxGuests: v.max_guests,
        categories: own.map((c) => ({
          id: c.id,
          code: c.code,
          nameEn: c.name_en,
          nameAr: c.name_ar,
          deck: c.deck,
          view: c.view,
          bedConfig: c.bed_config,
          maxAdults: c.max_adults,
          maxOccupancy: c.max_occupancy,
          extraBedAllowed: c.extra_bed_allowed,
          sortOrder: c.sort_order,
          cabins: cabinsIn(c.id),
        })),
        cabins: counts.filter((x) => x.vessel_id === v.id).reduce((sum, x) => sum + x.n, 0),
        upcomingLegs: legs.find((x) => x.vessel_id === v.id)?.n ?? 0,
      };
    });
  });
}

/** A unique code or number already used: a clear refusal instead of a database error. */
async function unique<T>(run: () => Promise<T>, reason: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (pgErrorCode(error) === '23505')
      throw new DomainError('VALIDATION_FAILED', { message: 'Already used', details: { reason } });
    throw error;
  }
}

export async function addVessel(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createVesselInput>,
) {
  return unique(() => createVessel(db, ctx, input), 'code_taken');
}

/**
 * A new category joins every active contract of the ship: contracts sell all of a ship's
 * categories (the contract form says so), including ones added later.
 */
export async function addCabinCategory(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createCabinCategoryInput>,
) {
  const category = await unique(() => createCabinCategory(db, ctx, input), 'code_taken');
  await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    sql`
      insert into vs.channel_contract_category (operator_id, contract_id, category_id)
      select ${ctx.operatorId}, k.id, ${category.id} from vs.channel_contract k
      where k.vessel_id = ${category.vessel_id} and k.active
      on conflict do nothing`.execute(tx),
  );
  return category;
}

export const updateVesselInput = z.object({
  vesselId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  type: z.enum(['cruise_ship', 'dahabiya', 'steam']),
  maxGuests: z.number().int().positive().max(1000),
});

/** Name, type and guest limit. The code stays: it appears in references and exports. */
export async function updateVessel(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateVesselInput>,
) {
  const data = parseInput(updateVesselInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await lockVessel(tx, data.vesselId);
    const after = await tx
      .updateTable('vessel')
      .set({ name: data.name, type: data.type, max_guests: data.maxGuests })
      .where('id', '=', data.vesselId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'vessel.updated',
      entity: 'vessel',
      entityId: data.vesselId,
      before: { name: before.name, type: before.type, max_guests: before.max_guests },
      after: { name: after.name, type: after.type, max_guests: after.max_guests },
    });
    return after;
  });
}

export const updateCabinCategoryInput = z
  .object({
    categoryId: z.uuid(),
    nameEn: z.string().trim().min(1).max(100),
    nameAr: z.string().trim().min(1).max(100),
    deck: z.string().trim().max(50).optional(),
    view: z.string().trim().max(50).optional(),
    bedConfig: z.string().trim().max(50).optional(),
    maxAdults: z.number().int().min(1).max(10),
    maxOccupancy: z.number().int().min(1).max(12),
    extraBedAllowed: z.boolean(),
    sortOrder: z.number().int().min(0).max(999),
  })
  .refine(
    (value) => value.maxOccupancy >= value.maxAdults,
    'maxOccupancy must be at least maxAdults',
  );

/**
 * Everything but the code. A lower guest limit is refused while a booking still to sail in this
 * category has more guests than the new limit allows.
 */
export async function updateCabinCategory(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateCabinCategoryInput>,
) {
  const data = parseInput(updateCabinCategoryInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const current = await tx
      .selectFrom('cabin_category')
      .selectAll()
      .where('id', '=', data.categoryId)
      .executeTakeFirst();
    if (!current) throw new DomainError('NOT_FOUND', { message: 'Category not found' });
    await lockVessel(tx, current.vessel_id);
    if (data.maxAdults < current.max_adults || data.maxOccupancy < current.max_occupancy) {
      const today = await cairoToday(tx);
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n
        from vs.booking_cabin bc
        join vs.booking b on b.id = bc.booking_id
        join vs.sailing s on s.id = b.sailing_id
        where bc.category_id = ${data.categoryId} and bc.status = 'active'
          and b.status in ('requested', 'held', 'offered', 'confirmed')
          and s.disembark_date >= ${today}::date
          and (bc.adults > ${data.maxAdults}
               or bc.adults + cardinality(bc.child_ages) > ${data.maxOccupancy})`.execute(tx);
      if (rows[0]!.n > 0)
        throw new DomainError('INVALID_STATE', {
          message: 'Bookings still to sail have more guests than the new limit',
          details: { reason: 'occupancy_in_use', bookings: rows[0]!.n },
        });
    }
    const after = await tx
      .updateTable('cabin_category')
      .set({
        name_en: data.nameEn,
        name_ar: data.nameAr,
        deck: data.deck || null,
        view: data.view || null,
        bed_config: data.bedConfig || null,
        max_adults: data.maxAdults,
        max_occupancy: data.maxOccupancy,
        extra_bed_allowed: data.extraBedAllowed,
        sort_order: data.sortOrder,
      })
      .where('id', '=', data.categoryId)
      .returningAll()
      .executeTakeFirstOrThrow();
    const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
      (key) => key !== 'updated_at' && after[key] !== current[key],
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'cabin_category.updated',
      entity: 'cabin_category',
      entityId: data.categoryId,
      before: Object.fromEntries(changed.map((key) => [key, current[key]])),
      after: Object.fromEntries(changed.map((key) => [key, after[key]])),
    });
    return after;
  });
}

export const addCabinsInput = z.object({
  vesselId: z.uuid(),
  categoryId: z.uuid(),
  /** Cabin numbers as printed on the doors, e.g. 101 or A12. */
  numbers: z
    .array(z.string().trim().min(1).max(16))
    .min(1)
    .max(200)
    .refine((list) => new Set(list).size === list.length, 'Numbers repeat'),
  deck: z.string().trim().max(50).optional(),
  accessible: z.boolean().default(false),
  effectiveFrom: dateSchema,
  reason: z.string().trim().min(1).max(500),
});

/**
 * Adds several cabins to one category in one transaction: all of them, or none (e.g. when a
 * number is already used on this ship).
 */
export async function addCabins(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof addCabinsInput>,
): Promise<{ added: number; legsAffected: number }> {
  const data = parseInput(addCabinsInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await lockVessel(tx, data.vesselId);
    const taken = await tx
      .selectFrom('cabin')
      .select('number')
      .where('vessel_id', '=', data.vesselId)
      .where('number', 'in', data.numbers)
      .execute();
    if (taken.length > 0)
      throw new DomainError('VALIDATION_FAILED', {
        message: 'Cabin numbers already used on this ship',
        details: { reason: 'number_taken', numbers: taken.map((c) => c.number) },
      });
    let legsAffected = 0;
    for (const number of data.numbers) {
      const result = await applyCapacityChange(tx, ctx, {
        vesselId: data.vesselId,
        effectiveFrom: data.effectiveFrom,
        reason: data.reason,
        change: {
          kind: 'add',
          number,
          categoryId: data.categoryId,
          deck: data.deck || undefined,
          accessible: data.accessible,
        },
      });
      legsAffected = Math.max(legsAffected, result.legsAffected);
    }
    return { added: data.numbers.length, legsAffected };
  });
}
