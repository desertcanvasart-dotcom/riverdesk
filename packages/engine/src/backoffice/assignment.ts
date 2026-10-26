import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import { ERASED_CHECKIN_DETAILS } from '../booking/common';
import { cairoToday, lockVessel, parseInput, type EngineContext, type Tx } from '../internal';

/**
 * Physical cabins (spec § Guests, assignment and manifests). A booked cabin is assigned on each
 * leg it sails (booking_line.assigned_cabin_id); a unique index keeps one guest party per cabin
 * per leg. Auto-assignment runs at the cut-off; staff can override any assignment. Assignment is
 * serialised per vessel (the same lock schedule changes take).
 */

interface Line {
  line_id: string;
  booking_cabin_id: string;
  leg_id: string;
  category_id: string;
  depart_date: string;
  assigned_cabin_id: string | null;
}

async function linesOf(tx: Tx, bookingCabinIds: string[]): Promise<Line[]> {
  if (bookingCabinIds.length === 0) return [];
  const { rows } = await sql<Line>`
    select bl.id as line_id, bl.booking_cabin_id, bl.leg_id, bc.category_id, l.depart_date::text, bl.assigned_cabin_id
    from vs.booking_line bl
    join vs.booking_cabin bc on bc.id = bl.booking_cabin_id
    join vs.leg l on l.id = bl.leg_id
    where bl.booking_cabin_id = any(${bookingCabinIds}::uuid[]) and bl.status = 'confirmed'
    order by l.depart_date`.execute(tx);
  return rows;
}

/** Cabins of `categoryId` on every given leg (by category period), not blocked and not taken. */
async function freeCabins(tx: Tx, vesselId: string, categoryId: string, legIds: string[]) {
  const { rows } = await sql<{ id: string; number: string }>`
    select c.id, c.number
    from vs.cabin c
    where c.vessel_id = ${vesselId}
      and not exists (
        select from vs.leg l where l.id = any(${legIds}::uuid[])
          and not exists (select from vs.cabin_period p
                          where p.cabin_id = c.id and p.category_id = ${categoryId} and p.during @> l.depart_date))
      and not exists (
        select from vs.booking_line bl
        where bl.leg_id = any(${legIds}::uuid[]) and bl.status = 'confirmed' and bl.assigned_cabin_id = c.id)
      and not exists (
        select from vs.cabin_block k join vs.inventory_bucket b on b.block_id = k.id
        where k.cabin_id = c.id and k.status = 'active' and b.leg_id = any(${legIds}::uuid[]))
    order by c.deck nulls last, c.number`.execute(tx);
  return rows;
}

async function setAssignment(
  tx: Tx,
  bookingCabinId: string,
  lineIds: string[],
  cabinId: string | null,
) {
  if (lineIds.length > 0) {
    await tx
      .updateTable('booking_line')
      .set({ assigned_cabin_id: cabinId })
      .where('id', 'in', lineIds)
      .execute();
  }
  // The summary on the booked cabin: one cabin for the whole cruise, or none.
  await sql`
    update vs.booking_cabin bc set assigned_cabin_id = (
      select case when count(distinct bl.assigned_cabin_id) = 1 and bool_and(bl.assigned_cabin_id is not null)
                  then min(bl.assigned_cabin_id::text)::uuid end
      from vs.booking_line bl where bl.booking_cabin_id = bc.id and bl.status = 'confirmed')
    where bc.id = ${bookingCabinId}`.execute(tx);
}

export const autoAssignCabinsInput = z.object({
  vesselId: z.uuid(),
  legIds: z.array(z.uuid()).min(1).max(400),
});

/**
 * Assigns every booked cabin that sails on these legs and still lacks a cabin on any of its legs.
 * A party keeps one cabin for its whole cruise when one is free on all its legs; otherwise it
 * gets a cabin per leg (reported as `split`). Parties on more legs are placed first.
 */
export async function autoAssignCabins(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof autoAssignCabinsInput>,
) {
  const data = parseInput(autoAssignCabinsInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await lockVessel(tx, data.vesselId);
    const { rows: pending } = await sql<{ booking_cabin_id: string }>`
      select distinct bl.booking_cabin_id
      from vs.booking_line bl join vs.booking b on b.id = bl.booking_id
      where bl.leg_id = any(${data.legIds}::uuid[]) and bl.status = 'confirmed' and b.status = 'confirmed'
        and exists (select from vs.booking_line x
                    where x.booking_cabin_id = bl.booking_cabin_id and x.status = 'confirmed' and x.assigned_cabin_id is null)`.execute(
      tx,
    );
    const lines = await linesOf(
      tx,
      pending.map((p) => p.booking_cabin_id),
    );
    const byParty = new Map<string, Line[]>();
    for (const line of lines)
      byParty.set(line.booking_cabin_id, [...(byParty.get(line.booking_cabin_id) ?? []), line]);
    const parties = [...byParty].sort(([, a], [, b]) => b.length - a.length);
    let assigned = 0;
    let split = 0;
    const unplaced: string[] = [];
    for (const [bookingCabinId, own] of parties) {
      const open = own.filter((l) => l.assigned_cabin_id === null);
      const kept = own.find((l) => l.assigned_cabin_id)?.assigned_cabin_id ?? null;
      const legIds = open.map((l) => l.leg_id);
      const whole = await freeCabins(tx, data.vesselId, own[0]!.category_id, legIds);
      const choice = whole.find((c) => c.id === kept) ?? whole[0];
      if (choice) {
        await setAssignment(
          tx,
          bookingCabinId,
          open.map((l) => l.line_id),
          choice.id,
        );
        assigned += 1;
        continue;
      }
      let placedAll = true;
      for (const line of open) {
        const [cabin] = await freeCabins(tx, data.vesselId, line.category_id, [line.leg_id]);
        if (cabin) await setAssignment(tx, bookingCabinId, [line.line_id], cabin.id);
        else placedAll = false;
      }
      if (placedAll) split += 1;
      else unplaced.push(bookingCabinId);
    }
    if (assigned + split > 0 || unplaced.length > 0) {
      await audit(tx, ctx.operatorId, ctx.actor, {
        action: 'cabins.auto_assigned',
        entity: 'vessel',
        entityId: data.vesselId,
        after: { legs: data.legIds.length, assigned, split, unplaced: unplaced.length },
      });
    }
    return { assigned, split, unplaced: unplaced.length };
  });
}

