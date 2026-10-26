import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import {
  ageOn,
  encryptField,
  fieldKeyring,
  loadConfig,
  type BusinessDate,
  type FieldKeyring,
} from '@vs/shared';
import { audit } from '../audit';
import { cairoToday, emitEvents, openException, type EngineContext, type Tx } from '../internal';
import { dateSchema } from '../schedule/setup';
import type { Quote } from '../pricing/quote';

// ---------------------------------------------------------------------------
// Request keys: a repeat with the same key returns the first result (back-office double clicks).
// The key row is inserted in the same transaction as the write, so a concurrent duplicate waits
// on the unique index and then reads the committed result.
// ---------------------------------------------------------------------------

/** JSON that keeps bigint and Date values. */
export function encodeResult(value: unknown): unknown {
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(encodeResult);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeResult(v)]));
  return value;
}

export function decodeResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeResult);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$bigint === 'string') return BigInt(record.$bigint);
    if (typeof record.$date === 'string') return new Date(record.$date);
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decodeResult(v)]));
  }
  return value;
}

/**
 * Runs `run` once per (scope, key) — the scope is the channel — and stores its result in the
 * same transaction as the work, so a crash after commit can never lose the result (spec test 6).
 * - A concurrent duplicate gets IN_PROGRESS at once (transaction-scoped advisory lock).
 * - The same key with a different body gets IDEMPOTENCY_KEY_REUSED.
 * - A completed key replays its result for 7 days; after that the key is free again.
 */
