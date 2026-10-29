import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { decryptField, fieldKeyring, loadConfig, type FieldKeyring } from '@vs/shared';
import { audit } from '../audit';
import { cairoToday, parseInput, type EngineContext, type Tx } from '../internal';

/**
 * Check-in (Batch D2): who boards each departure, with the details the reception and the police
 * list need, and the reception's check-in marks. An on-board login passes its vessel as `scope`
 * and sees only that vessel's departures, without prices or payments.
 */

let keyring: FieldKeyring | undefined;
const keys = () => (keyring ??= fieldKeyring(loadConfig()));

export interface CheckinScope {
  /** Limits every read and write to one vessel (an on-board login); null for office staff. */
  vesselId: string | null;
}

export interface CheckinGuest {
  firstName: string;
  lastName: string;
  lead: boolean;
  title: string | null;
  gender: string | null;
  nationality: string | null;
  dateOfBirth: string | null;
  placeOfBirth: string | null;
  passportCountry: string | null;
  passportIssuedOn: string | null;
  passportExpiresOn: string | null;
  hasPassport: boolean;
  visaType: string | null;
  arrivalDate: string | null;
  arrivalFlight: string | null;
  arrivalPort: string | null;
  departureDate: string | null;
  departureFlight: string | null;
  departureTime: string | null;
  phone: string | null;
  emergencyName: string | null;
  emergencyPhone: string | null;
  dietary: string[];
  allergies: string | null;
  hasMedicalNotes: boolean;
  occasion: string | null;
  occasionDate: string | null;
  /** What reception should look at: missing passport, passport expiring within 6 months. */
  warnings: ('no_passport' | 'passport_expiring' | 'passport_expired')[];
  /** Only for the check-in file and registration cards (permission `manifests`). */
  passportNumber?: string | null;
  visaNumber?: string | null;
  medicalNotes?: string | null;
}

export interface CheckinParty {
  bookingCabinId: string;
  ref: string;
  channel: string;
  category: { code: string; nameEn: string; nameAr: string };
  cabin: { number: string; deck: string | null } | null;
  adults: number;
  childAges: number[];
  disembark: { date: string; port: string };
  /** Still to collect at the desk, in the booking currency; only with `withMoney`. */
  balance?: { amount: bigint; currency: string };
  checkin: {
    passportsSeen: boolean;
    cardsSigned: boolean;
    keyHanded: boolean;
    checkedInAt: Date | null;
  };
  guests: CheckinGuest[];
}

export interface DepartureCheckin {
  leg: {
    id: string;
    vesselId: string;
    vessel: string;
    departDate: string;
    departTime: string | null;
    arriveDate: string;
    arriveTime: string | null;
    from: { code: string; nameEn: string; nameAr: string };
    to: { code: string; nameEn: string; nameAr: string };
  };
  /**
   * Cabins boarding at this departure (not those already aboard from an earlier one); with mode
   * `aboard` everyone on board during it, with `leaving` those leaving where it ends.
   */
  parties: CheckinParty[];
  totals: {
    cabins: number;
    guests: number;
    checkedIn: number;
    nationalities: Record<string, number>;
    dietary: Record<string, number>;
    occasions: number;
    warnings: number;
  };
}

const legIdInput = z.uuid();

async function assertInScope(tx: Tx, legId: string, scope: CheckinScope) {
  const leg = await tx
    .selectFrom('leg')
    .select('vessel_id')
    .where('id', '=', legId)
    .executeTakeFirst();
  if (!leg || (scope.vesselId && leg.vessel_id !== scope.vesselId))
    throw new DomainError('NOT_FOUND', { message: 'Departure not found' });
}

const decrypt = (ciphertext: Buffer | null, keyId: string | null) =>
  ciphertext && keyId ? decryptField(Buffer.from(ciphertext), keyId, keys()) : null;

/**
 * Everyone boarding one departure, cabin by cabin, with check-in details and marks. Sensitive
 * numbers (passport, visa) and medical notes are decrypted only with `withSensitive`; balances
 * only with `withMoney`.
 */
