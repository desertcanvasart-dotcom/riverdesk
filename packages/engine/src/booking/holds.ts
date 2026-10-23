import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import { parseInput, type EngineContext, type Tx } from '../internal';
import { loadQuote, useQuote, type Quote } from '../pricing/quote';
import {
  auditBooking,
  bookingEvent,
  guestSchema,
  holdEvent,
  insertBooking,
  insertBookingLines,
  needsFor,
  replaceGuests,
  requestKeySchema,
  sailingLegs,
  withRequestKey,
  writeRevision,
} from './common';
import { holdToBooked, releaseUnits, takeUnits } from './units';

/** The contract terms a transition needs. */
export async function loadContract(tx: Tx, contractId: string) {
  return tx
    .selectFrom('channel_contract')
    .selectAll()
    .where('id', '=', contractId)
    .executeTakeFirstOrThrow();
}

export function assertContractSells(contract: { active: boolean; stop_sell: boolean }) {
  if (!contract.active)
    throw new DomainError('CONTRACT_FORBIDS', { message: 'The contract is not active' });
  if (contract.stop_sell)
    throw new DomainError('CONTRACT_FORBIDS', { message: 'Sales are stopped for this channel' });
}

export async function assertSailingOpen(tx: Tx, sailingId: string) {
  const sailing = await tx
    .selectFrom('sailing')
    .select(['status'])
    .where('id', '=', sailingId)
    .executeTakeFirstOrThrow();
  const legs = await sailingLegs(tx, sailingId);
  if (sailing.status !== 'open' || legs.some((leg) => leg.status !== 'open')) {
    throw new DomainError('SAILING_CLOSED', { details: { sailingId } });
  }
  return legs;
}

/** Bank-transfer payment hold length from the quote's payment policy snapshot. */
export function paymentHoldHours(quote: Quote): number {
  return (quote.policies.payment as { bank_transfer_hold_hours: number }).bank_transfer_hold_hours;
}

