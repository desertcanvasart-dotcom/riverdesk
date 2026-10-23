import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError } from '@vs/contracts';
import { mulDivHalfUp } from '@vs/shared';
import {
  amendmentFee,
  applyAmendment,
  confirmHold,
  createHold,
  quoteAmendment,
  releaseHold,
} from '../src/index';
import { bookingWorld, counters, lead, legsOf, type BookingWorld } from './helpers/booking-world';

describe('amendments', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  async function book(
    pattern: 'LXR-4' | 'LXR-7' | 'ASW-3',
    offset: number,
    cabins: { cat: 'STD' | 'SUP' | 'JS' | 'RS' }[],
  ) {
    const sailing = await w.sailing(pattern, offset);
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, sailing, cabins),
      kind: 'option',
    });
    return { sailing, ...(await confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead })) };
  }
  const lines = async (bookingId: string) =>
    (
      await owner().query<{ leg_id: string; bucket_id: string; status: string }>(
        `select leg_id, bucket_id, status from vs.booking_line where booking_id = $1 order by created_at, id`,
        [bookingId],
      )
    ).rows;
  const pool = async (legId: string, cat: string) =>
    (await counters(legId, cat)).find((c) => c.kind === 'pool')!;

  it('7 nights → 4 nights from the same day releases only leg B; leg A keeps its line and bucket', async () => {
    const booking = await book('LXR-7', 14, [{ cat: 'STD' }]);
    const [legA, legB] = (await legsOf(booking.sailing)) as [string, string];
    const std = w.demo.categories.STD;
    const before = await lines(booking.bookingId);
    const shorter = await w.sailing('LXR-4', 14);
    const quoted = await quoteAmendment(w.db, w.ctx, {
      bookingId: booking.bookingId,
      sailingId: shorter,
    });
    expect(quoted.changes).toEqual(['date']);
    const result = await applyAmendment(w.db, w.ctx, {
      bookingId: booking.bookingId,
      revision: 1,
      amendmentQuoteId: quoted.quote.id,
    });
    expect(result.revision).toBe(2);
    const after = await lines(booking.bookingId);
    expect(after.filter((l) => l.status === 'confirmed')).toEqual([
      before.find((l) => l.leg_id === legA),
    ]);
    expect(after.find((l) => l.leg_id === legB)!.status).toBe('released');
    expect(await pool(legA, std)).toMatchObject({ booked: 1 });
    expect(await pool(legB, std)).toMatchObject({ booked: 0 });
    const revisions = await owner().query(
      `select rev, total from vs.booking_revision where booking_id = $1 order by rev`,
      [booking.bookingId],
    );
    expect(revisions.rows.map((r) => r.rev)).toEqual([1, 2]);
    const event = await owner().query(
      `select payload from vs.event where resource_id = $1 and type = 'booking.amended'`,
      [booking.bookingId],
    );
    expect(event.rows[0].payload).toMatchObject({ revision: 2, changes: ['date'] });
  });

  it('a stale revision is refused with REVISION_CHANGED', async () => {
    const booking = await book('LXR-4', 21, [{ cat: 'STD' }]);
    const first = await quoteAmendment(w.db, w.ctx, {
      bookingId: booking.bookingId,
      cabins: [{ categoryId: w.demo.categories.SUP, adults: 2 }],
    });
    await applyAmendment(w.db, w.ctx, {
      bookingId: booking.bookingId,
      revision: 1,
      amendmentQuoteId: first.quote.id,
    });
    const second = await quoteAmendment(w.db, w.ctx, {
      bookingId: booking.bookingId,
      cabins: [{ categoryId: w.demo.categories.JS, adults: 2 }],
    });
    const stale = await applyAmendment(w.db, w.ctx, {
      bookingId: booking.bookingId,
      revision: 1,
      amendmentQuoteId: second.quote.id,
    }).catch((e: unknown) => e);
    expect(isDomainError(stale, 'REVISION_CHANGED')).toBe(true);
  });

  it('test 7: an amendment to a sold-out date leaves the booking, its revision and every counter unchanged', async () => {
    const booking = await book('LXR-4', 28, [{ cat: 'RS' }]);
    const target = await w.sailing('LXR-4', 35);
    const [targetLeg] = await legsOf(target);
    const [ownLeg] = await legsOf(booking.sailing);
    const quoted = await quoteAmendment(w.db, w.ctx, {
      bookingId: booking.bookingId,
      sailingId: target,
    });
    const soldOut = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, target, [{ cat: 'RS' }, { cat: 'RS' }]),
      kind: 'option',
    });

    const snapshot = async () => ({
      booking: (
        await owner().query(
          `select status, revision, sailing_id, total, version from vs.booking where id = $1`,
          [booking.bookingId],
        )
      ).rows[0],
      revisions: (
        await owner().query(`select rev from vs.booking_revision where booking_id = $1`, [
          booking.bookingId,
        ])
      ).rowCount,
      lines: await lines(booking.bookingId),
      target: await counters(targetLeg!, w.demo.categories.RS),
      own: await counters(ownLeg!, w.demo.categories.RS),
    });
    const before = await snapshot();
    const error = await applyAmendment(w.db, w.ctx, {
      bookingId: booking.bookingId,
      revision: 1,
      amendmentQuoteId: quoted.quote.id,
    }).catch((e: unknown) => e);
    expect(isDomainError(error, 'NOT_AVAILABLE')).toBe(true);
    expect(await snapshot()).toEqual(before);
    await releaseHold(w.db, w.ctx, { holdId: soldOut.holdId });
  });

  it('change category and add a cabin: acquires the new cabins, releases the old one', async () => {
    const booking = await book('ASW-3', 32, [{ cat: 'STD' }]);
    const [leg] = (await legsOf(booking.sailing)) as [string];
    const { STD, SUP, JS } = w.demo.categories;
    const quoted = await quoteAmendment(w.db, w.ctx, {
      bookingId: booking.bookingId,
      cabins: [
        { categoryId: SUP, adults: 2 },
        { categoryId: JS, adults: 2 },
      ],
    });
    expect(quoted.changes.sort()).toEqual(['cabins', 'category']);
    await applyAmendment(w.db, w.ctx, {
      bookingId: booking.bookingId,
      revision: 1,
      amendmentQuoteId: quoted.quote.id,
    });
    expect(
      [await pool(leg, STD), await pool(leg, SUP), await pool(leg, JS)].map((p) => p.booked),
    ).toEqual([0, 1, 1]);
    const cabins = await owner().query(
      `select seq, category_id from vs.booking_cabin where booking_id = $1 and status = 'active' order by seq`,
      [booking.bookingId],
    );
    expect(cabins.rows).toEqual([
      { seq: 0, category_id: SUP },
      { seq: 1, category_id: JS },
    ]);
  });

  it('fee: a reduction inside a penalty window is charged as a cancellation', () => {
    const policies = {
      cancellation: {
        rules: [
          { from_days: 60, penalty_bps: 0 },
          { from_days: 30, penalty_bps: 2500 },
          { from_days: 15, penalty_bps: 5000 },
          { from_days: 0, penalty_bps: 10000 },
        ],
      },
    };
    expect(
      amendmentFee({
        policies,
        changes: ['date'],
        days: 20,
        oldTotal: 200000n,
        newTotal: 120000n,
        currency: 'USD',
      }),
    ).toBe(mulDivHalfUp(80000n, 5000n, 10000n));
    expect(
      amendmentFee({
        policies,
        changes: ['date'],
        days: 70,
        oldTotal: 200000n,
        newTotal: 120000n,
        currency: 'USD',
      }),
    ).toBe(0n);
    expect(
      amendmentFee({
        policies,
        changes: ['category'],
        days: 20,
        oldTotal: 100000n,
        newTotal: 150000n,
        currency: 'USD',
      }),
    ).toBe(0n);
    const withRule = {
      ...policies,
      amendment_fees: [
        {
          change_kind: 'date',
          from_days: 0,
          fee_kind: 'flat',
          amount: '5000',
          currency: 'USD',
          percent_bps: null,
        },
      ],
    };
    expect(
      amendmentFee({
        policies: withRule,
        changes: ['date'],
        days: 70,
        oldTotal: 100000n,
        newTotal: 100000n,
        currency: 'USD',
      }),
    ).toBe(5000n);
    expect(
      amendmentFee({
        policies: withRule,
        changes: ['occupancy'],
        days: 70,
        oldTotal: 100000n,
        newTotal: 100000n,
        currency: 'USD',
      }),
    ).toBe(0n);
  });
});
