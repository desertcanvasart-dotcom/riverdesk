import { sql } from 'kysely';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { decryptField, fieldKeyring, loadConfig, type FieldKeyring } from '@vs/shared';
import type { EngineContext } from '../internal';

let keyring: FieldKeyring | undefined;
const keys = () => (keyring ??= fieldKeyring(loadConfig()));

export interface ManifestGuest {
  firstName: string;
  lastName: string;
  nationality: string | null;
  dateOfBirth: string | null;
  lead: boolean;
  hasPassport: boolean;
  /** Only in the manifest export (spec § Sensitive data); never on screen. */
  passportNumber?: string | null;
}

export interface ManifestParty {
  bookingCabinId: string;
  ref: string;
  channel: string;
  category: { id: string; code: string; nameEn: string; nameAr: string };
  /** The cabin on this departure (null until assigned). */
  cabin: { id: string; number: string; deck: string | null } | null;
  adults: number;
  childAges: number[];
  embark: { date: string; port: string };
  disembark: { date: string; port: string };
  guests: ManifestGuest[];
}

export interface LegManifest {
  leg: {
    id: string;
    vesselId: string;
    vessel: string;
    departDate: string;
    arriveDate: string;
    from: { code: string; nameEn: string; nameAr: string };
    to: { code: string; nameEn: string; nameAr: string };
    status: string;
  };
  parties: ManifestParty[];
}

/**
 * Who is aboard on one departure (leg): every confirmed booked cabin sailing it, with its cabin,
 * guests and where it boards and leaves. Passport numbers are decrypted only when asked for the
 * manifest export.
 */
export async function getLegManifest(
  db: VsDatabase,
  ctx: EngineContext,
  legId: string,
  options: { withPassports?: boolean } = {},
): Promise<LegManifest> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const leg = await sql<LegManifest['leg']>`
      select l.id, l.vessel_id as "vesselId", v.name as vessel, l.depart_date::text as "departDate",
             l.arrive_date::text as "arriveDate", l.status,
             jsonb_build_object('code', fp.code, 'nameEn', fp.name_en, 'nameAr', fp.name_ar) as from,
             jsonb_build_object('code', tp.code, 'nameEn', tp.name_en, 'nameAr', tp.name_ar) as to
      from vs.leg l join vs.vessel v on v.id = l.vessel_id
      join vs.port fp on fp.id = l.from_port_id join vs.port tp on tp.id = l.to_port_id
      where l.id = ${legId}`.execute(tx);
    if (!leg.rows[0]) throw new DomainError('NOT_FOUND', { message: 'Departure not found' });
    const parties = await sql<Omit<ManifestParty, 'guests'> & { bookingId: string; seq: number }>`
      select bc.id as "bookingCabinId", b.id as "bookingId", bc.seq, b.ref, ch.name as channel,
             jsonb_build_object('id', c.id, 'code', c.code, 'nameEn', c.name_en, 'nameAr', c.name_ar) as category,
             case when cab.id is null then null
                  else jsonb_build_object('id', cab.id, 'number', cab.number, 'deck', cab.deck) end as cabin,
             bc.adults, bc.child_ages as "childAges",
             jsonb_build_object('date', s.embark_date, 'port', ep.code) as embark,
             jsonb_build_object('date', s.disembark_date, 'port', dp.code) as disembark
      from vs.booking_line bl
      join vs.booking b on b.id = bl.booking_id and b.status = 'confirmed'
      join vs.booking_cabin bc on bc.id = bl.booking_cabin_id
      join vs.cabin_category c on c.id = bc.category_id
      join vs.channel ch on ch.id = b.channel_id
      join vs.sailing s on s.id = b.sailing_id
      join vs.port ep on ep.id = s.embark_port_id
      join vs.port dp on dp.id = s.disembark_port_id
      left join vs.cabin cab on cab.id = bl.assigned_cabin_id
      where bl.leg_id = ${legId} and bl.status = 'confirmed'
      order by cab.number nulls last, c.sort_order, b.ref, bc.seq`.execute(tx);
    const bookingIds = [...new Set(parties.rows.map((p) => p.bookingId))];
    const guests =
      bookingIds.length === 0
        ? []
        : await tx
            .selectFrom('guest as g')
            .innerJoin('booking_cabin as bc', 'bc.id', 'g.booking_cabin_id')
            .select([
              'g.booking_cabin_id',
              'g.first_name',
              'g.last_name',
              'g.nationality',
              sql<string | null>`g.date_of_birth::text`.as('date_of_birth'),
              'g.lead',
              'g.passport_ciphertext',
              'g.passport_key_id',
            ])
            .where('g.booking_id', 'in', bookingIds)
            .orderBy('g.lead', 'desc')
            .orderBy('g.created_at')
            .execute();
    return {
      leg: leg.rows[0],
      parties: parties.rows.map(({ bookingId: _b, seq: _s, ...party }) => ({
        ...party,
        guests: guests
          .filter((g) => g.booking_cabin_id === party.bookingCabinId)
          .map((g) => ({
            firstName: g.first_name,
            lastName: g.last_name,
            nationality: g.nationality,
            dateOfBirth: g.date_of_birth,
            lead: g.lead,
            hasPassport: g.passport_ciphertext !== null,
            ...(options.withPassports
              ? {
                  passportNumber:
                    g.passport_ciphertext && g.passport_key_id
                      ? decryptField(Buffer.from(g.passport_ciphertext), g.passport_key_id, keys())
                      : null,
                }
              : {}),
          })),
      })),
    };
  });
}