/** Inserts the hold row and takes its cabins on every leg (held += n). */
export async function openHold(
  tx: Tx,
  ctx: EngineContext,
  options: {
    quote: Quote;
    contract: { id: string; allocation: string };
    kind: 'checkout' | 'option' | 'offer' | 'payment';
    bookingId?: string;
    expiresAt: ReturnType<typeof sql<Date>>;
  },
) {
  const legs = await assertSailingOpen(tx, options.quote.sailingId);
  const hold = await tx
    .insertInto('hold')
    .values({
      operator_id: ctx.operatorId,
      channel_id: options.quote.channelId,
      contract_id: options.contract.id,
      quote_id: options.quote.id,
      booking_id: options.bookingId ?? null,
      kind: options.kind,
      expires_at: options.expiresAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const cabins = options.quote.cabins as { categoryId: string }[];
  const taken = await takeUnits(tx, ctx, {
    channelId: options.quote.channelId,
    allocation: options.contract.allocation,
    needs: needsFor(
      cabins,
      legs.map((leg) => leg.id),
    ),
    field: 'held',
    cause: `hold.${options.kind}`,
    ref: { entity: 'hold', id: hold.id },
  });
  await tx
    .insertInto('hold_line')
    .values(
      taken.map((t) => ({
        operator_id: ctx.operatorId,
        hold_id: hold.id,
        leg_id: t.legId,
        category_id: t.categoryId,
        bucket_id: t.bucketId,
        n: t.n,
      })),
    )
    .execute();
  return { hold, taken };
}

// ---------------------------------------------------------------------------
// Create hold (checkout or option)
// ---------------------------------------------------------------------------
export const createHoldInput = z.object({
  channelId: z.uuid(),
  quoteId: z.uuid(),
  kind: z.enum(['checkout', 'option']),
  requestKey: requestKeySchema,
});

export interface HoldResult {
  holdId: string;
  kind: string;
  expiresAt: Date;
  lines: { legId: string; categoryId: string; bucketId: string; n: number }[];
}

/**
 * Holds cabins from a valid quote of the same channel; TTL from the contract (checkout or
 * option), never beyond the quote's expiry. Refused on on-request contracts.
 */
export async function createHold(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createHoldInput>,
): Promise<HoldResult> {
  const data = parseInput(createHoldInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    withRequestKey(
      tx,
      ctx,
      { scopeId: data.channelId, key: data.requestKey, action: 'hold.create', input: data },
      async () => {
        const quote = await useQuote(tx, data.quoteId, data.channelId);
        const contract = await loadContract(tx, quote.contractId);
        assertContractSells(contract);
        if (contract.allocation === 'on_request') {
          throw new DomainError('CONTRACT_FORBIDS', {
            message: 'This contract sells on request only',
          });
        }
        const ttl =
          data.kind === 'checkout'
            ? sql`make_interval(mins => ${contract.checkout_hold_minutes})`
            : sql`make_interval(hours => ${contract.option_hold_hours})`;
        const { hold, taken } = await openHold(tx, ctx, {
          quote,
          contract,
          kind: data.kind,
          expiresAt: sql<Date>`least(now() + ${ttl}, ${quote.expiresAt}::timestamptz)`,
        });
        await audit(tx, ctx.operatorId, ctx.actor, {
          action: 'hold.created',
          entity: 'hold',
          entityId: hold.id,
          after: { kind: hold.kind, quote_id: quote.id, expires_at: hold.expires_at },
        });
        return {
          holdId: hold.id,
          kind: hold.kind,
          expiresAt: hold.expires_at,
          lines: taken.map(({ legId, categoryId, bucketId, n }) => ({
            legId,
            categoryId,
            bucketId,
            n,
          })),
        };
      },
    ),
  );
}

async function diagnoseHold(tx: Tx, holdId: string): Promise<never> {
  const { rows } = await sql<{ status: string; expired: boolean; kind: string }>`
    select status, kind, expires_at <= now() as expired from vs.hold where id = ${holdId}`.execute(
    tx,
  );
  const hold = rows[0];
  if (!hold) throw new DomainError('NOT_FOUND', { message: 'Hold not found' });
  if (hold.status === 'expired' || (hold.status === 'active' && hold.expired))
    throw new DomainError('HOLD_EXPIRED');
  throw new DomainError('HOLD_NOT_ACTIVE', { details: { status: hold.status, kind: hold.kind } });
}

/** Moves a hold's cabins to booked lines of a booking. */
export async function bookHoldLines(
  tx: Tx,
  ctx: EngineContext,
  holdId: string,
  bookingId: string,
  sailingId: string,
) {
  const lines = await tx
    .selectFrom('hold_line')
    .selectAll()
    .where('hold_id', '=', holdId)
    .execute();
  await holdToBooked(
    tx,
    ctx,
    lines.map((l) => ({
      bucketId: l.bucket_id,
      legId: l.leg_id,
      categoryId: l.category_id,
      n: l.n,
    })),
    'booking.confirmed',
    { entity: 'booking', id: bookingId },
  );
  const cabins = await tx
    .selectFrom('booking_cabin')
    .select(['id', 'category_id'])
    .where('booking_id', '=', bookingId)
    .where('status', '=', 'active')
    .execute();
  const legs = await sailingLegs(tx, sailingId);
  const bucket = new Map(lines.map((l) => [`${l.leg_id}|${l.category_id}`, l.bucket_id]));
  await insertBookingLines(
    tx,
    ctx,
    bookingId,
    cabins,
    legs.map((l) => l.id),
    (legId, categoryId) => {
      const id = bucket.get(`${legId}|${categoryId}`);
      if (!id)
        throw new DomainError('INVARIANT_VIOLATION', {
          details: { reason: 'hold has no line for a leg', legId, categoryId },
        });
      return id;
    },
  );
}

// ---------------------------------------------------------------------------
// Confirm hold
// ---------------------------------------------------------------------------
export const confirmHoldInput = z.object({
  holdId: z.uuid(),
  guests: z.array(guestSchema).min(1),
  /** The channel's own reference, unique per channel forever. */
  channelRef: z.string().min(1).max(100).optional(),
  requestKey: requestKeySchema,
});

export interface ConfirmResult {
  bookingId: string;
  ref: string;
  /** 'confirmed', or 'held' while a prepaid booking waits for its deposit. */
  status: string;
  /** Set for a prepaid booking: when its payment hold runs out. */
  paymentDueBy?: Date;
  /** True when the channel_ref already existed and that booking is returned. */
  existing?: boolean;
  /** Why a confirmation became something else (e.g. 'credit_limit' → a request). */
  reason?: string;
}

/**
 * Guard: hold.status = 'active' AND expires_at > now(). Channels that collect payment themselves,
 * and credit channels, are confirmed at once (held → booked). A prepaid booking keeps its cabins
 * on a payment hold until the deposit arrives (Batch 4 records payments).
 */
export async function confirmHold(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof confirmHoldInput>,
): Promise<ConfirmResult> {
  const data = parseInput(confirmHoldInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const peek = await tx
      .selectFrom('hold')
      .select(['channel_id', 'contract_id'])
      .where('id', '=', data.holdId)
      .executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', { message: 'Hold not found' });
    return withRequestKey(
      tx,
      ctx,
      { scopeId: peek.channel_id, key: data.requestKey, action: 'hold.confirm', input: data },
      async () => {
        if (data.channelRef) {
          const existing = await tx
            .selectFrom('booking')
            .select(['id', 'ref', 'status'])
            .where('channel_id', '=', peek.channel_id)
            .where('channel_ref', '=', data.channelRef)
            .executeTakeFirst();
          if (existing)
            return {
              bookingId: existing.id,
              ref: existing.ref,
              status: existing.status,
              existing: true,
            };
        }
        const contract = await loadContract(tx, peek.contract_id);
        const prepaid = contract.payment_mode === 'vessel_prepaid';
        const hold = prepaid
          ? undefined
          : await tx
              .updateTable('hold')
              .set({ status: 'confirmed', ended_at: sql<Date>`now()` })
              .where('id', '=', data.holdId)
              .where('status', '=', 'active')
              .where('kind', 'in', ['checkout', 'option'])
              .where(sql<boolean>`expires_at > now()`)
              .returningAll()
              .executeTakeFirst();
        const quote = await loadQuote(
          tx,
          (
            await tx
              .selectFrom('hold')
              .select('quote_id')
              .where('id', '=', data.holdId)
              .executeTakeFirstOrThrow()
          ).quote_id,
        );

        if (!prepaid) {
          if (!hold) return diagnoseHold(tx, data.holdId);
          if (
            contract.payment_mode === 'credit' &&
            (await exceedsCredit(tx, peek.channel_id, quote))
          ) {
            return creditRequest(tx, ctx, {
              hold,
              quote,
              contract,
              channelRef: data.channelRef,
              guests: data.guests,
            });
          }
          const { booking } = await insertBooking(tx, ctx, {
            quote,
            contractId: contract.id,
            status: 'confirmed',
            channelRef: data.channelRef,
          });
          await tx
            .updateTable('hold')
            .set({ booking_id: booking.id })
            .where('id', '=', hold.id)
            .execute();
          await bookHoldLines(tx, ctx, hold.id, booking.id, quote.sailingId);
          await replaceGuests(tx, ctx, booking.id, data.guests);
          await writeRevision(tx, ctx, {
            bookingId: booking.id,
            rev: 1,
            quote,
            reason: 'confirmed',
          });
          await tx
            .updateTable('booking')
            .set({ revision: 1 })
            .where('id', '=', booking.id)
            .execute();
          await bookingEvent(tx, ctx, booking.id, 'booking.confirmed', {
            total: booking.total.toString(),
            currency: booking.currency,
          });
          await auditBooking(tx, ctx, 'booking.confirmed', booking.id, null, {
            ref: booking.ref,
            hold_id: hold.id,
            total: booking.total,
          });
          return { bookingId: booking.id, ref: booking.ref, status: 'confirmed' };
        }

        // Prepaid: the hold becomes the booking's payment hold (cabins stay held).
        const { booking } = await insertBooking(tx, ctx, {
          quote,
          contractId: contract.id,
          status: 'held',
          channelRef: data.channelRef,
        });
        const converted = await tx
          .updateTable('hold')
          .set({
            kind: 'payment',
            booking_id: booking.id,
            expires_at: sql<Date>`now() + make_interval(hours => ${paymentHoldHours(quote)})`,
          })
          .where('id', '=', data.holdId)
          .where('status', '=', 'active')
          .where('kind', 'in', ['checkout', 'option'])
          .where(sql<boolean>`expires_at > now()`)
          .returningAll()
          .executeTakeFirst();
        if (!converted) return diagnoseHold(tx, data.holdId);
        await replaceGuests(tx, ctx, booking.id, data.guests);
        await auditBooking(tx, ctx, 'booking.held', booking.id, null, {
          ref: booking.ref,
          hold_id: converted.id,
          payment_due_by: converted.expires_at,
        });
        return {
          bookingId: booking.id,
          ref: booking.ref,
          status: 'held',
          paymentDueBy: converted.expires_at,
        };
      },
    );
  });
}

export const confirmPaymentHoldInput = z.object({ bookingId: z.uuid() });

/**
 * Confirms a prepaid booking while its payment hold is active (held → booked). Batch 4 calls this
 * when the deposit is recorded; it refuses once the hold has expired.
 */
export async function confirmPaymentHoldInTx(
  tx: Tx,
  ctx: EngineContext,
  bookingId: string,
): Promise<ConfirmResult> {
  const pending = await tx
    .selectFrom('hold')
    .select('id')
    .where('booking_id', '=', bookingId)
    .where('kind', '=', 'payment')
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!pending)
    throw new DomainError('HOLD_NOT_ACTIVE', { message: 'The booking has no active payment hold' });
  const hold = await tx
    .updateTable('hold')
    .set({ status: 'confirmed', ended_at: sql<Date>`now()` })
    .where('id', '=', pending.id)
    .where('status', '=', 'active')
    .where(sql<boolean>`expires_at > now()`)
    .returningAll()
    .executeTakeFirst();
  if (!hold) return diagnoseHold(tx, pending.id);
  const booking = await tx
    .updateTable('booking')
    .set({ status: 'confirmed', confirmed_at: sql<Date>`now()`, revision: 1 })
    .where('id', '=', bookingId)
    .where('status', '=', 'held')
    .returningAll()
    .executeTakeFirst();
  if (!booking)
    throw new DomainError('INVALID_STATE', { message: 'The booking is not waiting for payment' });
  const quote = await loadQuote(tx, booking.quote_id);
  await bookHoldLines(tx, ctx, hold.id, booking.id, booking.sailing_id);
  await writeRevision(tx, ctx, { bookingId: booking.id, rev: 1, quote, reason: 'confirmed' });
  await bookingEvent(tx, ctx, booking.id, 'booking.confirmed', {
    total: booking.total.toString(),
    currency: booking.currency,
  });
  await auditBooking(
    tx,
    ctx,
    'booking.confirmed',
    booking.id,
    { status: 'held' },
    { status: 'confirmed', hold_id: hold.id },
  );
  return { bookingId: booking.id, ref: booking.ref, status: 'confirmed' };
}

