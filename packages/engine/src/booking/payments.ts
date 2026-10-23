import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError, isDomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { convert, currencySchema, money } from '@vs/shared';
import { audit } from '../audit';
import { openException, parseInput, type EngineContext, type Tx } from '../internal';
import { loadQuote } from '../pricing/quote';
import { dateSchema } from '../schedule/setup';
import { cancelBooking } from './cancel';
import {
  auditBooking,
  bookingEvent,
  insertBookingLines,
  needsFor,
  refreshPaymentStatus,
  requestKeySchema,
  sailingLegs,
  withRequestKey,
  writeRevision,
} from './common';
import { confirmPaymentHoldInTx, loadContract, releaseHoldLines } from './holds';
import { takeUnits } from './units';

/**
 * Payments (spec § Payments policy). The ledger is append-only: receipts are positive, refunds
 * and reversals negative, and a correction is always a new entry. Amounts are recorded in the
 * currency received, with the booking-currency equivalent beside them.
 */

const positiveMinor = z
  .union([z.bigint(), z.number().int()])
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n, 'Must be positive');
const fxRateSchema = z
  .string()
  .regex(/^[0-9]+(\.[0-9]{1,6})?$/, 'A decimal rate with at most 6 decimals');

export const recordPaymentInput = z.object({
  bookingId: z.uuid(),
  kind: z.enum(['deposit', 'balance', 'payment']).default('payment'),
  method: z.enum([
    'bank_transfer',
    'cash',
    'card_office',
    'agent_remittance',
    'channel',
    'gateway',
  ]),
  amount: positiveMinor,
  currency: currencySchema,
  /** 1 unit of `currency` = fxRate units of the booking currency. Required when they differ. */
  fxRate: fxRateSchema.optional(),
  reference: z.string().trim().min(1).max(200),
  receivedOn: dateSchema,
  note: z.string().max(500).optional(),
  requestKey: requestKeySchema,
});

function bookingAmount(
  amount: bigint,
  currency: string,
  bookingCurrency: string,
  fxRate: string | undefined,
): bigint {
  if (currency === bookingCurrency) {
    if (fxRate && fxRate !== '1')
      throw new DomainError('VALIDATION_FAILED', {
        message: 'No exchange rate for a payment in the booking currency',
      });
    return amount;
  }
  if (!fxRate) {
    throw new DomainError('VALIDATION_FAILED', {
      message: `An exchange rate is required to record ${currency} against a ${bookingCurrency} booking`,
    });
  }
  return convert(money(amount, currency), fxRate, bookingCurrency).amount;
}