/** Departures in a date range with how many booked cabins still need a physical cabin. */
export async function listDepartures(
  db: VsDatabase,
  ctx: EngineContext,
  input: { vesselId: string; from: string; to: string },
) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
      id: string;
      departDate: string;
      arriveDate: string;
      from: string;
      to: string;
      status: string;
      parties: number;
      unassigned: number;
      guests: number;
    }>`
      select l.id, l.depart_date::text as "departDate", l.arrive_date::text as "arriveDate", fp.code as from, tp.code as to,
             l.status,
             count(distinct bl.booking_cabin_id)::int as parties,
             count(distinct bl.booking_cabin_id) filter (where bl.assigned_cabin_id is null)::int as unassigned,
             coalesce((select count(*)::int from vs.guest g
                       where g.booking_cabin_id in (select x.booking_cabin_id from vs.booking_line x
                                                    join vs.booking xb on xb.id = x.booking_id and xb.status = 'confirmed'
                                                    where x.leg_id = l.id and x.status = 'confirmed')), 0) as guests
      from vs.leg l
      join vs.port fp on fp.id = l.from_port_id join vs.port tp on tp.id = l.to_port_id
      left join vs.booking_line bl on bl.leg_id = l.id and bl.status = 'confirmed'
        and exists (select from vs.booking b where b.id = bl.booking_id and b.status = 'confirmed')
      where l.vessel_id = ${input.vesselId} and l.depart_date between ${input.from}::date and ${input.to}::date
      group by l.id, fp.code, tp.code
      order by l.depart_date`.execute(tx);
    return rows;
  });
}

/** Cabins that could take this booked cabin on all its departures (for the manual override). */
export async function cabinOptions(db: VsDatabase, ctx: EngineContext, bookingCabinId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
      id: string;
      number: string;
      deck: string | null;
      current: boolean;
    }>`
      with party as (
        select bc.id, bc.category_id, b.vessel_id,
               array_agg(bl.leg_id) as leg_ids
        from vs.booking_cabin bc join vs.booking b on b.id = bc.booking_id
        join vs.booking_line bl on bl.booking_cabin_id = bc.id and bl.status = 'confirmed'
        where bc.id = ${bookingCabinId}
        group by bc.id, b.vessel_id)
      select c.id, c.number, c.deck,
             exists (select from vs.booking_line bl where bl.booking_cabin_id = party.id and bl.assigned_cabin_id = c.id) as current
      from party join vs.cabin c on c.vessel_id = party.vessel_id
      where not exists (
          select from vs.leg l where l.id = any(party.leg_ids)
            and not exists (select from vs.cabin_period p
                            where p.cabin_id = c.id and p.category_id = party.category_id and p.during @> l.depart_date))
        and not exists (
          select from vs.booking_line bl
          where bl.leg_id = any(party.leg_ids) and bl.status = 'confirmed' and bl.assigned_cabin_id = c.id
            and bl.booking_cabin_id <> party.id)
        and not exists (
          select from vs.cabin_block k join vs.inventory_bucket b on b.block_id = k.id
          where k.cabin_id = c.id and k.status = 'active' and b.leg_id = any(party.leg_ids))
      order by c.deck nulls last, c.number`.execute(tx);
    return rows;
  });
}
