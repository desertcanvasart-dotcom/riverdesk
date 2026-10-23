import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import { parseInput, type EngineContext, type Tx } from '../internal';
import { loadQuote, useQuote } from '../pricing/quote';
import {
  auditBooking,
  bookingEvent,
  guestSchema,
  insertBooking,
  insertBookingLines,
  insertCabins,
  needsFor,
  replaceGuests,
  requestKeySchema,
  withRequestKey,
  writeRevision,
  type QuotedCabin,
} from './common';
import {
  assertContractSells,
  assertSailingOpen,
  bookHoldLines,
  loadContract,
  openHold,
  paymentHoldHours,
} from './holds';
import { takeUnits } from './units';

export const createRequestInput = z.object({
  channelId: z.uuid(),
  quoteId: z.uuid(),
  channelRef: z.string().min(1).max(100).optional(),
  guests: z.array(guestSchema).optional(),
  requestKey: requestKeySchema,
});

/**
 * An on-request booking: no inventory moves until staff accept (spec § Transitions). The request
 * times out after the contract's SLA plus the operator's grace period.
 */
export async function createRequest(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createRequestInput>,
) {
  const data = parseInput(createRequestInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    withRequestKey(
      tx,
      ctx,
      { scopeId: data.channelId, key: data.requestKey, action: 'request.create', input: data },
      async () => {
        if (data.channelRef) {
          const existing = await tx
            .selectFrom('booking')
            .select(['id', 'ref', 'status'])
            .where('channel_id', '=', data.channelId)
            .where('channel_ref', '=', data.channelRef)
            .executeTakeFirst();
          if (existing)
            return {
              bookingId: existing.id,
              ref: existing.ref,
              status: existing.status,
              requestExpiresAt: null,
              existing: true,
            };
        }
        const quote = await useQuote(tx, data.quoteId, data.channelId);
        const contract = await loadContract(tx, quote.contractId);
        assertContractSells(contract);
        await assertSailingOpen(tx, quote.sailingId);
        const { booking } = await insertBooking(tx, ctx, {
          quote,
          contractId: contract.id,
          status: 'requested',
          channelRef: data.channelRef,
          requestExpiresAt: sql<Date>`now() + make_interval(hours => ${contract.request_sla_hours}
          + (select request_grace_hours from vs.operator_setting))`,
        });
        if (data.guests?.length) await replaceGuests(tx, ctx, booking.id, data.guests);
        await auditBooking(tx, ctx, 'request.created', booking.id, null, {
          ref: booking.ref,
          quote_id: quote.id,
        });
        return {
          bookingId: booking.id,
          ref: booking.ref,
          status: booking.status,
          requestExpiresAt: booking.request_expires_at,
        };
      },
    ),
  );
}

async function lockRequest(tx: Tx, bookingId: string, toStatus: string) {
  const booking = await tx
    .updateTable('booking')
    .set({ status: toStatus })
    .where('id', '=', bookingId)
    .where('status', '=', 'requested')
    .where(sql<boolean>`request_expires_at > now()`)
    .returningAll()
    .executeTakeFirst();
  if (booking) return booking;
  const current = await tx
    .selectFrom('booking')
    .select(['status'])
    .where('id', '=', bookingId)
    .executeTakeFirst();
  if (!current) throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
  throw new DomainError('INVALID_STATE', {
    message:
      current.status === 'requested'
        ? 'The request has timed out'
        : `The booking is ${current.status}`,
  });
}

export const acceptRequestInput = z.object({ bookingId: z.uuid(), requestKey: requestKeySchema });

/**
 * Credit and channel-collected contracts: requested → confirmed, booked += n where free ≥ n.
 * Prepaid: requested → held with a payment hold. If any leg is full, nothing changes.
 */
