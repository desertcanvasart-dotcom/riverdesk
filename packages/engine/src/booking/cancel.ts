import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { daysBetween, mulDivHalfUp, type BusinessDate } from '@vs/shared';
import { audit } from '../audit';
import { cairoToday, parseInput, type EngineContext, type Tx } from '../internal';
import {
  assertBeforeCutoff,
  auditBooking,
  bookingEvent,
  guestSchema,
  refreshPaymentStatus,
  replaceGuests,
  requestKeySchema,
  withRequestKey,
} from './common';
import { settleFoliosBeforeCancel } from '../backoffice/folios';
import { releaseHoldLines } from './holds';
import { releaseUnits } from './units';

export interface PolicySnapshot {
  cancellation: { rules: { from_days: number; penalty_bps: number }[] };
}

/** Penalty basis points for cancelling `days` days before embarkation (largest from_days ≤ days). */
export function penaltyBps(policies: PolicySnapshot, days: number): number {
  const rules = [...policies.cancellation.rules].sort((a, b) => b.from_days - a.from_days);
  return (
    rules.find((rule) => rule.from_days <= Math.max(days, 0)) ??
    rules.at(-1) ?? { penalty_bps: 0 }
  ).penalty_bps;
}

export async function latestPolicies(tx: Tx, bookingId: string): Promise<PolicySnapshot> {
  const revision = await tx
    .selectFrom('booking_revision')
    .select('snapshot')
    .where('booking_id', '=', bookingId)
    .orderBy('rev', 'desc')
    .executeTakeFirstOrThrow();
  return (revision.snapshot as unknown as { policies: PolicySnapshot }).policies;
}

/** Days from today (Cairo, database clock) to the embark date. */
export async function daysBeforeEmbark(tx: Tx, sailingId: string): Promise<number> {
  const sailing = await tx
    .selectFrom('sailing')
    .select('embark_date')
    .where('id', '=', sailingId)
    .executeTakeFirstOrThrow();
  return daysBetween(await cairoToday(tx), sailing.embark_date as BusinessDate);
}

export const cancelBookingInput = z.object({
  bookingId: z.uuid(),
  reason: z.string().min(1).max(500),
  requestKey: requestKeySchema,
});

/**
 * Guard: booking.status = 'confirmed' → cancelled, with the penalty from the booking's policy
 * snapshot on today's Cairo date; booked −= n on every line (released allotment units return to
 * the pool). A prepaid booking still waiting for payment (held) is cancelled without penalty.
 */
export async function cancelBooking(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof cancelBookingInput>,
) {
  const data = parseInput(cancelBookingInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const peek = await tx
      .selectFrom('booking')
      .select(['channel_id', 'status'])
      .where('id', '=', data.bookingId)
      .executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
    return withRequestKey(
      tx,
      ctx,
      { scopeId: peek.channel_id, key: data.requestKey, action: 'booking.cancel', input: data },
      async () => {
        if (peek.status === 'held') return cancelHeld(tx, ctx, data.bookingId, data.reason);
        // Extras charged on board are never lost with the booking (folio-plan.md § 3).
        await settleFoliosBeforeCancel(tx, ctx, data.bookingId);
        const booking = await tx
          .updateTable('booking')
          .set({ status: 'cancelled', cancelled_at: sql<Date>`now()`, cancel_reason: data.reason })
          .where('id', '=', data.bookingId)
          .where('status', '=', 'confirmed')
          .returningAll()
          .executeTakeFirst();
        if (!booking)
          throw new DomainError('INVALID_STATE', {
            message: `Only confirmed bookings can be cancelled (this one is ${peek.status})`,
          });

        const days = await daysBeforeEmbark(tx, booking.sailing_id);
        const bps = penaltyBps(await latestPolicies(tx, booking.id), days);
        const penalty = mulDivHalfUp(booking.total, BigInt(bps), 10_000n);
        await tx
          .updateTable('booking')
          .set({ penalty_amount: penalty })
          .where('id', '=', booking.id)
          .execute();
        await refreshPaymentStatus(tx, booking.id);

        const lines = await tx
          .updateTable('booking_line')
          .set({ status: 'released', released_at: sql<Date>`now()` })
          .where('booking_id', '=', booking.id)
          .where('status', '=', 'confirmed')
          .returning(['bucket_id'])
          .execute();
        await releaseUnits(
          tx,
          ctx,
          lines.map((l) => ({ bucketId: l.bucket_id, n: 1, field: 'booked' as const })),
          'booking.cancelled',
          { entity: 'booking', id: booking.id },
        );

        await bookingEvent(tx, ctx, booking.id, 'booking.cancelled', {
          penalty: penalty.toString(),
          penalty_bps: bps,
          days_before: days,
          currency: booking.currency,
        });
        await auditBooking(
          tx,
          ctx,
          'booking.cancelled',
          booking.id,
          { status: 'confirmed' },
          { status: 'cancelled', penalty, days_before: days, reason: data.reason },
        );
        return {
          bookingId: booking.id,
          status: 'cancelled',
          penalty,
          penaltyBps: bps,
          currency: booking.currency,
        };
      },
    );
  });
}