export async function departureCheckin(
  db: VsDatabase,
  ctx: EngineContext,
  legId: string,
  options: CheckinScope & {
    withSensitive?: boolean;
    withMoney?: boolean;
    mode?: 'boarding' | 'aboard' | 'leaving';
  },
): Promise<DepartureCheckin> {
  const id = parseInput(legIdInput, legId);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await assertInScope(tx, id, options);
    const leg = await sql<DepartureCheckin['leg']>`
      select l.id, l.vessel_id as "vesselId", v.name as vessel, l.depart_date::text as "departDate",
             to_char(st.depart_time, 'HH24:MI') as "departTime",
             l.arrive_date::text as "arriveDate", to_char(ast.arrive_time, 'HH24:MI') as "arriveTime",
             jsonb_build_object('code', fp.code, 'nameEn', fp.name_en, 'nameAr', fp.name_ar) as from,
             jsonb_build_object('code', tp.code, 'nameEn', tp.name_en, 'nameAr', tp.name_ar) as to
      from vs.leg l join vs.vessel v on v.id = l.vessel_id
      join vs.port fp on fp.id = l.from_port_id join vs.port tp on tp.id = l.to_port_id
      left join vs.schedule_template_stop st on st.template_id = l.template_id and st.seq = l.from_stop_seq
      left join vs.schedule_template_stop ast on ast.template_id = l.template_id and ast.seq = l.to_stop_seq
      where l.id = ${id}`.execute(tx);
    const mode = options.mode ?? 'boarding';
    // Boarding here: the booking's sailing starts on this departure (date and port); leaving:
    // it ends where this departure arrives; aboard: any booking on it.
    const parties = await sql<
      Omit<CheckinParty, 'guests' | 'checkin' | 'balance'> & {
        bookingId: string;
        total: bigint;
        fees: bigint;
        paid: bigint;
        currency: string;
        passportsSeen: boolean | null;
        cardsSigned: boolean | null;
        keyHanded: boolean | null;
        checkedInAt: Date | null;
      }
    >`
      select bc.id as "bookingCabinId", b.id as "bookingId", b.ref, ch.name as channel,
             jsonb_build_object('code', c.code, 'nameEn', c.name_en, 'nameAr', c.name_ar) as category,
             case when cab.id is null then null
                  else jsonb_build_object('number', cab.number, 'deck', cab.deck) end as cabin,
             bc.adults, bc.child_ages as "childAges",
             jsonb_build_object('date', s.disembark_date, 'port', dp.code) as disembark,
             b.total, b.fees, b.amount_paid as paid, b.currency,
             ci.passports_seen as "passportsSeen", ci.cards_signed as "cardsSigned",
             ci.key_handed as "keyHanded", ci.checked_in_at as "checkedInAt"
      from vs.booking_line bl
      join vs.leg l on l.id = bl.leg_id
      join vs.booking b on b.id = bl.booking_id and b.status = 'confirmed'
      join vs.sailing s on s.id = b.sailing_id
        and (${mode === 'aboard'}
             or (${mode === 'boarding'} and s.embark_date = l.depart_date and s.embark_port_id = l.from_port_id)
             or (${mode === 'leaving'} and s.disembark_date = l.arrive_date and s.disembark_port_id = l.to_port_id))
      join vs.booking_cabin bc on bc.id = bl.booking_cabin_id
      join vs.cabin_category c on c.id = bc.category_id
      join vs.channel ch on ch.id = b.channel_id
      join vs.port dp on dp.id = s.disembark_port_id
      left join vs.cabin cab on cab.id = bl.assigned_cabin_id
      left join vs.checkin ci on ci.leg_id = bl.leg_id and ci.booking_cabin_id = bc.id
      where bl.leg_id = ${id} and bl.status = 'confirmed'
      order by cab.number nulls last, c.sort_order, b.ref, bc.seq`.execute(tx);
    const cabinIds = parties.rows.map((p) => p.bookingCabinId);
    const guests =
      cabinIds.length === 0
        ? []
        : (
            await sql<{
              booking_cabin_id: string;
              first_name: string;
              last_name: string;
              lead: boolean;
              title: string | null;
              gender: string | null;
              nationality: string | null;
              date_of_birth: string | null;
              place_of_birth: string | null;
              passport_country: string | null;
              passport_issued_on: string | null;
              passport_expires_on: string | null;
              passport_ciphertext: Buffer | null;
              passport_key_id: string | null;
              visa_type: string | null;
              visa_ciphertext: Buffer | null;
              visa_key_id: string | null;
              arrival_date: string | null;
              arrival_flight: string | null;
              arrival_port: string | null;
              departure_date: string | null;
              departure_flight: string | null;
              departure_time: string | null;
              phone: string | null;
              emergency_name: string | null;
              emergency_phone: string | null;
              dietary: string[];
              allergies: string | null;
              medical_ciphertext: Buffer | null;
              medical_key_id: string | null;
              occasion: string | null;
              occasion_date: string | null;
            }>`
              select g.booking_cabin_id, g.first_name, g.last_name, g.lead, g.title, g.gender,
                     g.nationality, g.date_of_birth::text, g.place_of_birth, g.passport_country,
                     g.passport_issued_on::text, g.passport_expires_on::text, g.passport_ciphertext,
                     g.passport_key_id, g.visa_type, g.visa_ciphertext, g.visa_key_id,
                     g.arrival_date::text, g.arrival_flight, g.arrival_port, g.departure_date::text,
                     g.departure_flight, to_char(g.departure_time, 'HH24:MI') as departure_time,
                     g.phone, g.emergency_name,
                     g.emergency_phone, g.dietary, g.allergies, g.medical_ciphertext, g.medical_key_id,
                     g.occasion, g.occasion_date::text
              from vs.guest g
              where g.booking_cabin_id = any(${cabinIds}::uuid[])
              order by g.lead desc, g.created_at`.execute(tx)
          ).rows;

    const totals: DepartureCheckin['totals'] = {
      cabins: parties.rows.length,
      guests: 0,
      checkedIn: 0,
      nationalities: {},
      dietary: {},
      occasions: 0,
      warnings: 0,
    };
    const result = parties.rows.map((p) => {
      // A passport should be valid for six months after the cruise ends.
      const sixMonthsAfter = addMonths(p.disembark.date, 6);
      const own = guests
        .filter((g) => g.booking_cabin_id === p.bookingCabinId)
        .map((g): CheckinGuest => {
          const warnings: CheckinGuest['warnings'] = [];
          if (!g.passport_ciphertext) warnings.push('no_passport');
          if (g.passport_expires_on && g.passport_expires_on < leg.rows[0]!.departDate)
            warnings.push('passport_expired');
          else if (g.passport_expires_on && g.passport_expires_on < sixMonthsAfter)
            warnings.push('passport_expiring');
          totals.guests += 1;
          totals.warnings += warnings.length > 0 ? 1 : 0;
          if (g.nationality)
            totals.nationalities[g.nationality] = (totals.nationalities[g.nationality] ?? 0) + 1;
          for (const d of g.dietary) totals.dietary[d] = (totals.dietary[d] ?? 0) + 1;
          if (g.occasion) totals.occasions += 1;
          return {
            firstName: g.first_name,
            lastName: g.last_name,
            lead: g.lead,
            title: g.title,
            gender: g.gender,
            nationality: g.nationality,
            dateOfBirth: g.date_of_birth,
            placeOfBirth: g.place_of_birth,
            passportCountry: g.passport_country,
            passportIssuedOn: g.passport_issued_on,
            passportExpiresOn: g.passport_expires_on,
            hasPassport: g.passport_ciphertext !== null,
            visaType: g.visa_type,
            arrivalDate: g.arrival_date,
            arrivalFlight: g.arrival_flight,
            arrivalPort: g.arrival_port,
            departureDate: g.departure_date,
            departureFlight: g.departure_flight,
            departureTime: g.departure_time,
            phone: g.phone,
            emergencyName: g.emergency_name,
            emergencyPhone: g.emergency_phone,
            dietary: g.dietary,
            allergies: g.allergies,
            hasMedicalNotes: g.medical_ciphertext !== null,
            occasion: g.occasion,
            occasionDate: g.occasion_date,
            warnings,
            ...(options.withSensitive
              ? {
                  passportNumber: decrypt(g.passport_ciphertext, g.passport_key_id),
                  visaNumber: decrypt(g.visa_ciphertext, g.visa_key_id),
                  medicalNotes: decrypt(g.medical_ciphertext, g.medical_key_id),
                }
              : {}),
          };
        });
      if (p.checkedInAt) totals.checkedIn += 1;
      const balance = p.total + p.fees - p.paid;
      return {
        bookingCabinId: p.bookingCabinId,
        ref: p.ref,
        channel: p.channel,
        category: p.category,
        cabin: p.cabin,
        adults: p.adults,
        childAges: p.childAges,
        disembark: p.disembark,
        ...(options.withMoney
          ? { balance: { amount: balance > 0n ? balance : 0n, currency: p.currency } }
          : {}),
        checkin: {
          passportsSeen: p.passportsSeen ?? false,
          cardsSigned: p.cardsSigned ?? false,
          keyHanded: p.keyHanded ?? false,
          checkedInAt: p.checkedInAt,
        },
        guests: own,
      };
    });
    return { leg: leg.rows[0]!, parties: result, totals };
  });
}

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1 + months, d));
  return shifted.toISOString().slice(0, 10);
}

