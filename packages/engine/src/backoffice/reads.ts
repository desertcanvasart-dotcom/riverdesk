import { sql } from 'kysely';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { mulDivHalfUp } from '@vs/shared';
import { daysBeforeEmbark, latestPolicies, penaltyBps } from '../booking/cancel';
import { getBookingView, type BookingView } from '../channel/reads';
import type { EngineContext } from '../internal';

/** Read models for the back-office screens (staff see every channel of their own company). */

export async function listVessels(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const vessels = await tx
      .selectFrom('vessel')
      .select(['id', 'code', 'name', 'type'])
      .where('active', '=', true)
      .orderBy('name')
      .execute();
    const categories = await tx
      .selectFrom('cabin_category')
      .select([
        'id',
        'vessel_id',
        'code',
        'name_en',
        'name_ar',
        'max_adults',
        'max_occupancy',
        'sort_order',
      ])
      .orderBy('sort_order')
      .execute();
    return vessels.map((v) => ({
      ...v,
      categories: categories.filter((c) => c.vessel_id === v.id),
    }));
  });
}

/** Channels staff can book for: the back office (direct guests) and every agent or portal with an active contract. */
export async function listBookableChannels(db: VsDatabase, ctx: EngineContext, vesselId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
      id: string;
      code: string;
      name: string;
      type: string;
      payment_mode: string;
      allocation: string;
      markets: string[];
    }>`
      select c.id, c.code, c.name, c.type, k.payment_mode, k.allocation,
             coalesce((select array_agg(distinct rp.market order by rp.market)
                       from vs.channel_contract_rate_plan kr join vs.rate_plan rp on rp.id = kr.rate_plan_id
                       where kr.contract_id = k.id), '{}') as markets
      from vs.channel c join vs.channel_contract k on k.channel_id = c.id and k.active and k.vessel_id = ${vesselId}
      where c.active
      order by (c.type = 'back_office') desc, c.name`.execute(tx);
    return rows;
  });
}

export interface BookingListItem {
  id: string;
  ref: string;
  status: string;
  paymentStatus: string;
  channel: string;
  channelRef: string | null;
  leadGuest: string | null;
  embarkDate: string;
  patternCode: string | null;
  nights: number;
  cabins: number;
  total: bigint;
  currency: string;
  createdAt: Date;
}

/** Search by reference, guest name, agency or embark date range. */
export async function searchBookings(
  db: VsDatabase,
  ctx: EngineContext,
  input: {
    q?: string;
    status?: string;
    from?: string;
    to?: string;
    channelId?: string;
    limit?: number;
  },
): Promise<BookingListItem[]> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const q = input.q?.trim();
    const like = q ? `%${q.replace(/[%_]/g, '')}%` : null;
    const { rows } = await sql<BookingListItem>`
      select b.id, b.ref, b.status, b.payment_status as "paymentStatus", ch.name as channel, b.channel_ref as "channelRef",
             (select g.first_name || ' ' || g.last_name from vs.guest g where g.booking_id = b.id and g.lead limit 1) as "leadGuest",
             s.embark_date::text as "embarkDate", sp.code as "patternCode", s.nights,
             (select count(*)::int from vs.booking_cabin bc where bc.booking_id = b.id and bc.status = 'active') as cabins,
             b.total, b.currency, b.created_at as "createdAt"
      from vs.booking b
      join vs.channel ch on ch.id = b.channel_id
      join vs.sailing s on s.id = b.sailing_id
      left join vs.sailing_pattern sp on sp.id = s.pattern_id
      where true
        ${
          like
            ? sql`and (b.ref ilike ${like} or b.channel_ref ilike ${like} or ch.name ilike ${like}
                    or exists (select from vs.guest g where g.booking_id = b.id
                               and (g.first_name || ' ' || g.last_name) ilike ${like}))`
            : sql``
        }
        ${input.status ? sql`and b.status = ${input.status}` : sql``}
        ${input.from ? sql`and s.embark_date >= ${input.from}::date` : sql``}
        ${input.to ? sql`and s.embark_date <= ${input.to}::date` : sql``}
        ${input.channelId ? sql`and b.channel_id = ${input.channelId}` : sql``}
      order by b.created_at desc
      limit ${Math.min(input.limit ?? 50, 200)}`.execute(tx);
    return rows;
  });
}