export async function acceptRequest(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof acceptRequestInput>,
) {
  const data = parseInput(acceptRequestInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const peek = await tx
      .selectFrom('booking')
      .select(['channel_id', 'contract_id'])
      .where('id', '=', data.bookingId)
      .executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
    return withRequestKey(
      tx,
      ctx,
      { scopeId: peek.channel_id, key: data.requestKey, action: 'request.accept', input: data },
      async () => {
        const contract = await loadContract(tx, peek.contract_id);
        const prepaid = contract.payment_mode === 'vessel_prepaid';
        const booking = await lockRequest(tx, data.bookingId, prepaid ? 'held' : 'confirmed');
        const quote = await loadQuote(tx, booking.quote_id);
        const legs = await assertSailingOpen(tx, booking.sailing_id);

        if (prepaid) {
          const { hold } = await openHold(tx, ctx, {
            quote,
            contract,
            kind: 'payment',
            bookingId: booking.id,
            expiresAt: sql<Date>`now() + make_interval(hours => ${paymentHoldHours(quote)})`,
          });
          await bookingEvent(tx, ctx, booking.id, 'request.decided', {
            decision: 'accepted',
            payment_due_by: hold.expires_at.toISOString(),
          });
          await auditBooking(
            tx,
            ctx,
            'request.accepted',
            booking.id,
            { status: 'requested' },
            { status: 'held', hold_id: hold.id },
          );
          return {
            bookingId: booking.id,
            ref: booking.ref,
            status: 'held',
            paymentDueBy: hold.expires_at,
          };
        }

        const cabins = await tx
          .selectFrom('booking_cabin')
          .select(['id', 'category_id'])
          .where('booking_id', '=', booking.id)
          .where('status', '=', 'active')
          .execute();
        const taken = await takeUnits(tx, ctx, {
          channelId: booking.channel_id,
          allocation: contract.allocation,
          needs: needsFor(
            cabins.map((c) => ({ categoryId: c.category_id })),
            legs.map((l) => l.id),
          ),
          field: 'booked',
          cause: 'request.accepted',
          ref: { entity: 'booking', id: booking.id },
        });
        const bucket = new Map(taken.map((t) => [`${t.legId}|${t.categoryId}`, t.bucketId]));
        await insertBookingLines(
          tx,
          ctx,
          booking.id,
          cabins,
          legs.map((l) => l.id),
          (legId, categoryId) => bucket.get(`${legId}|${categoryId}`)!,
        );
        await writeRevision(tx, ctx, {
          bookingId: booking.id,
          rev: 1,
          quote,
          reason: 'request accepted',
        });
        await tx
          .updateTable('booking')
          .set({ revision: 1, confirmed_at: sql<Date>`now()` })
          .where('id', '=', booking.id)
          .execute();
        await bookingEvent(tx, ctx, booking.id, 'request.decided', { decision: 'accepted' });
        await bookingEvent(tx, ctx, booking.id, 'booking.confirmed', {
          total: booking.total.toString(),
          currency: booking.currency,
        });
        await auditBooking(
          tx,
          ctx,
          'request.accepted',
          booking.id,
          { status: 'requested' },
          { status: 'confirmed' },
        );
        return { bookingId: booking.id, ref: booking.ref, status: 'confirmed' };
      },
    );
  });
}

export const declineRequestInput = z.object({
  bookingId: z.uuid(),
  reason: z.string().min(1).max(500),
});

export async function declineRequest(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof declineRequestInput>,
) {
  const data = parseInput(declineRequestInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const booking = await lockRequest(tx, data.bookingId, 'declined');
    await bookingEvent(tx, ctx, booking.id, 'request.decided', { decision: 'declined' });
    await auditBooking(
      tx,
      ctx,
      'request.declined',
      booking.id,
      { status: 'requested' },
      { status: 'declined', reason: data.reason },
    );
    return { bookingId: booking.id, status: 'declined' };
  });
}

export const offerAlternativeInput = z.object({
  bookingId: z.uuid(),
  quoteId: z.uuid(),
  requestKey: requestKeySchema,
});