export const setCheckinInput = z.object({
  legId: z.uuid(),
  bookingCabinId: z.uuid(),
  passportsSeen: z.boolean().optional(),
  cardsSigned: z.boolean().optional(),
  keyHanded: z.boolean().optional(),
  /** True marks the cabin checked in now; false undoes it. */
  checkedIn: z.boolean().optional(),
});

/** Ticks the reception's boxes for one cabin boarding one departure. */
export async function setCheckin(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof setCheckinInput>,
  scope: CheckinScope,
) {
  const data = parseInput(setCheckinInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await assertInScope(tx, data.legId, scope);
    const boards = await tx
      .selectFrom('booking_line as bl')
      .innerJoin('booking as b', 'b.id', 'bl.booking_id')
      .select('bl.id')
      .where('bl.leg_id', '=', data.legId)
      .where('bl.booking_cabin_id', '=', data.bookingCabinId)
      .where('bl.status', '=', 'confirmed')
      .where('b.status', '=', 'confirmed')
      .executeTakeFirst();
    if (!boards) throw new DomainError('NOT_FOUND', { message: 'This cabin does not board here' });
    const before = await tx
      .selectFrom('checkin')
      .select(['passports_seen', 'cards_signed', 'key_handed', 'checked_in_at'])
      .where('leg_id', '=', data.legId)
      .where('booking_cabin_id', '=', data.bookingCabinId)
      .forUpdate()
      .executeTakeFirst();
    const next = {
      passports_seen: data.passportsSeen ?? before?.passports_seen ?? false,
      cards_signed: data.cardsSigned ?? before?.cards_signed ?? false,
      key_handed: data.keyHanded ?? before?.key_handed ?? false,
      checked_in_at:
        data.checkedIn === undefined
          ? (before?.checked_in_at ?? null)
          : data.checkedIn
            ? (before?.checked_in_at ?? sql<Date>`now()`)
            : null,
      updated_by: ctx.actor.type === 'staff' ? ctx.actor.id : null,
    };
    const row = await tx
      .insertInto('checkin')
      .values({
        operator_id: ctx.operatorId,
        leg_id: data.legId,
        booking_cabin_id: data.bookingCabinId,
        ...next,
      })
      .onConflict((oc) => oc.columns(['leg_id', 'booking_cabin_id']).doUpdateSet(next))
      .returning(['passports_seen', 'cards_signed', 'key_handed', 'checked_in_at'])
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'checkin.updated',
      entity: 'booking_cabin',
      entityId: data.bookingCabinId,
      before: before
        ? {
            passportsSeen: before.passports_seen,
            cardsSigned: before.cards_signed,
            keyHanded: before.key_handed,
            checkedIn: before.checked_in_at !== null,
          }
        : undefined,
      after: {
        legId: data.legId,
        passportsSeen: row.passports_seen,
        cardsSigned: row.cards_signed,
        keyHanded: row.key_handed,
        checkedIn: row.checked_in_at !== null,
      },
    });
    return {
      passportsSeen: row.passports_seen,
      cardsSigned: row.cards_signed,
      keyHanded: row.key_handed,
      checkedInAt: row.checked_in_at,
    };
  });
}

