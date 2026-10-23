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
  const { rows } = await sql<{ id: string }>`
    insert into vs.idempotency_key (operator_id, scope_id, key, request_hash)
    values (${ctx.operatorId}, ${options.scopeId}, ${options.key}, ${hash})
    on conflict (operator_id, scope_id, key) do nothing
    returning id`.execute(tx);
  if (rows[0]) {
    const result = await run();
    await sql`
      update vs.idempotency_key set status = 'done', response_body = ${JSON.stringify(encodeResult(result))}::jsonb
      where id = ${rows[0].id}`.execute(tx);
    return result;
  }
  const existing = await tx
    .selectFrom('idempotency_key')
    .select(['request_hash', 'status', 'response_body'])
    .where('scope_id', '=', options.scopeId)
    .where('key', '=', options.key)
    .executeTakeFirstOrThrow();
  if (existing.request_hash !== hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED');
  if (existing.status !== 'done') throw new DomainError('IN_PROGRESS');
  return decodeResult(existing.response_body) as T;
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
  lead: z.boolean().default(false),
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
    .select(['id', 'first_name', 'last_name', 'nationality', 'date_of_birth', 'lead'])
    .where('booking_id', '=', bookingId)
    .execute();
  await tx.deleteFrom('guest').where('booking_id', '=', bookingId).execute();
  const keys = passportKeys();
  await tx
    .insertInto('guest')
    .values(
      guests.map((g) => ({
        operator_id: ctx.operatorId,
        booking_id: bookingId,
        booking_cabin_id: bySeq.get(g.cabin)!.id,
        first_name: g.firstName,
        last_name: g.lastName,
        nationality: g.nationality ?? null,
        date_of_birth: g.dateOfBirth ?? null,
        passport_ciphertext: g.passportNumber ? encryptField(g.passportNumber, keys.current) : null,
        passport_key_id: g.passportNumber ? keys.current.id : null,
        lead: g.lead,
      })),
    )
    .execute();

  await flagAgeMismatches(tx, ctx, bookingId, guests, cabins);
  await audit(tx, ctx.operatorId, ctx.actor, {
    action: 'guests.replaced',
    entity: 'booking',
    entityId: bookingId,
    before: { guests: before.length },
    // Counts only: passport numbers never reach the audit log (rule 9).
    after: { guests: guests.length, passports: guests.filter((g) => g.passportNumber).length },
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