/** requested → offered; the alternative's cabins are held on its own offer hold (default 48 h). */
export async function offerAlternative(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof offerAlternativeInput>,
) {
  const data = parseInput(offerAlternativeInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const peek = await tx
      .selectFrom('booking')
      .select(['channel_id'])
      .where('id', '=', data.bookingId)
      .executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
    return withRequestKey(
      tx,
      ctx,
      { scopeId: peek.channel_id, key: data.requestKey, action: 'request.offer', input: data },
      async () => {
        const quote = await useQuote(tx, data.quoteId, peek.channel_id);
        const contract = await loadContract(tx, quote.contractId);
        const booking = await lockRequest(tx, data.bookingId, 'offered');
        const ttl = sql`make_interval(hours => (select offer_hold_hours from vs.operator_setting))`;
        const { hold } = await openHold(tx, ctx, {
          quote,
          contract,
          kind: 'offer',
          bookingId: booking.id,
          expiresAt: sql<Date>`now() + ${ttl}`,
        });
        const offer = await tx
          .insertInto('offer')
          .values({
            operator_id: ctx.operatorId,
            booking_id: booking.id,
            quote_id: quote.id,
            hold_id: hold.id,
            expires_at: hold.expires_at,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await bookingEvent(tx, ctx, booking.id, 'offer.created', {
          offer_id: offer.id,
          sailing_id: quote.sailingId,
          expires_at: offer.expires_at.toISOString(),
        });
        await auditBooking(
          tx,
          ctx,
          'request.offered',
          booking.id,
          { status: 'requested' },
          { status: 'offered', offer_id: offer.id, quote_id: quote.id },
        );
        return { offerId: offer.id, holdId: hold.id, expiresAt: offer.expires_at };
      },
    );
  });
}

export const acceptOfferInput = z.object({ offerId: z.uuid(), requestKey: requestKeySchema });

/**
 * Guard: offer open and its hold active. The booking moves to the alternative; then confirm
 * (credit, channel-collected) or keep the cabins on a payment hold (prepaid).
 * Lock order: hold, offer, booking, buckets (the expiry job also starts at the hold).
 */
export async function acceptOffer(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof acceptOfferInput>,
) {
  const data = parseInput(acceptOfferInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const peek = await tx
      .selectFrom('offer')
      .selectAll()
      .where('id', '=', data.offerId)
      .executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', { message: 'Offer not found' });
    const channel = await tx
      .selectFrom('booking')
      .select(['channel_id', 'contract_id'])
      .where('id', '=', peek.booking_id)
      .executeTakeFirstOrThrow();
    return withRequestKey(
      tx,
      ctx,
      { scopeId: channel.channel_id, key: data.requestKey, action: 'offer.accept', input: data },
      async () => {
        const quote = await loadQuote(tx, peek.quote_id);
        const contract = await loadContract(tx, quote.contractId);
        const prepaid = contract.payment_mode === 'vessel_prepaid';
        const hold = await tx
          .updateTable('hold')
          .set(
            prepaid
              ? {
                  kind: 'payment',
                  expires_at: sql<Date>`now() + make_interval(hours => ${paymentHoldHours(quote)})`,
                }
              : { status: 'confirmed', ended_at: sql<Date>`now()` },
          )
          .where('id', '=', peek.hold_id)
          .where('status', '=', 'active')
          .where(sql<boolean>`expires_at > now()`)
          .returningAll()
          .executeTakeFirst();
        if (!hold) throw new DomainError('HOLD_EXPIRED', { message: 'The offer has expired' });
        const offer = await tx
          .updateTable('offer')
          .set({ status: 'accepted' })
          .where('id', '=', peek.id)
          .where('status', '=', 'open')
          .returning('id')
          .executeTakeFirst();
        if (!offer)
          throw new DomainError('INVALID_STATE', { message: 'The offer is no longer open' });
        const booking = await tx
          .updateTable('booking')
          .set({
            status: prepaid ? 'held' : 'confirmed',
            sailing_id: quote.sailingId,
            quote_id: quote.id,
            rate_plan_id: quote.ratePlanId,
            contract_id: contract.id,
            currency: quote.currency,
            total: quote.total,
            net_total: quote.netTotal,
            ...(prepaid ? {} : { revision: 1, confirmed_at: sql<Date>`now()` }),
          })
          .where('id', '=', peek.booking_id)
          .where('status', '=', 'offered')
          .returningAll()
          .executeTakeFirst();
        if (!booking)
          throw new DomainError('INVALID_STATE', { message: 'The request is no longer offered' });
        await replaceCabins(tx, ctx, booking.id, quote.cabins as QuotedCabin[]);

        if (prepaid) {
          await bookingEvent(tx, ctx, booking.id, 'request.decided', {
            decision: 'offer_accepted',
            payment_due_by: hold.expires_at.toISOString(),
          });
          await auditBooking(
            tx,
            ctx,
            'offer.accepted',
            booking.id,
            { status: 'offered' },
            { status: 'held', offer_id: offer.id },
          );
          return {
            bookingId: booking.id,
            ref: booking.ref,
            status: 'held',
            paymentDueBy: hold.expires_at,
          };
        }
        await bookHoldLines(tx, ctx, hold.id, booking.id, booking.sailing_id);
        await writeRevision(tx, ctx, {
          bookingId: booking.id,
          rev: 1,
          quote,
          reason: 'offer accepted',
        });
        await bookingEvent(tx, ctx, booking.id, 'request.decided', { decision: 'offer_accepted' });
        await bookingEvent(tx, ctx, booking.id, 'booking.confirmed', {
          total: booking.total.toString(),
          currency: booking.currency,
        });
        await auditBooking(
          tx,
          ctx,
          'offer.accepted',
          booking.id,
          { status: 'offered' },
          { status: 'confirmed', offer_id: offer.id },
        );
        return { bookingId: booking.id, ref: booking.ref, status: 'confirmed' };
      },
    );
  });
}