export const checkinDeparturesInput = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  days: z.number().int().min(1).max(31).default(7),
});

/** Departures with guests boarding, from today (Cairo) by default, with check-in progress. */
export async function checkinDepartures(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof checkinDeparturesInput>,
  scope: CheckinScope,
) {
  const data = parseInput(checkinDeparturesInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const from = data.from ?? (await cairoToday(tx));
    const { rows } = await sql<{
      legId: string;
      vessel: string;
      departDate: string;
      from: string;
      fromAr: string;
      to: string;
      toAr: string;
      cabins: number;
      guests: number;
      checkedIn: number;
    }>`
      select l.id as "legId", v.name as vessel, l.depart_date::text as "departDate",
             fp.name_en as from, fp.name_ar as "fromAr", tp.name_en as to, tp.name_ar as "toAr",
             count(distinct bc.id)::int as cabins,
             count(g.id)::int as guests,
             count(distinct ci.booking_cabin_id) filter (where ci.checked_in_at is not null)::int as "checkedIn"
      from vs.leg l
      join vs.vessel v on v.id = l.vessel_id
      join vs.port fp on fp.id = l.from_port_id join vs.port tp on tp.id = l.to_port_id
      join vs.booking_line bl on bl.leg_id = l.id and bl.status = 'confirmed'
      join vs.booking b on b.id = bl.booking_id and b.status = 'confirmed'
      join vs.sailing s on s.id = b.sailing_id
        and s.embark_date = l.depart_date and s.embark_port_id = l.from_port_id
      join vs.booking_cabin bc on bc.id = bl.booking_cabin_id
      left join vs.guest g on g.booking_cabin_id = bc.id
      left join vs.checkin ci on ci.leg_id = l.id and ci.booking_cabin_id = bc.id
      where l.depart_date >= ${from}::date and l.depart_date < ${from}::date + ${data.days}::int
        and (${scope.vesselId}::uuid is null or l.vessel_id = ${scope.vesselId}::uuid)
      group by l.id, v.name, fp.name_en, fp.name_ar, tp.name_en, tp.name_ar
      order by l.depart_date, v.name`.execute(tx);
    return { from, departures: rows };
  });
}