export interface BookingDetail extends BookingView {
  id: string;
  channel: { id: string; name: string; type: string; paymentMode: string };
  depositAmount: bigint;
  balanceDueDate: string | null;
  guests: {
    id: string;
    cabin: number;
    firstName: string;
    lastName: string;
    nationality: string | null;
    dateOfBirth: string | null;
    hasPassport: boolean;
    lead: boolean;
    // Check-in details (Batch D2). Visa numbers and medical notes are never sent back.
    title: string | null;
    gender: string | null;
    passportCountry: string | null;
    passportIssuedOn: string | null;
    passportExpiresOn: string | null;
    placeOfBirth: string | null;
    visaType: string | null;
    hasVisaNumber: boolean;
    arrivalDate: string | null;
    arrivalFlight: string | null;
    arrivalPort: string | null;
    language: string | null;
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
  }[];
  revisions: {
    rev: number;
    reason: string;
    total: bigint;
    fee: bigint;
    actor: string | null;
    createdAt: Date;
  }[];
  payments: {
    id: string;
    kind: string;
    method: string;
    amount: bigint;
    currency: string;
    fxRate: string | null;
    bookingAmount: bigint;
    reference: string;
    receivedOn: string;
    reversed: boolean;
    createdAt: Date;
  }[];
  holdId: string | null;
}

/** Everything the booking screen shows. Passport numbers stay encrypted: only "on file" is shown. */
export async function getBookingDetail(
  db: VsDatabase,
  ctx: EngineContext,
  ref: string,
): Promise<BookingDetail> {
  const found = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx.selectFrom('booking').select('id').where('ref', '=', ref).executeTakeFirst(),
  );
  if (!found) throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
  const view = await getBookingView(db, ctx, found.id);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const b = await tx
      .selectFrom('booking as b')
      .innerJoin('channel as c', 'c.id', 'b.channel_id')
      .innerJoin('channel_contract as k', 'k.id', 'b.contract_id')
      .select([
        'b.id',
        'b.deposit_amount',
        'b.balance_due_date',
        'c.id as channel_id',
        'c.name as channel_name',
        'c.type as channel_type',
        'k.payment_mode',
      ])
      .where('b.id', '=', found.id)
      .executeTakeFirstOrThrow();
    const guests = await sql<BookingDetail['guests'][number]>`
      select g.id, bc.seq as cabin, g.first_name as "firstName", g.last_name as "lastName", g.nationality,
             g.date_of_birth::text as "dateOfBirth", g.passport_ciphertext is not null as "hasPassport", g.lead,
             g.title, g.gender, g.passport_country as "passportCountry",
             g.passport_issued_on::text as "passportIssuedOn", g.passport_expires_on::text as "passportExpiresOn",
             g.place_of_birth as "placeOfBirth", g.visa_type as "visaType",
             g.visa_ciphertext is not null as "hasVisaNumber", g.arrival_date::text as "arrivalDate",
             g.arrival_flight as "arrivalFlight", g.arrival_port as "arrivalPort",
             g.language, g.departure_date::text as "departureDate", g.departure_flight as "departureFlight",
             to_char(g.departure_time, 'HH24:MI') as "departureTime", g.phone,
             g.emergency_name as "emergencyName", g.emergency_phone as "emergencyPhone", g.dietary,
             g.allergies, g.medical_ciphertext is not null as "hasMedicalNotes", g.occasion,
             g.occasion_date::text as "occasionDate"
      from vs.guest g join vs.booking_cabin bc on bc.id = g.booking_cabin_id
      where g.booking_id = ${found.id} order by g.lead desc, bc.seq, g.created_at`.execute(tx);
    const revisions = await sql<BookingDetail['revisions'][number]>`
      select r.rev, r.reason, r.total, r.fee, coalesce(s.display_name, r.actor_label, r.actor_type) as actor, r.created_at as "createdAt"
      from vs.booking_revision r left join vs.staff_user s on s.id = r.actor_id
      where r.booking_id = ${found.id} order by r.rev`.execute(tx);
    const payments = await sql<BookingDetail['payments'][number]>`
      select p.id, p.kind, p.method, p.amount, p.currency, p.fx_rate as "fxRate", p.booking_amount as "bookingAmount",
             p.reference, p.received_on::text as "receivedOn",
             exists (select from vs.payment r where r.reverses_payment_id = p.id) as reversed, p.created_at as "createdAt"
      from vs.payment p where p.booking_id = ${found.id} order by p.created_at`.execute(tx);
    const hold = await tx
      .selectFrom('hold')
      .select('id')
      .where('booking_id', '=', found.id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return {
      ...view,
      id: b.id,
      channel: {
        id: b.channel_id,
        name: b.channel_name,
        type: b.channel_type,
        paymentMode: b.payment_mode,
      },
      depositAmount: b.deposit_amount,
      balanceDueDate: b.balance_due_date,
      guests: guests.rows,
      revisions: revisions.rows,
      payments: payments.rows,
      holdId: hold?.id ?? null,
    };
  });
}