export async function confirmPaymentHold(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof confirmPaymentHoldInput>,
) {
  const data = parseInput(confirmPaymentHoldInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    confirmPaymentHoldInTx(tx, ctx, data.bookingId),
  );
}

// ---------------------------------------------------------------------------
// Release and expiry
// ---------------------------------------------------------------------------
export const releaseHoldInput = z.object({ holdId: z.uuid(), requestKey: requestKeySchema });

/** The customer abandons a checkout or option: status 'active' → 'released', held −= n. */
export async function releaseHold(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof releaseHoldInput>,
) {
  const data = parseInput(releaseHoldInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const hold = await tx
      .updateTable('hold')
      .set({ status: 'released', ended_at: sql<Date>`now()` })
      .where('id', '=', data.holdId)
      .where('status', '=', 'active')
      .where('kind', 'in', ['checkout', 'option'])
      .returningAll()
      .executeTakeFirst();
    if (!hold) return diagnoseHold(tx, data.holdId);
    await releaseHoldLines(tx, ctx, [hold.id], 'hold.released');
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'hold.released',
      entity: 'hold',
      entityId: hold.id,
      before: { status: 'active' },
      after: { status: 'released' },
    });
    return { holdId: hold.id, status: 'released' };
  });
}

export async function releaseHoldLines(
  tx: Tx,
  ctx: EngineContext,
  holdIds: string[],
  cause: string,
) {
  if (holdIds.length === 0) return;
  const lines = await tx
    .selectFrom('hold_line')
    .select(['bucket_id', 'n', 'hold_id'])
    .where('hold_id', 'in', holdIds)
    .execute();
  await releaseUnits(
    tx,
    ctx,
    lines.map((l) => ({ bucketId: l.bucket_id, n: l.n, field: 'held' as const })),
    cause,
    holdIds.length === 1 ? { entity: 'hold', id: holdIds[0]! } : null,
  );
}

