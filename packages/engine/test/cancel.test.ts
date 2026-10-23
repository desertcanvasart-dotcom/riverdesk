import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError } from '@vs/contracts';
import { mulDivHalfUp } from '@vs/shared';
import {
  cancelBooking,
  completeBookings,
  confirmHold,
  createHold,
  todayInCairo,
} from '../src/index';
import { bookingWorld, counters, lead, legsOf, type BookingWorld } from './helpers/booking-world';

describe('cancellation and completion', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  async function book(channelId: string, embarkOffset: number) {
    const sailing = await w.sailing('LXR-4', embarkOffset);
    const hold = await createHold(w.db, w.ctx, {
      channelId,
      quoteId: await w.quote(channelId, sailing, [{ cat: 'STD' }]),
      kind: 'option',
    });
    return { sailing, ...(await confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead })) };
  }

  // Standard policy: ≥ 60 days 0%, 30–59 25%, 15–29 50%, 0–14 100%. M is 0–6 days away.
  it.each([
    [63, 0],
    [35, 2500],
    [21, 5000],
    [7, 10000],
  ])(
    'cancelling at M+%i days applies %i bps of the total, from the snapshot, on the Cairo date',
    async (offset, bps) => {
      const booking = await book(w.channels.nilecrz, offset);
      const [leg] = await legsOf(booking.sailing);
      const total = (
        await owner().query<{ total: string }>(`select total from vs.booking where id = $1`, [
          booking.bookingId,
        ])
      ).rows[0]!.total;
      const result = await cancelBooking(w.db, w.ctx, {
        bookingId: booking.bookingId,
        reason: 'Guest cancelled',
      });
      expect(result.penaltyBps).toBe(bps);
      expect(result.penalty).toBe(mulDivHalfUp(BigInt(total), BigInt(bps), 10_000n));
      expect(
        (await counters(leg!, w.demo.categories.STD)).find((c) => c.kind === 'pool'),
      ).toMatchObject({ booked: 0 });
      const event = await owner().query(
        `select payload from vs.event where resource_id = $1 and type = 'booking.cancelled'`,
        [booking.bookingId],
      );
      expect(event.rows[0].payload).toMatchObject({ penalty_bps: bps, status: 'cancelled' });
      const again = await cancelBooking(w.db, w.ctx, {
        bookingId: booking.bookingId,
        reason: 'again',
      }).catch((e: unknown) => e);
      expect(isDomainError(again, 'INVALID_STATE')).toBe(true);
    },
  );

  it('cancels an unpaid prepaid booking without penalty and releases its payment hold', async () => {
    const booking = await book(w.channels.backOffice, 14);
    expect(booking.status).toBe('held');
    const [leg] = await legsOf(booking.sailing);
    const result = await cancelBooking(w.db, w.ctx, {
      bookingId: booking.bookingId,
      reason: 'No payment',
    });
    expect(result.penalty).toBe(0n);
    expect(
      (await counters(leg!, w.demo.categories.STD)).find((c) => c.kind === 'pool'),
    ).toMatchObject({ held: 0 });
  });

  it('completes bookings the day after the last leg arrives (Cairo date)', async () => {
    const booking = await book(w.channels.nilecrz, 49);
    expect((await completeBookings(w.db, w.ctx)).completed).toBe(0);
    // Test-only time travel: the sailing ended yesterday.
    const today = await todayInCairo(w.db);
    await owner().query(
      `update vs.sailing set embark_date = $2::date - 5, disembark_date = $2::date - 1 where id = $1`,
      [booking.sailing, today],
    );
    expect((await completeBookings(w.db, w.ctx)).completed).toBe(1);
    const { rows } = await owner().query(`select status from vs.booking where id = $1`, [
      booking.bookingId,
    ]);
    expect(rows[0].status).toBe('completed');
    // Put the dates back so later checks on this sailing stay meaningful.
    await owner().query(
      `update vs.sailing s set embark_date = l.depart_date, disembark_date = l.arrive_date
       from vs.sailing_leg sl join vs.leg l on l.id = sl.leg_id where sl.sailing_id = s.id and s.id = $1`,
      [booking.sailing],
    );
  });
});