/** The penalty a cancellation would apply today (shown before staff confirm it). */
export async function previewCancellation(db: VsDatabase, ctx: EngineContext, bookingId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const b = await tx
      .selectFrom('booking')
      .select(['id', 'status', 'total', 'currency', 'sailing_id'])
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow();
    if (b.status === 'held')
      return {
        daysBefore: null,
        penaltyBps: 0,
        penalty: 0n,
        currency: b.currency,
      };
    const days = await daysBeforeEmbark(tx, b.sailing_id);
    const bps = penaltyBps(await latestPolicies(tx, b.id), days);
    const penalty = mulDivHalfUp(b.total, BigInt(bps), 10_000n);
    return {
      daysBefore: days,
      penaltyBps: bps,
      penalty,
      currency: b.currency,
    };
  });
}

export interface RequestItem {
  bookingId: string;
  ref: string;
  status: string;
  channel: string;
  channelId: string;
  sailingId: string;
  vesselId: string;
  embarkDate: string;
  patternCode: string | null;
  nights: number;
  cabins: { categoryId: string; code: string; adults: number; childAges: number[] }[];
  total: bigint;
  currency: string;
  market: string;
  expiresAt: Date | null;
  offer: { id: string; embarkDate: string; patternCode: string | null; expiresAt: Date } | null;
  createdAt: Date;
}

/** The requests inbox: open requests and open offers, the most urgent first. */
export async function listRequests(db: VsDatabase, ctx: EngineContext): Promise<RequestItem[]> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<RequestItem>`
      select b.id as "bookingId", b.ref, b.status, ch.name as channel, ch.id as "channelId", s.id as "sailingId", s.vessel_id as "vesselId",
             s.embark_date::text as "embarkDate", sp.code as "patternCode", s.nights, b.total, b.currency, b.market,
             b.request_expires_at as "expiresAt", b.created_at as "createdAt",
             (select jsonb_agg(jsonb_build_object('categoryId', bc.category_id, 'code', c.code, 'adults', bc.adults, 'childAges', bc.child_ages) order by bc.seq)
              from vs.booking_cabin bc join vs.cabin_category c on c.id = bc.category_id
              where bc.booking_id = b.id and bc.status = 'active') as cabins,
             (select jsonb_build_object('id', o.id, 'embarkDate', os.embark_date, 'patternCode', osp.code, 'expiresAt', o.expires_at)
              from vs.offer o join vs.quote oq on oq.id = o.quote_id join vs.sailing os on os.id = oq.sailing_id
              left join vs.sailing_pattern osp on osp.id = os.pattern_id
              where o.booking_id = b.id and o.status = 'open') as offer
      from vs.booking b
      join vs.channel ch on ch.id = b.channel_id
      join vs.sailing s on s.id = b.sailing_id
      left join vs.sailing_pattern sp on sp.id = s.pattern_id
      where b.status in ('requested', 'offered')
      order by coalesce(b.request_expires_at, b.created_at)`.execute(tx);
    return rows.map((r) => ({
      ...r,
      offer: r.offer ? { ...r.offer, expiresAt: new Date(r.offer.expiresAt) } : null,
    }));
  });
}