export async function withRequestKey<T>(
  tx: Tx,
  ctx: EngineContext,
  options: { scopeId: string; key: string | undefined; action: string; input: unknown },
  run: () => Promise<T>,
): Promise<T> {
  if (!options.key) return run();
  const hash = createHash('sha256')
    .update(options.action)
    .update(JSON.stringify(encodeResult(options.input)))
    .digest('hex');
  const { rows: lock } = await sql<{ locked: boolean }>`
    select pg_try_advisory_xact_lock(hashtextextended(${`${options.scopeId}:${options.key}`}, 0)) as locked`.execute(
    tx,
  );
  if (!lock[0]!.locked) throw new DomainError('IN_PROGRESS');

  const existing = await tx
    .selectFrom('idempotency_key')
    .select([
      'id',
      'request_hash',
      'status',
      'response_body',
      sql<boolean>`expires_at <= now()`.as('expired'),
    ])
    .where('scope_id', '=', options.scopeId)
    .where('key', '=', options.key)
    .executeTakeFirst();
  let keyId: string;
  if (existing && !existing.expired) {
    if (existing.request_hash !== hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED');
    if (existing.status !== 'done') throw new DomainError('IN_PROGRESS');
    return decodeResult(existing.response_body) as T;
  } else if (existing) {
    await sql`
      update vs.idempotency_key
      set request_hash = ${hash}, status = 'in_progress', response_body = null, expires_at = now() + interval '7 days'
      where id = ${existing.id}`.execute(tx);
    keyId = existing.id;
  } else {
    const { rows } = await sql<{ id: string }>`
      insert into vs.idempotency_key (operator_id, scope_id, key, request_hash)
      values (${ctx.operatorId}, ${options.scopeId}, ${options.key}, ${hash})
      returning id`.execute(tx);
    keyId = rows[0]!.id;
  }
  const result = await run();
  await sql`
    update vs.idempotency_key set status = 'done', response_body = ${JSON.stringify(encodeResult(result))}::jsonb
    where id = ${keyId}`.execute(tx);
  return result;
}

export const requestKeySchema = z.string().min(1).max(255).optional();

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export interface QuotedCabin {
  categoryId: string;
  adults: number;
  childAges: number[];
}

export async function nextBookingRef(tx: Tx): Promise<string> {
  const { rows } = await sql<{ ref: string }>`
    select s.booking_ref_prefix || '-' || to_char(now() at time zone 'Africa/Cairo', 'YY') || '-' ||
           lpad(nextval('vs.booking_ref_seq')::text, 5, '0') as ref
    from vs.operator_setting s`.execute(tx);
  return rows[0]!.ref;
}

export async function insertBooking(
  tx: Tx,
  ctx: EngineContext,
  options: {
    quote: Quote;
    contractId: string;
    status: 'requested' | 'held' | 'confirmed';
    channelRef?: string | null;
    requestExpiresAt?: ReturnType<typeof sql<Date>>;
  },
) {
  const sailing = await tx
    .selectFrom('sailing')
    .select(['vessel_id'])
    .where('id', '=', options.quote.sailingId)
    .executeTakeFirstOrThrow();
  const ref = await nextBookingRef(tx);
  const market = (options.quote.policies.rate_plan as { market: string }).market;
  const booking = await tx
    .insertInto('booking')
    .values({
      operator_id: ctx.operatorId,
      ref,
      channel_id: options.quote.channelId,
      contract_id: options.contractId,
      channel_ref: options.channelRef ?? null,
      vessel_id: sailing.vessel_id,
      sailing_id: options.quote.sailingId,
      quote_id: options.quote.id,
      rate_plan_id: options.quote.ratePlanId,
      status: options.status,
      market,
      currency: options.quote.currency,
      total: options.quote.total,
      net_total: options.quote.netTotal,
      request_expires_at: options.requestExpiresAt ?? null,
      confirmed_at: options.status === 'confirmed' ? sql<Date>`now()` : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const cabins = await insertCabins(tx, ctx, booking.id, options.quote.cabins as QuotedCabin[]);
  await refreshPaymentTerms(tx, booking.id);
  return { booking, cabins };
}

export async function insertCabins(
  tx: Tx,
  ctx: EngineContext,
  bookingId: string,
  cabins: QuotedCabin[],
  firstSeq = 0,
) {
  if (cabins.length === 0) return [];
  return tx
    .insertInto('booking_cabin')
    .values(
      cabins.map((cabin, i) => ({
        operator_id: ctx.operatorId,
        booking_id: bookingId,
        seq: firstSeq + i,
        category_id: cabin.categoryId,
        adults: cabin.adults,
        child_ages: cabin.childAges,
      })),
    )
    .returning(['id', 'seq', 'category_id'])
    .execute();
}

export async function sailingLegs(tx: Tx, sailingId: string) {
  return tx
    .selectFrom('sailing_leg as sl')
    .innerJoin('leg as l', 'l.id', 'sl.leg_id')
    .select(['l.id', 'l.depart_date', 'l.status'])
    .where('sl.sailing_id', '=', sailingId)
    .orderBy('sl.seq')
    .execute();
}

/** One cabin per category per leg of the sailing. */
export function needsFor(cabins: { categoryId: string }[], legIds: string[]) {
  return legIds.flatMap((legId) =>
    cabins.map((cabin) => ({ legId, categoryId: cabin.categoryId, n: 1 })),
  );
}

/** booking_line rows: every cabin on every leg, from the bucket chosen for its leg × category. */
export async function insertBookingLines(
  tx: Tx,
  ctx: EngineContext,
  bookingId: string,
  cabins: { id: string; category_id: string }[],
  legIds: string[],
  bucketFor: (legId: string, categoryId: string) => string,
) {
  const rows = legIds.flatMap((legId) =>
    cabins.map((cabin) => ({
      operator_id: ctx.operatorId,
      booking_id: bookingId,
      booking_cabin_id: cabin.id,
      leg_id: legId,
      category_id: cabin.category_id,
      bucket_id: bucketFor(legId, cabin.category_id),
    })),
  );
  if (rows.length > 0) await tx.insertInto('booking_line').values(rows).execute();
}

export async function writeRevision(
  tx: Tx,
  ctx: EngineContext,
  options: {
    bookingId: string;
    rev: number;
    quote: Quote;
    reason: string;
    fee?: bigint;
    extra?: Record<string, unknown>;
  },
) {
  await tx
    .insertInto('booking_revision')
    .values({
      operator_id: ctx.operatorId,
      booking_id: options.bookingId,
      rev: options.rev,
      quote_id: options.quote.id,
      sailing_id: options.quote.sailingId,
      currency: options.quote.currency,
      total: options.quote.total,
      net_total: options.quote.netTotal,
      fee: options.fee ?? 0n,
      snapshot: JSON.stringify({
        lines: options.quote.lines,
        cabins: options.quote.cabins,
        policies: options.quote.policies,
        ...options.extra,
      }),
      reason: options.reason,
      actor_type: ctx.actor.type,
      actor_id: ctx.actor.type === 'system' ? null : ctx.actor.id,
      actor_label: ctx.actor.label ?? null,
    })
    .execute();
}

/** Bumps the booking version and emits one event about it (no personal data in the payload). */
export async function bookingEvent(
  tx: Tx,
  ctx: EngineContext,
  bookingId: string,
  type: string,
  payload: Record<string, unknown> = {},
) {
  const booking = await tx
    .updateTable('booking')
    .set((eb) => ({ version: eb('version', '+', 1n) }))
    .where('id', '=', bookingId)
    .returning([
      'id',
      'ref',
      'status',
      'version',
      'revision',
      'channel_id',
      'channel_ref',
      'sailing_id',
    ])
    .executeTakeFirstOrThrow();
  await emitEvents(tx, ctx, [
    {
      type,
      resource: 'booking',
      resourceId: booking.id,
      version: booking.version,
      payload: {
        ref: booking.ref,
        status: booking.status,
        revision: booking.revision,
        channel_id: booking.channel_id,
        channel_ref: booking.channel_ref,
        sailing_id: booking.sailing_id,
        ...payload,
      },
    },
  ]);
}

export async function holdEvent(tx: Tx, ctx: EngineContext, holdIds: string[], type: string) {
  if (holdIds.length === 0) return;
  const holds = await tx
    .updateTable('hold')
    .set((eb) => ({ version: eb('version', '+', 1n) }))
    .where('id', 'in', holdIds)
    .returning(['id', 'version', 'kind', 'channel_id', 'booking_id'])
    .execute();
  await emitEvents(
    tx,
    ctx,
    holds.map((h) => ({
      type,
      resource: 'hold',
      resourceId: h.id,
      version: h.version,
      payload: { kind: h.kind, channel_id: h.channel_id, booking_id: h.booking_id },
    })),
  );
}

export async function auditBooking(
  tx: Tx,
  ctx: EngineContext,
  action: string,
  bookingId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
) {
  await audit(tx, ctx.operatorId, ctx.actor, {
    action,
    entity: 'booking',
    entityId: bookingId,
    before,
    after,
  });
}

// ---------------------------------------------------------------------------
// Guests (rule 9: passport numbers encrypted, never logged or audited)
// ---------------------------------------------------------------------------
export const GUEST_TITLES = ['mr', 'mrs', 'ms', 'miss', 'dr'] as const;
export const VISA_TYPES = ['e_visa', 'on_arrival', 'sticker', 'residence', 'not_required'] as const;
export const DIETARY = [
  'vegetarian',
  'vegan',
  'halal',
  'kosher',
  'gluten_free',
  'lactose_free',
  'no_pork',
  'no_seafood',
  'diabetic',
] as const;
export const OCCASIONS = ['birthday', 'honeymoon', 'anniversary', 'other'] as const;

/**
 * The personal check-in details erased with the passport number: after the retention period
 * following disembarkation, and on a guest's erasure request. Names stay for accounting.
 */
export const ERASED_CHECKIN_DETAILS = {
  date_of_birth: null,
  passport_ciphertext: null,
  passport_key_id: null,
  passport_country: null,
  passport_issued_on: null,
  passport_expires_on: null,
  place_of_birth: null,
  visa_type: null,
  visa_ciphertext: null,
  visa_key_id: null,
  arrival_date: null,
  arrival_flight: null,
  arrival_port: null,
  phone: null,
  emergency_name: null,
  emergency_phone: null,
  dietary: [],
  allergies: null,
  medical_ciphertext: null,
  medical_key_id: null,
  occasion: null,
  occasion_date: null,
} as const;

export const guestSchema = z.object({
  /** Index of the cabin in the booking (0-based). */
  cabin: z.number().int().min(0),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  nationality: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  dateOfBirth: dateSchema.optional(),
  passportNumber: z.string().trim().min(3).max(30).optional(),
  /**
   * An existing guest of this booking: keeps their passport number, visa number and medical
   * notes on file when no new value is given (they are never sent back to the screen).
   */
  keepPassportOf: z.uuid().optional(),
  lead: z.boolean().default(false),
  // Check-in details (Batch D2), all optional.
  title: z.enum(GUEST_TITLES).optional(),
  gender: z.enum(['female', 'male']).optional(),
  passportCountry: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  passportIssuedOn: dateSchema.optional(),
  passportExpiresOn: dateSchema.optional(),
  placeOfBirth: z.string().trim().min(1).max(100).optional(),
  visaType: z.enum(VISA_TYPES).optional(),
  visaNumber: z.string().trim().min(3).max(40).optional(),
  arrivalDate: dateSchema.optional(),
  arrivalFlight: z.string().trim().min(1).max(20).optional(),
  arrivalPort: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().min(3).max(30).optional(),
  emergencyName: z.string().trim().min(1).max(100).optional(),
  emergencyPhone: z.string().trim().min(3).max(30).optional(),
  dietary: z.array(z.enum(DIETARY)).max(DIETARY.length).optional(),
  allergies: z.string().trim().min(1).max(300).optional(),
  medicalNotes: z.string().trim().min(1).max(500).optional(),
  occasion: z.enum(OCCASIONS).optional(),
  occasionDate: dateSchema.optional(),
});
export type GuestInput = z.infer<typeof guestSchema>;

let keyring: FieldKeyring | undefined;
function passportKeys(): FieldKeyring {
  keyring ??= fieldKeyring(loadConfig());
  return keyring;
}

/**
 * Replaces the booking's guests. Exactly one lead guest. A guest whose date of birth puts them in
 * a different child age than was quoted is flagged on the action list (not repriced).
 */
export async function replaceGuests(
  tx: Tx,
  ctx: EngineContext,
  bookingId: string,
  guests: GuestInput[],
) {
  if (guests.filter((g) => g.lead).length !== 1) {
    throw new DomainError('VALIDATION_FAILED', { message: 'Exactly one lead guest is required' });
  }
  const cabins = await tx
    .selectFrom('booking_cabin')
    .select(['id', 'seq', 'adults', 'child_ages'])
    .where('booking_id', '=', bookingId)
    .where('status', '=', 'active')
    .orderBy('seq')
    .execute();
  const bySeq = new Map(cabins.map((c) => [c.seq, c]));
  for (const guest of guests) {
    if (!bySeq.has(guest.cabin))
      throw new DomainError('VALIDATION_FAILED', {
        message: `No cabin ${guest.cabin} in this booking`,
      });
  }
  const before = await tx
    .selectFrom('guest')
    .select([
      'id',
      'first_name',
      'last_name',
      'nationality',
      'date_of_birth',
      'lead',
      'passport_ciphertext',
      'passport_key_id',
      'visa_ciphertext',
      'visa_key_id',
      'medical_ciphertext',
      'medical_key_id',
    ])
    .where('booking_id', '=', bookingId)
    .execute();
  const previousOf = new Map(before.map((g) => [g.id, g]));
  const kept = new Map(before.filter((g) => g.passport_ciphertext).map((g) => [g.id, g]));
  await tx.deleteFrom('guest').where('booking_id', '=', bookingId).execute();
  const keys = passportKeys();
  await tx
    .insertInto('guest')
    .values(
      guests.map((g) => {
        const previous =
          !g.passportNumber && g.keepPassportOf ? kept.get(g.keepPassportOf) : undefined;
        const prior = g.keepPassportOf ? previousOf.get(g.keepPassportOf) : undefined;
        const visa = g.visaNumber
          ? {
              visa_ciphertext: encryptField(g.visaNumber, keys.current),
              visa_key_id: keys.current.id,
            }
          : {
              visa_ciphertext: prior?.visa_ciphertext ?? null,
              visa_key_id: prior?.visa_key_id ?? null,
            };
        const medical = g.medicalNotes
          ? {
              medical_ciphertext: encryptField(g.medicalNotes, keys.current),
              medical_key_id: keys.current.id,
            }
          : {
              medical_ciphertext: prior?.medical_ciphertext ?? null,
              medical_key_id: prior?.medical_key_id ?? null,
            };
        return {
          operator_id: ctx.operatorId,
          booking_id: bookingId,
          booking_cabin_id: bySeq.get(g.cabin)!.id,
          first_name: g.firstName,
          last_name: g.lastName,
          nationality: g.nationality ?? null,
          date_of_birth: g.dateOfBirth ?? null,
          passport_ciphertext: g.passportNumber
            ? encryptField(g.passportNumber, keys.current)
            : (previous?.passport_ciphertext ?? null),
          passport_key_id: g.passportNumber ? keys.current.id : (previous?.passport_key_id ?? null),
          lead: g.lead,
          title: g.title ?? null,
          gender: g.gender ?? null,
          passport_country: g.passportCountry ?? null,
          passport_issued_on: g.passportIssuedOn ?? null,
          passport_expires_on: g.passportExpiresOn ?? null,
          place_of_birth: g.placeOfBirth ?? null,
          visa_type: g.visaType ?? null,
          ...visa,
          arrival_date: g.arrivalDate ?? null,
          arrival_flight: g.arrivalFlight ?? null,
          arrival_port: g.arrivalPort ?? null,
          phone: g.phone ?? null,
          emergency_name: g.emergencyName ?? null,
          emergency_phone: g.emergencyPhone ?? null,
          dietary: g.dietary ?? [],
          allergies: g.allergies ?? null,
          ...medical,
          occasion: g.occasion ?? null,
          occasion_date: g.occasionDate ?? null,
        };
      }),
    )
    .execute();

  await flagAgeMismatches(tx, ctx, bookingId, guests, cabins);
  await audit(tx, ctx.operatorId, ctx.actor, {
    action: 'guests.replaced',
    entity: 'booking',
    entityId: bookingId,
    before: { guests: before.length, passports: kept.size },
    // Counts only: passport numbers never reach the audit log (rule 9).
    after: {
      guests: guests.length,
      passports: guests.filter(
        (g) => g.passportNumber || (g.keepPassportOf && kept.has(g.keepPassportOf)),
      ).length,
    },
  });
}

async function flagAgeMismatches(
  tx: Tx,
  ctx: EngineContext,
  bookingId: string,
  guests: GuestInput[],
  cabins: { id: string; seq: number; child_ages: number[] }[],
) {
  const booking = await tx
    .selectFrom('booking as b')
    .innerJoin('sailing as s', 's.id', 'b.sailing_id')
    .innerJoin('quote as q', 'q.id', 'b.quote_id')
    .select(['b.ref', 's.embark_date', 'q.policies'])
    .where('b.id', '=', bookingId)
    .executeTakeFirstOrThrow();
  const embark = booking.embark_date as BusinessDate;
  const child = (
    booking.policies as {
      child?: { adult_from_age: number; bands: { age_from: number; age_to: number }[] };
    }
  ).child;
  if (!child) return;
  // The price band an age falls in: a child band index, or 'adult'.
  const band = (age: number) =>
    age >= child.adult_from_age
      ? 'adult'
      : String(child.bands.findIndex((b) => age >= b.age_from && age <= b.age_to));
  const mismatches: { cabin: number; quoted: number[]; actual: number[] }[] = [];
  for (const cabin of cabins) {
    const quoted = cabin.child_ages.map(band);
    const actual = guests
      .filter((g) => g.cabin === cabin.seq && g.dateOfBirth)
      .map((g) => ageOn(g.dateOfBirth!, embark))
      .filter((age) => age < child.adult_from_age);
    const unmatched = actual.filter((age) => {
      const i = quoted.indexOf(band(age));
      if (i < 0) return true;
      quoted.splice(i, 1);
      return false;
    });
    if (unmatched.length > 0)
      mismatches.push({ cabin: cabin.seq, quoted: cabin.child_ages, actual });
  }
  if (mismatches.length === 0) return;
  await openException(tx, ctx, {
    kind: 'guest_age_mismatch',
    severity: 'warning',
    summary: `Booking ${booking.ref}: a child's date of birth falls in a different price band than quoted`,
    refs: [{ entity: 'booking', id: bookingId }],
    details: { mismatches },
    dedupeKey: `guest_age_mismatch:${bookingId}`,
  });
}

export async function assertBeforeCutoff(tx: Tx, sailingId: string) {
  const { rows } = await sql<{ open: boolean }>`
    select (s.embark_date - st.assignment_cutoff_days) > (now() at time zone 'Africa/Cairo')::date as open
    from vs.sailing s cross join vs.operator_setting st where s.id = ${sailingId}`.execute(tx);
  if (!rows[0]?.open)
    throw new DomainError('INVALID_STATE', {
      message: 'Guest details are closed after the manifest cut-off',
    });
}

export { cairoToday };

// ---------------------------------------------------------------------------
// Payment terms (Batch 4)
// ---------------------------------------------------------------------------

/**
 * Deposit (deposit % of the total, rounded half-up once) and balance due date (embarkation −
 * balance_due_days) from the booking's quote policy snapshot; then the payment status.
 */
export async function refreshPaymentTerms(tx: Tx, bookingId: string) {
  await sql`
    update vs.booking b
    set deposit_amount = (b.total * (q.policies->'payment'->>'deposit_bps')::bigint * 2 + 10000) / 20000,
        -- Never before the booking date: a last-minute booking owes its balance at once.
        balance_due_date = greatest(s.embark_date - (q.policies->'payment'->>'balance_due_days')::int,
                                    (b.created_at at time zone 'Africa/Cairo')::date)
    from vs.quote q, vs.sailing s
    where b.id = ${bookingId} and q.id = b.quote_id and s.id = b.sailing_id`.execute(tx);
  await refreshPaymentStatus(tx, bookingId);
}

/**
 * unpaid → deposit_paid → paid while the booking stands; after a cancellation (or when paid but
 * unavailable) refund_due while more was received than is kept, then refunded.
 */
export async function refreshPaymentStatus(tx: Tx, bookingId: string) {
  await sql`
    update vs.booking b set payment_status = case
      when b.status in ('cancelled', 'paid_unavailable') then case
        when b.amount_paid - coalesce(b.penalty_amount, 0) - b.fees > 0 then 'refund_due'
        when exists (select from vs.payment p where p.booking_id = b.id and p.kind = 'refund') then 'refunded'
        when b.amount_paid > 0 then 'paid'
        else 'unpaid' end
      when b.amount_paid >= b.total + b.fees then 'paid'
      when b.deposit_amount > 0 and b.amount_paid >= b.deposit_amount then 'deposit_paid'
      else 'unpaid' end
    where b.id = ${bookingId}`.execute(tx);
}