export const assignCabinInput = z.object({
  bookingCabinId: z.uuid(),
  /** null takes the assignment off (the cabin is assigned again at the next auto-assignment). */
  cabinId: z.uuid().nullable(),
});

/** Staff override: this booked cabin gets this physical cabin on every leg it sails. */
export async function assignCabin(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof assignCabinInput>,
) {
  const data = parseInput(assignCabinInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const party = await tx
      .selectFrom('booking_cabin as bc')
      .innerJoin('booking as b', 'b.id', 'bc.booking_id')
      .select(['bc.id', 'bc.category_id', 'b.vessel_id', 'b.ref', 'b.status'])
      .where('bc.id', '=', data.bookingCabinId)
      .executeTakeFirst();
    if (!party) throw new DomainError('NOT_FOUND', { message: 'Booked cabin not found' });
    if (party.status !== 'confirmed')
      throw new DomainError('INVALID_STATE', { message: 'Only confirmed bookings get cabins' });
    await lockVessel(tx, party.vessel_id);
    const lines = await linesOf(tx, [party.id]);
    if (data.cabinId) {
      // Free this party's own lines first, so moving within the party is not a conflict.
      await setAssignment(
        tx,
        party.id,
        lines.map((l) => l.line_id),
        null,
      );
      const free = await freeCabins(
        tx,
        party.vessel_id,
        party.category_id,
        lines.map((l) => l.leg_id),
      );
      if (!free.some((c) => c.id === data.cabinId)) {
        throw new DomainError('INVALID_STATE', {
          message: 'That cabin is of another category, blocked or taken on one of these departures',
        });
      }
    }
    await setAssignment(
      tx,
      party.id,
      lines.map((l) => l.line_id),
      data.cabinId,
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: data.cabinId ? 'cabin.assigned' : 'cabin.unassigned',
      entity: 'booking_cabin',
      entityId: party.id,
      before: { cabins: [...new Set(lines.map((l) => l.assigned_cabin_id))] },
      after: { cabin_id: data.cabinId, booking: party.ref },
    });
    return { bookingCabinId: party.id, cabinId: data.cabinId };
  });
}

/** Worker job: departures inside the operator's assignment cut-off get their cabins. */
export async function assignDueCabins(db: VsDatabase, ctx: EngineContext) {
  const due = await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const today = await cairoToday(tx);
    const { rows } = await sql<{ vessel_id: string; leg_ids: string[] }>`
      select l.vessel_id, array_agg(l.id) as leg_ids
      from vs.leg l, vs.operator_setting s
      where l.status = 'open' and l.depart_date between ${today}::date and ${today}::date + s.assignment_cutoff_days
      group by l.vessel_id`.execute(tx);
    return rows;
  });
  const totals = { assigned: 0, split: 0, unplaced: 0 };
  for (const vessel of due) {
    for (let i = 0; i < vessel.leg_ids.length; i += 400) {
      const result = await autoAssignCabins(db, ctx, {
        vesselId: vessel.vessel_id,
        legIds: vessel.leg_ids.slice(i, i + 400),
      });
      totals.assigned += result.assigned;
      totals.split += result.split;
      totals.unplaced += result.unplaced;
    }
  }
  return totals;
}

/**
 * Passport numbers, dates of birth and the other personal check-in details are erased a set
 * number of days after disembarkation (operator setting, 90 by default). Names stay for
 * accounting. Worker job, daily.
 */
export async function erasePassports(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const today = await cairoToday(tx);
    // Passport numbers, dates of birth and every personal check-in detail (Batch D2) go together.
    const result = await tx
      .updateTable('guest')
      .set({ ...ERASED_CHECKIN_DETAILS, dietary: sql<string[]>`'{}'::text[]` })
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom('booking as b')
            .innerJoin('sailing as s', 's.id', 'b.sailing_id')
            .innerJoin('operator_setting as o', 'o.operator_id', 'b.operator_id')
            .whereRef('b.id', '=', 'guest.booking_id')
            .where(sql<boolean>`s.disembark_date + o.passport_retention_days < ${today}::date`),
        ),
      )
      .where(
        sql<boolean>`(passport_ciphertext is not null or date_of_birth is not null
          or passport_country is not null or passport_expires_on is not null or visa_type is not null
          or visa_ciphertext is not null or medical_ciphertext is not null or phone is not null
          or emergency_name is not null or arrival_date is not null or allergies is not null
          or cardinality(dietary) > 0 or occasion is not null or place_of_birth is not null)`,
      )
      .executeTakeFirst();
    const erased = Number(result.numUpdatedRows ?? 0);
    if (erased > 0) {
      await audit(tx, ctx.operatorId, ctx.actor, {
        action: 'guests.passports_erased',
        entity: 'operator',
        entityId: ctx.operatorId,
        after: { guests: erased },
      });
    }
    return { erased };
  });
}