/** Asks the worker to email the check-in pack for one departure to the vessel now. */
export async function requestCheckinPack(
  db: VsDatabase,
  ctx: EngineContext,
  legId: string,
  scope: CheckinScope,
) {
  const id = parseInput(legIdInput, legId);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await assertInScope(tx, id, scope);
    const vessel = await tx
      .selectFrom('leg')
      .innerJoin('vessel', 'vessel.id', 'leg.vessel_id')
      .select(['vessel.onboard_email'])
      .where('leg.id', '=', id)
      .executeTakeFirstOrThrow();
    if (!vessel.onboard_email)
      throw new DomainError('INVALID_STATE', {
        message: "Set the vessel's on-board email first",
        details: { field: 'onboardEmail' },
      });
    const row = await tx
      .insertInto('checkin_pack_send')
      .values({
        operator_id: ctx.operatorId,
        leg_id: id,
        sent_to: vessel.onboard_email,
        trigger: 'button',
        requested_by: ctx.actor.type === 'staff' ? ctx.actor.id : null,
      })
      .returning(['id', 'sent_to'])
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'checkin_pack.requested',
      entity: 'leg',
      entityId: id,
      after: { sendId: row.id, sentTo: row.sent_to },
    });
    return { sendId: row.id, sentTo: row.sent_to };
  });
}

/**
 * Worker side: queues the scheduled pack for departures entering their vessel's window
 * (departure date and boarding time, Cairo, minus `checkin_pack_hours`; 12:00 when the schedule
 * has no time), then returns every pending send. A scheduled send exists once per departure.
 */
export async function pendingCheckinPacks(
  db: VsDatabase,
  ctx: EngineContext,
  /** The moment to judge the window from (tests); the real time by default. */
  at: Date = new Date(),
) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await sql`
      insert into vs.checkin_pack_send (operator_id, leg_id, sent_to, trigger)
      select l.operator_id, l.id, v.onboard_email, 'scheduled'
      from vs.leg l join vs.vessel v on v.id = l.vessel_id
      left join vs.schedule_template_stop st on st.template_id = l.template_id and st.seq = l.from_stop_seq
      where v.checkin_pack_hours is not null and v.onboard_email is not null and l.status <> 'cancelled'
        and ((l.depart_date + coalesce(st.depart_time, time '12:00')) at time zone 'Africa/Cairo')
            between ${at}::timestamptz and ${at}::timestamptz + make_interval(hours => v.checkin_pack_hours)
        and exists (select from vs.booking_line bl where bl.leg_id = l.id and bl.status = 'confirmed')
      on conflict (leg_id) where trigger = 'scheduled' do nothing`.execute(tx);
    return tx
      .selectFrom('checkin_pack_send')
      .select(['id', 'leg_id as legId', 'sent_to as sentTo', 'trigger'])
      .where('status', '=', 'pending')
      .orderBy('created_at')
      .execute();
  });
}

/** Worker side: records how a send ended. Never stores file content or guest data. */
export async function finishCheckinPack(
  db: VsDatabase,
  ctx: EngineContext,
  sendId: string,
  outcome: { sent: true } | { sent: false; error: string },
) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await tx
      .updateTable('checkin_pack_send')
      .set(
        outcome.sent
          ? { status: 'sent', sent_at: sql<Date>`now()`, error: null }
          : { status: 'failed', error: outcome.error.slice(0, 500) },
      )
      .where('id', '=', sendId)
      .execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: outcome.sent ? 'checkin_pack.sent' : 'checkin_pack.failed',
      entity: 'checkin_pack_send',
      entityId: sendId,
    });
  });
}

/** The latest sends for one departure (status for the screen). */
export async function checkinPackSends(
  db: VsDatabase,
  ctx: EngineContext,
  legId: string,
  scope: CheckinScope,
) {
  const id = parseInput(legIdInput, legId);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await assertInScope(tx, id, scope);
    return tx
      .selectFrom('checkin_pack_send')
      .select([
        'id',
        'sent_to as sentTo',
        'trigger',
        'status',
        'error',
        'sent_at as sentAt',
        'created_at as createdAt',
      ])
      .where('leg_id', '=', id)
      .orderBy('created_at', 'desc')
      .limit(5)
      .execute();
  });
}
