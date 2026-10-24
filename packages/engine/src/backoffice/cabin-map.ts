import { sql } from 'kysely';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import type { EngineContext } from '../internal';

/**
 * Staff cabin map (Batch 8, step 5): every physical cabin of the ship on one departure, deck by
 * deck, with what is in it. Sales stay by category; this is where staff see and change which
 * party sleeps where (through assignCabin). No passport numbers or dates of birth.
 */

export type CabinState = 'free' | 'occupied' | 'blocked' | 'out_of_service';

export interface MapParty {
  bookingCabinId: string;
  ref: string;
  lead: string | null;
  guests: number;
  /** Boards before this departure or leaves after it: the cabin is theirs on other legs too. */
  boardedEarlier: boolean;
  staysLonger: boolean;
}

export interface MapCabin {
  id: string;
  number: string;
  deck: string | null;
  accessible: boolean;
  category: { id: string; code: string; nameEn: string; nameAr: string } | null;
  state: CabinState;
  party: MapParty | null;
  blockReason: string | null;
}

export interface CabinMap {
  leg: { id: string; vesselId: string; departDate: string; arriveDate: string };
  cabins: MapCabin[];
  /** Confirmed parties on this departure with no cabin yet. */
  unassigned: (MapParty & { category: { id: string; code: string } })[];
  /** Per category on this departure: holds and allotments are counts, not cabins. */
  counts: {
    categoryId: string;
    code: string;
    total: number;
    free: number;
    held: number;
    booked: number;
  }[];
}

export async function getCabinMap(
  db: VsDatabase,
  ctx: EngineContext,
  legId: string,
): Promise<CabinMap> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const leg = await tx
      .selectFrom('leg')
      .select([
        'id',
        'vessel_id as vesselId',
        sql<string>`depart_date::text`.as('departDate'),
        sql<string>`arrive_date::text`.as('arriveDate'),
      ])
      .where('id', '=', legId)
      .executeTakeFirst();
    if (!leg) throw new DomainError('NOT_FOUND', { message: 'Departure not found' });

    // Parties on this departure: the lead guest's name, the party size, and whether the cruise
    // runs over other legs too.
    const { rows: parties } = await sql<
      MapParty & { cabinId: string | null; categoryId: string; categoryCode: string }
    >`
      select bc.id as "bookingCabinId", b.ref, bl.assigned_cabin_id as "cabinId",
             bc.category_id as "categoryId", c.code as "categoryCode",
             (select concat_ws(' ', g.first_name, g.last_name) from vs.guest g
              where g.booking_cabin_id = bc.id order by g.lead desc, g.id limit 1) as lead,
             bc.adults + cardinality(bc.child_ages) as guests,
             s.embark_date < ${leg.departDate}::date as "boardedEarlier",
             s.disembark_date > ${leg.arriveDate}::date as "staysLonger"
      from vs.booking_line bl
      join vs.booking b on b.id = bl.booking_id and b.status = 'confirmed'
      join vs.booking_cabin bc on bc.id = bl.booking_cabin_id
      join vs.cabin_category c on c.id = bc.category_id
      join vs.sailing s on s.id = b.sailing_id
      where bl.leg_id = ${legId} and bl.status = 'confirmed'
      order by b.ref, bc.seq`.execute(tx);

    const { rows: cabins } = await sql<{
      id: string;
      number: string;
      deck: string | null;
      accessible: boolean;
      category: MapCabin['category'];
      blockReason: string | null;
    }>`
      select cab.id, cab.number, cab.deck, cab.accessible,
             (select jsonb_build_object('id', c.id, 'code', c.code, 'nameEn', c.name_en, 'nameAr', c.name_ar)
              from vs.cabin_period p join vs.cabin_category c on c.id = p.category_id
              where p.cabin_id = cab.id and p.during @> ${leg.departDate}::date) as category,
             (select k.reason from vs.cabin_block k join vs.inventory_bucket ib on ib.block_id = k.id
              where k.cabin_id = cab.id and k.status = 'active' and ib.leg_id = ${legId} limit 1) as "blockReason"
      from vs.cabin cab where cab.vessel_id = ${leg.vesselId}
      order by cab.deck nulls last, length(cab.number), cab.number`.execute(tx);

    const { rows: counts } = await sql<CabinMap['counts'][number]>`
      select c.id as "categoryId", c.code, b.total, b.total - b.held - b.booked as free,
             b.held, b.booked
      from vs.inventory_bucket b join vs.cabin_category c on c.id = b.category_id
      where b.leg_id = ${legId} and b.kind = 'pool'
      order by c.sort_order, c.code`.execute(tx);

    const party = (p: (typeof parties)[number]): MapParty => ({
      bookingCabinId: p.bookingCabinId,
      ref: p.ref,
      lead: p.lead,
      guests: p.guests,
      boardedEarlier: p.boardedEarlier,
      staysLonger: p.staysLonger,
    });
    return {
      leg,
      cabins: cabins.map((c) => {
        const occupant = parties.find((p) => p.cabinId === c.id);
        return {
          ...c,
          state: occupant
            ? 'occupied'
            : c.blockReason
              ? 'blocked'
              : c.category
                ? 'free'
                : 'out_of_service',
          party: occupant ? party(occupant) : null,
        };
      }),
      unassigned: parties
        .filter((p) => !p.cabinId)
        .map((p) => ({ ...party(p), category: { id: p.categoryId, code: p.categoryCode } })),
      counts,
    };
  });
}