/**
 * The booking's cabins become the quote's cabins. Guests move to the new cabin with the same
 * index (or the first cabin) so their details survive.
 */
export async function replaceCabins(
  tx: Tx,
  ctx: EngineContext,
  bookingId: string,
  cabins: QuotedCabin[],
) {
  const old = await tx
    .selectFrom('booking_cabin')
    .select(['id', 'seq'])
    .where('booking_id', '=', bookingId)
    .where('status', '=', 'active')
    .execute();
  await tx
    .updateTable('booking_cabin')
    .set({ status: 'cancelled' })
    .where('booking_id', '=', bookingId)
    .where('status', '=', 'active')
    .execute();
  await insertCabins(tx, ctx, bookingId, cabins, await nextSeq(tx, bookingId));
  await renumberCabins(tx, bookingId);
  const fresh = await tx
    .selectFrom('booking_cabin')
    .select(['id', 'seq'])
    .where('booking_id', '=', bookingId)
    .where('status', '=', 'active')
    .execute();
  for (const cabin of old) {
    const target = fresh.find((c) => c.seq === cabin.seq) ?? fresh.find((c) => c.seq === 0)!;
    await tx
      .updateTable('guest')
      .set({ booking_cabin_id: target.id })
      .where('booking_cabin_id', '=', cabin.id)
      .execute();
  }
}

async function nextSeq(tx: Tx, bookingId: string) {
  const { rows } = await sql<{
    n: number;
  }>`select coalesce(max(seq) + 1, 0)::int as n from vs.booking_cabin where booking_id = ${bookingId}`.execute(
    tx,
  );
  return rows[0]!.n;
}

/** Active cabins are numbered 0..n-1 (guests refer to them by index). */
export async function renumberCabins(tx: Tx, bookingId: string) {
  const active = await tx
    .selectFrom('booking_cabin')
    .select(['id', 'seq'])
    .where('booking_id', '=', bookingId)
    .where('status', '=', 'active')
    .orderBy('seq')
    .execute();
  const offset = 10_000;
  for (const [i, cabin] of active.entries())
    await tx
      .updateTable('booking_cabin')
      .set({ seq: offset + i })
      .where('id', '=', cabin.id)
      .execute();
  for (const [i, cabin] of active.entries())
    await tx.updateTable('booking_cabin').set({ seq: i }).where('id', '=', cabin.id).execute();
}

/** Worker job (every 5 minutes): requested and past SLA + grace → expired. */
export async function expireRequests(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const expired = await tx
      .updateTable('booking')
      .set({ status: 'expired' })
      .where('status', '=', 'requested')
      .where(sql<boolean>`request_expires_at <= now()`)
      .returning('id')
      .execute();
    for (const booking of expired)
      await bookingEvent(tx, ctx, booking.id, 'request.decided', { decision: 'timed_out' });
    if (expired.length > 0) {
      await audit(tx, ctx.operatorId, ctx.actor, {
        action: 'requests.expired',
        entity: 'booking',
        entityId: null,
        after: { count: expired.length },
      });
    }
    return { expired: expired.length };
  });
}