async function insertPayment(
  tx: Tx,
  ctx: EngineContext,
  values: {
    bookingId: string;
    kind: string;
    method: string;
    amount: bigint;
    currency: string;
    fxRate: string | null;
    bookingAmount: bigint;
    reference: string;
    receivedOn: string;
    reversesPaymentId?: string;
    note?: string | null;
  },
) {
  const payment = await tx
    .insertInto('payment')
    .values({
      operator_id: ctx.operatorId,
      booking_id: values.bookingId,
      kind: values.kind,
      method: values.method,
      amount: values.amount,
      currency: values.currency,
      fx_rate: values.fxRate,
      booking_amount: values.bookingAmount,
      reference: values.reference,
      received_on: values.receivedOn,
      reverses_payment_id: values.reversesPaymentId ?? null,
      note: values.note ?? null,
      actor_type: ctx.actor.type,
      actor_id: ctx.actor.type === 'system' ? null : ctx.actor.id,
      actor_label: ctx.actor.label ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await tx
    .updateTable('booking')
    .set({ amount_paid: sql<bigint>`amount_paid + ${values.bookingAmount}` })
    .where('id', '=', values.bookingId)
    .execute();
  await refreshPaymentStatus(tx, values.bookingId);
  return payment;
}

export interface PaymentResult {
  paymentId: string;
  bookingId: string;
  /** The booking's status after the payment: confirmed, held, paid_unavailable, … */
  bookingStatus: string;
  paymentStatus: string;
  bookingAmount: bigint;
}

/**
 * Records a payment. For a prepaid booking waiting on its payment hold, a payment that brings the
 * total received to the deposit confirms it in the same transaction. If the hold has expired, the
 * engine tries to take the cabins again; if they are gone, the booking becomes paid_unavailable,
 * an exception is raised and the channel is told — it is never confirmed without cabins.
 */
export async function recordPayment(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof recordPaymentInput>,
): Promise<PaymentResult> {
  const data = parseInput(recordPaymentInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const peek = await tx
      .selectFrom('booking')
      .selectAll()
      .where('id', '=', data.bookingId)
      .executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
    return withRequestKey(
      tx,
      ctx,
      { scopeId: peek.channel_id, key: data.requestKey, action: 'payment.record', input: data },
      async () => {
        const amountInBooking = bookingAmount(
          data.amount,
          data.currency,
          peek.currency,
          data.fxRate,
        );
        const reachesDeposit = peek.amount_paid + amountInBooking >= peek.deposit_amount;
        const hadPaymentHold = await tx
          .selectFrom('hold')
          .select('id')
          .where('booking_id', '=', peek.id)
          .where('kind', '=', 'payment')
          .executeTakeFirst();

        let outcome: 'recorded' | 'confirmed' | 'paid_unavailable' = 'recorded';
        if (peek.status === 'held' && reachesDeposit) {
          // Holds before bookings: confirmPaymentHoldInTx guards the hold row first.
          try {
            await confirmPaymentHoldInTx(tx, ctx, peek.id);
            outcome = 'confirmed';
          } catch (error) {
            if (!isDomainError(error, 'HOLD_EXPIRED')) throw error;
            outcome = await retakeOrFlag(tx, ctx, peek.id);
          }
        } else if (peek.status === 'expired' && hadPaymentHold && reachesDeposit) {
          outcome = await retakeOrFlag(tx, ctx, peek.id);
        } else if (
          !['held', 'expired', 'confirmed', 'completed', 'paid_unavailable'].includes(
            peek.status,
          ) ||
          (peek.status === 'expired' && !hadPaymentHold)
        ) {
          throw new DomainError('INVALID_STATE', {
            message: `Payments cannot be recorded on a ${peek.status} booking`,
          });
        }

        // Lock the booking row for the ledger update (after any hold work above).
        await tx.selectFrom('booking').select('id').where('id', '=', peek.id).forUpdate().execute();
        const payment = await insertPayment(tx, ctx, {
          bookingId: peek.id,
          kind: data.kind,
          method: data.method,
          amount: data.amount,
          currency: data.currency,
          fxRate: data.currency === peek.currency ? null : data.fxRate!,
          bookingAmount: amountInBooking,
          reference: data.reference,
          receivedOn: data.receivedOn,
          note: data.note,
        });
        const after = await tx
          .selectFrom('booking')
          .select(['status', 'payment_status'])
          .where('id', '=', peek.id)
          .executeTakeFirstOrThrow();
        await bookingEvent(tx, ctx, peek.id, 'payment.recorded', {
          payment_id: payment.id,
          kind: payment.kind,
          amount: payment.amount.toString(),
          currency: payment.currency,
          booking_amount: amountInBooking.toString(),
          payment_status: after.payment_status,
          outcome,
        });
        await audit(tx, ctx.operatorId, ctx.actor, {
          action: 'payment.recorded',
          entity: 'payment',
          entityId: payment.id,
          after: {
            booking_id: peek.id,
            kind: payment.kind,
            method: payment.method,
            amount: payment.amount,
            currency: payment.currency,
            fx_rate: payment.fx_rate,
            booking_amount: amountInBooking,
            reference: payment.reference,
            outcome,
          },
        });
        return {
          paymentId: payment.id,
          bookingId: peek.id,
          bookingStatus: after.status,
          paymentStatus: after.payment_status,
          bookingAmount: amountInBooking,
        };
      },
    );
  });
}

/**
 * Payment after the payment hold expired: same transition as a new hold, then confirm (booked +=
 * n on every leg) inside a savepoint. If any leg is full, roll that back and mark the booking
 * paid_unavailable with a critical exception for the action list.
 */
async function retakeOrFlag(
  tx: Tx,
  ctx: EngineContext,
  bookingId: string,
): Promise<'confirmed' | 'paid_unavailable'> {
  // Finish the expiry the worker has not run yet: hold first, its cabins back to the buckets.
  const stale = await tx
    .updateTable('hold')
    .set({ status: 'expired', ended_at: sql<Date>`now()` })
    .where('booking_id', '=', bookingId)
    .where('kind', '=', 'payment')
    .where('status', '=', 'active')
    .where(sql<boolean>`expires_at <= now()`)
    .returning('id')
    .execute();
  await releaseHoldLines(
    tx,
    ctx,
    stale.map((h) => h.id),
    'hold.expired',
  );

  const booking = await tx
    .selectFrom('booking')
    .selectAll()
    .where('id', '=', bookingId)
    .where('status', 'in', ['held', 'expired'])
    .forUpdate()
    .executeTakeFirst();
  if (!booking)
    throw new DomainError('INVALID_STATE', {
      message: 'The booking changed while the payment was recorded',
    });
  const contract = await loadContract(tx, booking.contract_id);
  const cabins = await tx
    .selectFrom('booking_cabin')
    .select(['id', 'category_id'])
    .where('booking_id', '=', bookingId)
    .where('status', '=', 'active')
    .execute();
  const legs = await sailingLegs(tx, booking.sailing_id);

  await sql`savepoint retake`.execute(tx);
  try {
    const taken = await takeUnits(tx, ctx, {
      channelId: booking.channel_id,
      allocation: contract.allocation,
      needs: needsFor(
        cabins.map((c) => ({ categoryId: c.category_id })),
        legs.map((l) => l.id),
      ),
      field: 'booked',
      cause: 'payment.late_confirm',
      ref: { entity: 'booking', id: bookingId },
    });
    const bucket = new Map(taken.map((t) => [`${t.legId}|${t.categoryId}`, t.bucketId]));
    await insertBookingLines(
      tx,
      ctx,
      bookingId,
      cabins,
      legs.map((l) => l.id),
      (legId, categoryId) => bucket.get(`${legId}|${categoryId}`)!,
    );
    await sql`release savepoint retake`.execute(tx);
  } catch (error) {
    if (!isDomainError(error, 'NOT_AVAILABLE') && !isDomainError(error, 'SAILING_CLOSED'))
      throw error;
    await sql`rollback to savepoint retake`.execute(tx);
    await tx
      .updateTable('booking')
      .set({ status: 'paid_unavailable' })
      .where('id', '=', bookingId)
      .execute();
    await openException(tx, ctx, {
      kind: 'paid_unavailable',
      severity: 'critical',
      summary: `Booking ${booking.ref} was paid after its hold expired and the cabins are no longer available`,
      refs: [{ entity: 'booking', id: bookingId }],
      details: { reason: error.code, offer_alternative_or_refund: true },
      dedupeKey: `paid_unavailable:${bookingId}`,
    });
    await bookingEvent(tx, ctx, bookingId, 'booking.paid_unavailable', { reason: error.code });
    await auditBooking(
      tx,
      ctx,
      'booking.paid_unavailable',
      bookingId,
      { status: booking.status },
      { status: 'paid_unavailable' },
    );
    return 'paid_unavailable';
  }

  await tx
    .updateTable('booking')
    .set({ status: 'confirmed', confirmed_at: sql<Date>`now()`, revision: 1 })
    .where('id', '=', bookingId)
    .execute();
  await writeRevision(tx, ctx, {
    bookingId,
    rev: 1,
    quote: await loadQuote(tx, booking.quote_id),
    reason: 'confirmed after late payment',
  });
  await bookingEvent(tx, ctx, bookingId, 'booking.confirmed', {
    total: booking.total.toString(),
    currency: booking.currency,
    late_payment: true,
  });
  await auditBooking(
    tx,
    ctx,
    'booking.confirmed',
    bookingId,
    { status: booking.status },
    { status: 'confirmed', late_payment: true },
  );
  return 'confirmed';
}

export const reversePaymentInput = z.object({
  paymentId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});

/** A payment is never edited or deleted: a reversal is a new, opposite entry (once per payment). */
export async function reversePayment(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof reversePaymentInput>,
) {
  const data = parseInput(reversePaymentInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const original = await tx
      .selectFrom('payment')
      .selectAll()
      .where('id', '=', data.paymentId)
      .executeTakeFirst();
    if (!original) throw new DomainError('NOT_FOUND', { message: 'Payment not found' });
    if (original.kind === 'reversal')
      throw new DomainError('INVALID_STATE', { message: 'A reversal cannot be reversed' });
    await tx
      .selectFrom('booking')
      .select('id')
      .where('id', '=', original.booking_id)
      .forUpdate()
      .execute();
    const already = await tx
      .selectFrom('payment')
      .select('id')
      .where('reverses_payment_id', '=', original.id)
      .executeTakeFirst();
    if (already)
      throw new DomainError('INVALID_STATE', { message: 'The payment is already reversed' });
    const reversal = await insertPayment(tx, ctx, {
      bookingId: original.booking_id,
      kind: 'reversal',
      method: original.method,
      amount: -original.amount,
      currency: original.currency,
      fxRate: original.fx_rate,
      bookingAmount: -original.booking_amount,
      reference: `reversal of ${original.reference}`,
      receivedOn: (
        await sql<{
          d: string;
        }>`select (now() at time zone 'Africa/Cairo')::date::text as d`.execute(tx)
      ).rows[0]!.d,
      reversesPaymentId: original.id,
      note: data.reason,
    });
    await bookingEvent(tx, ctx, original.booking_id, 'payment.recorded', {
      payment_id: reversal.id,
      kind: 'reversal',
      reverses: original.id,
      booking_amount: reversal.booking_amount.toString(),
    });
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'payment.reversed',
      entity: 'payment',
      entityId: original.id,
      after: { reversal_id: reversal.id, reason: data.reason },
    });
    return { reversalId: reversal.id, bookingId: original.booking_id };
  });
}