/** A held (unpaid prepaid) booking: release its payment hold first (hold before booking). */
async function cancelHeld(tx: Tx, ctx: EngineContext, bookingId: string, reason: string) {
  const hold = await tx
    .updateTable('hold')
    .set({ status: 'released', ended_at: sql<Date>`now()` })
    .where('booking_id', '=', bookingId)
    .where('kind', '=', 'payment')
    .where('status', '=', 'active')
    .returning('id')
    .executeTakeFirst();
  if (hold) await releaseHoldLines(tx, ctx, [hold.id], 'booking.cancelled');
  const booking = await tx
    .updateTable('booking')
    .set({
      status: 'cancelled',
      cancelled_at: sql<Date>`now()`,
      cancel_reason: reason,
      penalty_amount: 0n,
    })
    .where('id', '=', bookingId)
    .where('status', '=', 'held')
    .returningAll()
    .executeTakeFirst();
  if (!booking)
    throw new DomainError('INVALID_STATE', {
      message: 'The booking is no longer waiting for payment',
    });
  await refreshPaymentStatus(tx, booking.id);
  await bookingEvent(tx, ctx, booking.id, 'booking.cancelled', {
    penalty: '0',
    currency: booking.currency,
  });
  await auditBooking(
    tx,
    ctx,
    'booking.cancelled',
    booking.id,
    { status: 'held' },
    { status: 'cancelled', reason },
  );
  return {
    bookingId: booking.id,
    status: 'cancelled',
    penalty: 0n,
    penaltyBps: 0,
    currency: booking.currency,
  };
}

/** Worker job (daily): confirmed bookings whose last leg has arrived become completed. */
export async function completeBookings(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{ id: string }>`
      update vs.booking b set status = 'completed', completed_at = now()
      from vs.sailing s
      where s.id = b.sailing_id and b.status = 'confirmed'
        and s.disembark_date < (now() at time zone 'Africa/Cairo')::date
      returning b.id`.execute(tx);
    if (rows.length > 0) {
      await audit(tx, ctx.operatorId, ctx.actor, {
        action: 'bookings.completed',
        entity: 'booking',
        entityId: null,
        after: { count: rows.length },
      });
    }
    return { completed: rows.length };
  });
}

export const upsertGuestsInput = z.object({
  bookingId: z.uuid(),
  guests: z.array(guestSchema).min(1),
  requestKey: requestKeySchema,
});

/** Replaces guest details until the manifest cut-off (default 7 days before embarkation). */
export async function upsertGuests(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof upsertGuestsInput>,
) {
  const data = parseInput(upsertGuestsInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const booking = await tx
      .selectFrom('booking')
      .select(['id', 'status', 'sailing_id', 'channel_id'])
      .where('id', '=', data.bookingId)
      .forUpdate()
      .executeTakeFirst();
    if (!booking) throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
    return withRequestKey(
      tx,
      ctx,
      { scopeId: booking.channel_id, key: data.requestKey, action: 'guests.upsert', input: data },
      async () => {
        if (!['requested', 'held', 'offered', 'confirmed'].includes(booking.status)) {
          throw new DomainError('INVALID_STATE', {
            message: `Guests cannot change on a ${booking.status} booking`,
          });
        }
        await assertBeforeCutoff(tx, booking.sailing_id);
        await replaceGuests(tx, ctx, booking.id, data.guests);
        return { bookingId: booking.id, guests: data.guests.length };
      },
    );
  });
}
