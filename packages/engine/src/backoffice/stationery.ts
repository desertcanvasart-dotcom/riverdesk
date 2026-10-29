import { sql } from 'kysely';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import type { EngineContext } from '../internal';
import { departureCheckin } from './checkin';
import {
  dailyProgrammeData,
  getOperationsSettings,
  predepartureData,
  type PredepartureData,
} from './operations';

/**
 * The remaining stationery (Batch D4, docs/documents-plan.md § 5): what the transfer voucher,
 * the boarding pass and the housekeeping sheet are built from. The per-departure sheets (luggage
 * tags, excursion groups, table plan, muster list, feedback forms) read the departure's guests
 * like D2 and D3, plus the vessel's settings.
 */

/**
 * A guest's language for guided visits: the one recorded, else the usual language of their
 * nationality, else English (guides work in Arabic, English and the main European languages).
 */
const BY_NATIONALITY: Record<string, string> = {
  EG: 'ar',
  SA: 'ar',
  AE: 'ar',
  KW: 'ar',
  QA: 'ar',
  BH: 'ar',
  OM: 'ar',
  JO: 'ar',
  LB: 'ar',
  MA: 'ar',
  TN: 'ar',
  DZ: 'ar',
  GB: 'en',
  US: 'en',
  AU: 'en',
  CA: 'en',
  IE: 'en',
  NZ: 'en',
  ZA: 'en',
  IN: 'en',
  DE: 'de',
  AT: 'de',
  CH: 'de',
  FR: 'fr',
  BE: 'fr',
  LU: 'fr',
  IT: 'it',
  ES: 'es',
  MX: 'es',
  AR: 'es',
  PT: 'pt',
  BR: 'pt',
  NL: 'nl',
  RU: 'ru',
  CN: 'zh',
  TW: 'zh',
  JP: 'ja',
  KR: 'ko',
  PL: 'pl',
  CZ: 'cs',
};
export function guideLanguage(guest: {
  language: string | null;
  nationality: string | null;
}): string {
  return (
    guest.language ?? (guest.nationality ? BY_NATIONALITY[guest.nationality] : undefined) ?? 'en'
  );
}

// ---------------------------------------------------------------------------
// Per booking: the transfer voucher and the boarding pass
// ---------------------------------------------------------------------------

export interface TransferGuest {
  name: string;
  arrival: { date: string | null; flight: string | null; port: string | null };
  departure: { date: string | null; flight: string | null; time: string | null };
}

export interface TransferVoucherData extends PredepartureData {
  transferGuests: TransferGuest[];
}

/**
 * The transfer voucher: to the vessel on arrival (flight and airport from each guest's arrival
 * details), and from the vessel to the airport at the end (the flight home). Guests on the same
 * flight travel together.
 */
export async function transferVoucherData(
  db: VsDatabase,
  ctx: EngineContext,
  bookingId: string,
): Promise<TransferVoucherData> {
  const base = await predepartureData(db, ctx, bookingId);
  const guests = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx
      .selectFrom('guest')
      .select([
        'first_name',
        'last_name',
        'title',
        sql<string | null>`arrival_date::text`.as('arrival_date'),
        'arrival_flight',
        'arrival_port',
        sql<string | null>`departure_date::text`.as('departure_date'),
        'departure_flight',
        sql<string | null>`to_char(departure_time, 'HH24:MI')`.as('departure_time'),
      ])
      .where('booking_id', '=', bookingId)
      .orderBy('lead', 'desc')
      .orderBy('created_at')
      .execute(),
  );
  return {
    ...base,
    transferGuests: guests.map((g) => ({
      name: [g.title, g.first_name, g.last_name].filter(Boolean).join(' '),
      arrival: { date: g.arrival_date, flight: g.arrival_flight, port: g.arrival_port },
      departure: { date: g.departure_date, flight: g.departure_flight, time: g.departure_time },
    })),
  };
}

export interface BoardingPassData extends PredepartureData {
  passes: {
    cabin: string | null;
    category: { nameAr: string; nameEn: string };
    guests: string[];
    /** What the QR code carries: the booking and cabin, nothing personal. */
    code: string;
  }[];
}