export interface RefundCalculation {
  bookingId: string;
  currency: string;
  paid: bigint;
  /** Kept by the operator: the cancellation penalty and amendment fees. */
  kept: bigint;
  refunded: bigint;
  /** What is still to refund, in the booking currency. */
  refundable: bigint;
}

async function refundFor(tx: Tx, bookingId: string): Promise<RefundCalculation> {
  const b = await tx
    .selectFrom('booking')
    .selectAll()
    .where('id', '=', bookingId)
    .executeTakeFirst();
  if (!b) throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
  if (!['cancelled', 'paid_unavailable'].includes(b.status)) {
    throw new DomainError('INVALID_STATE', {
      message: 'Refunds follow a cancellation or a paid-but-unavailable booking',
    });
  }
  const { rows } = await sql<{ refunded: string }>`
    select coalesce(-sum(booking_amount), 0)::text as refunded from vs.payment where booking_id = ${bookingId} and kind = 'refund'`.execute(
    tx,
  );
  const kept = b.status === 'cancelled' ? (b.penalty_amount ?? 0n) + b.fees : 0n;
  const refundable = b.amount_paid - kept;
  return {
    bookingId,
    currency: b.currency,
    paid: b.amount_paid + BigInt(rows[0]!.refunded),
    kept,
    refunded: BigInt(rows[0]!.refunded),
    refundable: refundable > 0n ? refundable : 0n,
  };
}