export const expireHoldsInput = z.object({ limit: z.number().int().min(1).max(5000).default(500) });

/**
 * Worker job (every minute). Guard: status = 'active' AND expires_at <= now(), batches with
 * FOR UPDATE SKIP LOCKED so it never waits on a hold that is being confirmed. Expired payment
 * holds expire their booking; expired offer holds expire the offer and the request.
 */
export async function expireHolds(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof expireHoldsInput> = {},
) {
  const data = parseInput(expireHoldsInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows: due } = await sql<{ id: string }>`
      select id from vs.hold
      where status = 'active' and expires_at <= now()
      order by expires_at, id
      limit ${data.limit}
      for update skip locked`.execute(tx);
    if (due.length === 0) return { expired: 0 };
    const expired = await tx
      .updateTable('hold')
      .set({ status: 'expired', ended_at: sql<Date>`now()` })
      .where(
        'id',
        'in',
        due.map((d) => d.id),
      )
      .where('status', '=', 'active')
      .where(sql<boolean>`expires_at <= now()`)
      .returning(['id', 'kind', 'booking_id'])
      .execute();
    await releaseHoldLines(
      tx,
      ctx,
      expired.map((h) => h.id),
      'hold.expired',
    );

    for (const hold of expired) {
      if (hold.kind === 'payment' && hold.booking_id) {
        const booking = await tx
          .updateTable('booking')
          .set({ status: 'expired' })
          .where('id', '=', hold.booking_id)
          .where('status', '=', 'held')
          .returning('id')
          .executeTakeFirst();
        if (booking)
          await bookingEvent(tx, ctx, booking.id, 'hold.expired', {
            reason: 'payment_hold_expired',
          });
      }
      if (hold.kind === 'offer' && hold.booking_id) {
        await tx
          .updateTable('offer')
          .set({ status: 'expired' })
          .where('hold_id', '=', hold.id)
          .where('status', '=', 'open')
          .execute();
        const booking = await tx
          .updateTable('booking')
          .set({ status: 'expired' })
          .where('id', '=', hold.booking_id)
          .where('status', '=', 'offered')
          .returning('id')
          .executeTakeFirst();
        if (booking)
          await bookingEvent(tx, ctx, booking.id, 'request.decided', { decision: 'offer_expired' });
      }
    }
    await holdEvent(
      tx,
      ctx,
      expired.map((h) => h.id),
      'hold.expired',
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'holds.expired',
      entity: 'hold',
      entityId: null,
      after: { count: expired.length },
    });
    return { expired: expired.length };
  });
}