/** One boarding pass per cabin, with a QR code reception scans to find the booking. */
export async function boardingPassData(
  db: VsDatabase,
  ctx: EngineContext,
  bookingId: string,
): Promise<BoardingPassData> {
  const base = await predepartureData(db, ctx, bookingId);
  const { rows } = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    sql<{
      seq: number;
      cabin: string | null;
      name_ar: string;
      name_en: string;
      guests: string[] | null;
    }>`
      select bc.seq,
             (select c.number from vs.booking_line bl join vs.cabin c on c.id = bl.assigned_cabin_id
              where bl.booking_cabin_id = bc.id and bl.status = 'confirmed'
              order by bl.created_at limit 1) as cabin,
             cc.name_ar, cc.name_en,
             array(select concat_ws(' ', g.title, g.first_name, g.last_name) from vs.guest g
                   where g.booking_cabin_id = bc.id order by g.lead desc, g.created_at) as guests
      from vs.booking_cabin bc join vs.cabin_category cc on cc.id = bc.category_id
      where bc.booking_id = ${bookingId} and bc.status = 'active'
      order by bc.seq`.execute(tx),
  );
  return {
    ...base,
    passes: rows.map((r) => ({
      cabin: r.cabin,
      category: { nameAr: r.name_ar, nameEn: r.name_en },
      guests: r.guests ?? [],
      code: `RD:${base.ref}:${r.seq + 1}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Per vessel and day: the housekeeping cabin status sheet
// ---------------------------------------------------------------------------

export type CabinStatus = 'vacant' | 'arriving' | 'departing' | 'turnover' | 'stayover';

export interface HousekeepingData {
  vessel: string;
  date: string;
  cabins: {
    number: string;
    deck: string | null;
    category: string | null;
    accessible: boolean;
    status: CabinStatus;
    /** Guests sleeping aboard tonight in the cabin. */
    guests: number;
    children: number;
    /** Something to prepare: a birthday or anniversary today, a honeymoon. */
    occasion: string | null;
  }[];
  /** Bookings aboard tonight not yet given a cabin number. */
  unassigned: { ref: string; guests: number }[];
  totals: Record<CabinStatus, number>;
}

/**
 * Every cabin of the vessel on a day: who leaves this morning, who arrives, who stays, and what
 * is empty, from the cabins assigned to bookings. The night counted is the one starting that day.
 */
export async function housekeepingData(
  db: VsDatabase,
  ctx: EngineContext,
  vesselId: string,
  date: string,
): Promise<HousekeepingData> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const vessel = await tx
      .selectFrom('vessel')
      .select('name')
      .where('id', '=', vesselId)
      .executeTakeFirst();
    if (!vessel) throw new DomainError('NOT_FOUND', { message: 'Vessel not found' });
    // Cabin by cabin: the booking cabin sleeping there tonight, and any leaving this morning.
    const { rows } = await sql<{
      number: string;
      deck: string | null;
      category: string | null;
      accessible: boolean;
      tonight: string | null;
      arriving: boolean;
      departing: boolean;
      guests: number;
      children: number;
      occasion: string | null;
    }>`
      with lines as (
        select bl.assigned_cabin_id as cabin_id, bl.booking_cabin_id, s.embark_date, s.disembark_date,
               l.depart_date, l.arrive_date
        from vs.booking_line bl
        join vs.leg l on l.id = bl.leg_id and l.vessel_id = ${vesselId}
        join vs.booking b on b.id = bl.booking_id and b.status in ('confirmed', 'completed')
        join vs.sailing s on s.id = b.sailing_id
        where bl.status = 'confirmed' and bl.assigned_cabin_id is not null
          and l.depart_date <= ${date}::date and l.arrive_date >= ${date}::date
      ), tonight as (
        select distinct on (cabin_id) cabin_id, booking_cabin_id, embark_date = ${date}::date as arriving
        from lines where depart_date <= ${date}::date and arrive_date > ${date}::date
          and disembark_date > ${date}::date
        order by cabin_id, embark_date
      ), leaving as (
        select distinct cabin_id from lines where disembark_date = ${date}::date
      )
      select c.number, c.deck, cc.name_en as category, c.accessible,
             t.booking_cabin_id as tonight, coalesce(t.arriving, false) as arriving,
             (lv.cabin_id is not null) as departing,
             coalesce(bc.adults + coalesce(array_length(bc.child_ages, 1), 0), 0)::int as guests,
             coalesce(array_length(bc.child_ages, 1), 0)::int as children,
             (select g.occasion from vs.guest g where g.booking_cabin_id = t.booking_cabin_id
                and g.occasion is not null
                and (g.occasion = 'honeymoon' or to_char(g.occasion_date, 'MM-DD') = to_char(${date}::date, 'MM-DD'))
              limit 1) as occasion
      from vs.cabin c
      left join tonight t on t.cabin_id = c.id
      left join leaving lv on lv.cabin_id = c.id
      left join vs.booking_cabin bc on bc.id = t.booking_cabin_id
      -- The category booked into the cabin tonight (a vacant cabin shows none).
      left join vs.cabin_category cc on cc.id = bc.category_id
      where c.vessel_id = ${vesselId}
      order by c.deck nulls last, c.number`.execute(tx);
    const { rows: unassigned } = await sql<{ ref: string; guests: number }>`
      select b.ref, sum(bc.adults + coalesce(array_length(bc.child_ages, 1), 0))::int as guests
      from vs.booking b
      join vs.sailing s on s.id = b.sailing_id
      join vs.booking_cabin bc on bc.booking_id = b.id and bc.status = 'active'
      where b.vessel_id = ${vesselId} and b.status = 'confirmed'
        and s.embark_date <= ${date}::date and s.disembark_date > ${date}::date
        and exists (select from vs.booking_line bl where bl.booking_cabin_id = bc.id
                    and bl.status = 'confirmed' and bl.assigned_cabin_id is null)
      group by b.ref order by b.ref`.execute(tx);
    const totals: Record<CabinStatus, number> = {
      vacant: 0,
      arriving: 0,
      departing: 0,
      turnover: 0,
      stayover: 0,
    };
    const cabins = rows.map((r) => {
      const status: CabinStatus =
        r.departing && r.tonight
          ? 'turnover'
          : r.tonight
            ? r.arriving
              ? 'arriving'
              : 'stayover'
            : r.departing
              ? 'departing'
              : 'vacant';
      totals[status] += 1;
      return {
        number: r.number,
        deck: r.deck,
        category: r.category,
        accessible: r.accessible,
        status,
        guests: r.tonight ? r.guests : 0,
        children: r.tonight ? r.children : 0,
        occasion: r.occasion,
      };
    });
    return { vessel: vessel.name, date, cabins, unassigned, totals };
  });
}

/** The vessel's on-board settings, for the per-departure sheets (muster, tables). */
export async function vesselSettingsOf(db: VsDatabase, ctx: EngineContext, vesselId: string) {
  const vessel = (await getOperationsSettings(db, ctx)).vessels.find((v) => v.id === vesselId);
  if (!vessel) throw new DomainError('NOT_FOUND', { message: 'Vessel not found' });
  return vessel;
}

// ---------------------------------------------------------------------------
// Per departure: excursion groups
// ---------------------------------------------------------------------------

export interface ExcursionData {
  vessel: string;
  departDate: string;
  arriveDate: string;
  /** The port visits on the departure's days, from the port guide. */
  visits: {
    date: string;
    port: { nameAr: string; nameEn: string };
    ar: string | null;
    en: string | null;
  }[];
  /** Everyone aboard, grouped by the language they visit in; largest group first. */
  groups: { language: string; guests: { name: string; cabin: string | null; ref: string }[] }[];
}

/** Guests per language for each visit, so the purser can book guides and split groups. */
export async function excursionData(
  db: VsDatabase,
  ctx: EngineContext,
  legId: string,
): Promise<ExcursionData> {
  const d = await departureCheckin(db, ctx, legId, { vesselId: null, mode: 'aboard' });
  const days =
    Math.round(
      (Date.parse(`${d.leg.arriveDate}T00:00:00Z`) - Date.parse(`${d.leg.departDate}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  const programme = await dailyProgrammeData(db, ctx, d.leg.vesselId, {
    from: d.leg.departDate,
    days: Math.min(Math.max(days, 1), 14),
  });
  // On the last day guests leave in the morning: only the port they arrive at counts, not the
  // next cruise's stops later that day.
  const visits = programme.days.flatMap((day) =>
    day.visits
      .filter((v) => day.date < d.leg.arriveDate || v.port.nameEn === d.leg.to.nameEn)
      .map((v) => ({ date: day.date, port: v.port, ar: v.ar, en: v.en })),
  );
  const groups = new Map<string, ExcursionData['groups'][number]>();
  for (const party of d.parties)
    for (const g of party.guests) {
      const language = guideLanguage(g);
      const group = groups.get(language) ?? { language, guests: [] };
      group.guests.push({
        name: `${g.lastName}, ${g.firstName}`,
        cabin: party.cabin?.number ?? null,
        ref: party.ref,
      });
      groups.set(language, group);
    }
  return {
    vessel: d.leg.vessel,
    departDate: d.leg.departDate,
    arriveDate: d.leg.arriveDate,
    visits,
    groups: [...groups.values()].sort(
      (a, b) => b.guests.length - a.guests.length || a.language.localeCompare(b.language),
    ),
  };
}