export const calculateRefundInput = z.object({ bookingId: z.uuid() });

/** From the policy snapshot: received − (penalty + fees) for a cancellation; everything when paid but unavailable. */
export async function calculateRefund(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof calculateRefundInput>,
) {
  const data = parseInput(calculateRefundInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) => refundFor(tx, data.bookingId));
}

export const recordRefundInput = z.object({
  bookingId: z.uuid(),
  method: z.enum([
    'bank_transfer',
    'cash',
    'card_office',
    'agent_remittance',
    'channel',
    'gateway',
  ]),
  amount: positiveMinor,
  currency: currencySchema,
  fxRate: fxRateSchema.optional(),
  reference: z.string().trim().min(1).max(200),
  refundedOn: dateSchema,
  requestKey: requestKeySchema,
});

/** A refund is a negative payment, never more than is still refundable. */
export async function recordRefund(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof recordRefundInput>,
) {
  const data = parseInput(recordRefundInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const booking = await tx
      .selectFrom('booking')
      .select(['id', 'channel_id', 'currency'])
      .where('id', '=', data.bookingId)
      .forUpdate()
      .executeTakeFirst();
    if (!booking) throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
    return withRequestKey(
      tx,
      ctx,
      { scopeId: booking.channel_id, key: data.requestKey, action: 'refund.record', input: data },
      async () => {
        const due = await refundFor(tx, booking.id);
        const inBooking = bookingAmount(data.amount, data.currency, booking.currency, data.fxRate);
        if (inBooking > due.refundable) {
          throw new DomainError('VALIDATION_FAILED', {
            message: 'The refund is more than is refundable',
            details: { refundable: due.refundable.toString(), currency: due.currency },
          });
        }
        const payment = await insertPayment(tx, ctx, {
          bookingId: booking.id,
          kind: 'refund',
          method: data.method,
          amount: -data.amount,
          currency: data.currency,
          fxRate: data.currency === booking.currency ? null : data.fxRate!,
          bookingAmount: -inBooking,
          reference: data.reference,
          receivedOn: data.refundedOn,
        });
        await bookingEvent(tx, ctx, booking.id, 'payment.recorded', {
          payment_id: payment.id,
          kind: 'refund',
          amount: payment.amount.toString(),
          currency: payment.currency,
        });
        await audit(tx, ctx.operatorId, ctx.actor, {
          action: 'refund.recorded',
          entity: 'payment',
          entityId: payment.id,
          after: {
            booking_id: booking.id,
            amount: payment.amount,
            currency: payment.currency,
            booking_amount: -inBooking,
          },
        });
        return { paymentId: payment.id, refundable: due.refundable - inBooking };
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Action list (spec § Back office home) — the payment and booking items
// ---------------------------------------------------------------------------
export interface ActionList {
  today: string;
  holdsExpiringToday: {
    holdId: string;
    kind: string;
    bookingRef: string | null;
    expiresAt: Date;
  }[];
  requests: { bookingId: string; ref: string; expiresAt: Date; hoursLeft: number }[];
  depositsDue: {
    bookingId: string;
    ref: string;
    due: bigint;
    currency: string;
    overdue: boolean;
  }[];
  balancesDue: {
    bookingId: string;
    ref: string;
    due: bigint;
    currency: string;
    dueDate: string;
    overdue: boolean;
  }[];
  paidUnavailable: { bookingId: string; ref: string; paid: bigint; currency: string }[];
  exceptions: { id: string; kind: string; severity: string; summary: string }[];
  /** Confirmed bookings near the manifest cut-off with guests or passports missing. */
  missingGuests: { bookingId: string; ref: string; embarkDate: string; missing: number }[];
  /** Departures in the next 7 days with booked cabins that have no physical cabin yet. */
  unassignedDepartures: {
    legId: string;
    departDate: string;
    from: string;
    to: string;
    unassigned: number;
  }[];
}

/** What needs doing today, by urgency. Cairo dates from the database clock. */
export async function getActionList(db: VsDatabase, ctx: EngineContext): Promise<ActionList> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const today = (
      await sql<{ d: string }>`select (now() at time zone 'Africa/Cairo')::date::text as d`.execute(
        tx,
      )
    ).rows[0]!.d;
    const holds = await sql<ActionList['holdsExpiringToday'][number]>`
      select h.id as "holdId", h.kind, b.ref as "bookingRef", h.expires_at as "expiresAt"
      from vs.hold h left join vs.booking b on b.id = h.booking_id
      where h.status = 'active' and h.kind in ('option', 'payment', 'offer')
        and (h.expires_at at time zone 'Africa/Cairo')::date <= ${today}::date
      order by h.expires_at`.execute(tx);
    const requests = await sql<ActionList['requests'][number]>`
      select id as "bookingId", ref, request_expires_at as "expiresAt",
             greatest(0, extract(epoch from request_expires_at - now()) / 3600)::float8 as "hoursLeft"
      from vs.booking where status = 'requested' order by request_expires_at`.execute(tx);
    const deposits = await sql<ActionList['depositsDue'][number]>`
      select id as "bookingId", ref, (deposit_amount - amount_paid) as due, currency,
             (status = 'confirmed') as overdue
      from vs.booking
      where status in ('held', 'confirmed') and amount_paid < deposit_amount
        and contract_id in (select id from vs.channel_contract where payment_mode = 'vessel_prepaid')
      order by created_at`.execute(tx);
    const balances = await sql<ActionList['balancesDue'][number]>`
      select id as "bookingId", ref, (total + fees - amount_paid) as due, currency,
             balance_due_date::text as "dueDate", balance_due_date < ${today}::date as overdue
      from vs.booking
      where status = 'confirmed' and amount_paid < total + fees
        and balance_due_date <= ${today}::date + 3
        and contract_id in (select id from vs.channel_contract where payment_mode = 'vessel_prepaid')
      order by balance_due_date`.execute(tx);
    const unavailable = await sql<ActionList['paidUnavailable'][number]>`
      select id as "bookingId", ref, amount_paid as paid, currency from vs.booking where status = 'paid_unavailable'`.execute(
      tx,
    );
    const exceptions = await sql<ActionList['exceptions'][number]>`
      select id, kind, severity, summary from vs.exception where status in ('open', 'acknowledged')
      order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, created_at`.execute(
      tx,
    );
    const missing = await sql<ActionList['missingGuests'][number]>`
      select b.id as "bookingId", b.ref, s.embark_date::text as "embarkDate",
             (sum(bc.adults + coalesce(array_length(bc.child_ages, 1), 0))
               - coalesce((select count(*) from vs.guest g where g.booking_id = b.id and g.passport_ciphertext is not null), 0))::int as missing
      from vs.booking b
      join vs.sailing s on s.id = b.sailing_id
      join vs.booking_cabin bc on bc.booking_id = b.id and bc.status = 'active'
      cross join vs.operator_setting st
      where b.status = 'confirmed'
        and s.embark_date between ${today}::date and ${today}::date + st.assignment_cutoff_days + 7
      group by b.id, b.ref, s.embark_date
      having sum(bc.adults + coalesce(array_length(bc.child_ages, 1), 0))
             > coalesce((select count(*) from vs.guest g where g.booking_id = b.id and g.passport_ciphertext is not null), 0)
      order by s.embark_date`.execute(tx);
    const unassigned = await sql<ActionList['unassignedDepartures'][number]>`
      select l.id as "legId", l.depart_date::text as "departDate", fp.code as from, tp.code as to,
             count(distinct bl.booking_cabin_id)::int as unassigned
      from vs.booking_line bl
      join vs.booking b on b.id = bl.booking_id and b.status = 'confirmed'
      join vs.leg l on l.id = bl.leg_id
      join vs.port fp on fp.id = l.from_port_id
      join vs.port tp on tp.id = l.to_port_id
      where bl.status = 'confirmed' and bl.assigned_cabin_id is null
        and l.depart_date between ${today}::date and ${today}::date + 7
      group by l.id, fp.code, tp.code
      order by l.depart_date`.execute(tx);
    return {
      today,
      missingGuests: missing.rows,
      unassignedDepartures: unassigned.rows,
      holdsExpiringToday: holds.rows,
      requests: requests.rows,
      depositsDue: deposits.rows,
      balancesDue: balances.rows,
      paidUnavailable: unavailable.rows,
      exceptions: exceptions.rows,
    };
  });
}

// ---------------------------------------------------------------------------
// Overdue balances (worker, daily)
// ---------------------------------------------------------------------------

/**
 * Overdue balances of prepaid bookings: a late_payment exception and a `payment.overdue` event the
 * first time (the notice to the channel). Where the booking's payment policy enables it, the
 * booking is cancelled `auto_cancel_after_days` after the due date (off by default).
 */
export async function processOverdueBalances(db: VsDatabase, ctx: EngineContext) {
  const flagged = await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{ id: string; ref: string; auto_cancel: boolean }>`
      select b.id, b.ref,
             coalesce((q.policies->'payment'->>'auto_cancel_overdue')::boolean, false)
               and b.balance_due_date + coalesce((q.policies->'payment'->>'auto_cancel_after_days')::int, 0)
                   <= (now() at time zone 'Africa/Cairo')::date as auto_cancel
      from vs.booking b join vs.quote q on q.id = b.quote_id
      join vs.channel_contract c on c.id = b.contract_id
      where b.status = 'confirmed' and c.payment_mode = 'vessel_prepaid'
        and b.amount_paid < b.total + b.fees
        and b.balance_due_date < (now() at time zone 'Africa/Cairo')::date`.execute(tx);
    let notices = 0;
    for (const row of rows) {
      const opened = await openException(tx, ctx, {
        kind: 'late_payment',
        severity: 'warning',
        summary: `Booking ${row.ref}: balance overdue`,
        refs: [{ entity: 'booking', id: row.id }],
        dedupeKey: `late_payment:${row.id}`,
      });
      if (opened) {
        notices += 1;
        await bookingEvent(tx, ctx, row.id, 'payment.overdue', {});
      }
    }
    return { rows, notices };
  });
  let cancelled = 0;
  for (const row of flagged.rows.filter((r) => r.auto_cancel)) {
    await cancelBooking(db, ctx, {
      bookingId: row.id,
      reason: 'Balance overdue (automatic cancellation per payment policy)',
    });
    cancelled += 1;
  }
  return { overdue: flagged.rows.length, notices: flagged.notices, cancelled };
}