// ---------------------------------------------------------------------------
// Agent credit (spec § Credit rules)
// ---------------------------------------------------------------------------

/**
 * True when the agent's unpaid confirmed bookings plus this one exceed its credit limit. Credit is
 * off until set per agent; a booking in another currency than the limit counts as over it.
 * Locks the channel row so two confirmations of one agent cannot both pass the check.
 */
export async function exceedsCredit(tx: Tx, channelId: string, quote: Quote): Promise<boolean> {
  const channel = await tx
    .selectFrom('channel')
    .selectAll()
    .where('id', '=', channelId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (!channel.credit_allowed || channel.credit_limit === null) return true;
  if (channel.credit_currency !== quote.currency) return true;
  const { rows } = await sql<{ exposure: string }>`
    select coalesce(sum(total + fees - amount_paid), 0)::text as exposure
    from vs.booking
    where channel_id = ${channelId} and status = 'confirmed' and currency = ${quote.currency}`.execute(
    tx,
  );
  return BigInt(rows[0]!.exposure) + quote.total > channel.credit_limit;
}

/**
 * Over the limit: the booking becomes a request for staff approval and the hold is released at
 * once (docs/decisions.md). Staff accepting the request approve the credit.
 */
async function creditRequest(
  tx: Tx,
  ctx: EngineContext,
  options: {
    hold: { id: string };
    quote: Quote;
    contract: { id: string; request_sla_hours: number };
    channelRef?: string;
    guests: z.infer<typeof guestSchema>[];
  },
): Promise<ConfirmResult> {
  await tx
    .updateTable('hold')
    .set({ status: 'released' })
    .where('id', '=', options.hold.id)
    .execute();
  await releaseHoldLines(tx, ctx, [options.hold.id], 'hold.credit_limit');
  const { booking } = await insertBooking(tx, ctx, {
    quote: options.quote,
    contractId: options.contract.id,
    status: 'requested',
    channelRef: options.channelRef,
    requestExpiresAt: sql<Date>`now() + make_interval(hours => ${options.contract.request_sla_hours}
      + (select request_grace_hours from vs.operator_setting))`,
  });
  await tx
    .updateTable('hold')
    .set({ booking_id: booking.id })
    .where('id', '=', options.hold.id)
    .execute();
  await replaceGuests(tx, ctx, booking.id, options.guests);
  await auditBooking(tx, ctx, 'booking.credit_limit_request', booking.id, null, {
    ref: booking.ref,
    hold_id: options.hold.id,
    total: booking.total,
  });
  return { bookingId: booking.id, ref: booking.ref, status: 'requested', reason: 'credit_limit' };
}
