import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner, testConfig } from '@vs/db/testing';
import {
  backfillAnalytics,
  createHold,
  openDatabase,
  staffBook,
  takeAnalyticsSnapshot,
  type VsDatabase,
} from '../src/index';
import { bookingWorld, legsOf, type BookingWorld } from './helpers/booking-world';

describe('analytics snapshot (A1.1)', () => {
  let w: BookingWorld;
  let worker: VsDatabase;
  let sailingId: string;
  let booked: { bookingId: string; ref: string };

  beforeAll(async () => {
    w = await bookingWorld();
    worker = openDatabase('vs_worker', { config: testConfig(), max: 2 });
    sailingId = await w.sailing('LXR-4', 28);
    // A platform booking (confirmed at once) and an open option hold on the same sailing.
    booked = await staffBook(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      sailingId,
      market: 'international',
      cabins: [
        { categoryId: w.demo.categories.STD, adults: 2 },
        { categoryId: w.demo.categories.STD, adults: 1, childAges: [8] },
      ],
      guests: [{ cabin: 0, firstName: 'Nora', lastName: 'Saleh', lead: true }],
      requestKey: 'snapshot-booking-1',
    });
    const quoteId = await w.quote(w.channels.nilecrz, sailingId, [{ cat: 'STD', adults: 2 }]);
    await createHold(w.db, w.ctx, { channelId: w.channels.nilecrz, quoteId, kind: 'option' });
  }, 120_000);

  afterAll(async () => {
    await worker.close();
    await w.close();
  });

  const rows = (table: 'analytics_leg_day' | 'analytics_sailing_day', night: string) =>
    owner()
      .query(`select * from vs.${table} where operator_id = $1 and snapshot_date = $2`, [
        w.ctx.operatorId,
        night,
      ])
      .then((r) => r.rows);

  it('counts the night in Cairo time, whatever the daylight saving', async () => {
    // 21:45 UTC: 23:45 in Cairo in winter, 00:45 the next day in summer. Both are that night.
    const winter = await takeAnalyticsSnapshot(worker, w.ctx, new Date('2026-12-10T21:45:00Z'));
    expect(winter.night).toBe('2026-12-10');
    const summer = await takeAnalyticsSnapshot(worker, w.ctx, new Date('2027-07-10T21:45:00Z'));
    expect(summer.night).toBe('2027-07-10');
  });

  it('records each upcoming departure by category, as the inventory stands', async () => {
    const { night, legRows } = await takeAnalyticsSnapshot(worker, w.ctx);
    expect(legRows).toBeGreaterThan(0);
    const [legId] = await legsOf(sailingId);
    const snapshot = (await rows('analytics_leg_day', night)).find(
      (r) => r.leg_id === legId && r.category_id === w.demo.categories.STD,
    )!;
    const { rows: live } = await owner().query<{ total: number; booked: number; held: number }>(
      `select sum(total)::int as total, sum(booked)::int as booked, sum(held)::int as held
       from vs.inventory_bucket where leg_id = $1 and category_id = $2 and kind in ('pool', 'allotment')`,
      [legId, w.demo.categories.STD],
    );
    expect(snapshot).toMatchObject({
      capacity: live[0]!.total,
      booked: live[0]!.booked,
      held: live[0]!.held,
      reconstructed: false,
    });
    expect(snapshot.booked).toBeGreaterThanOrEqual(2);
    expect(snapshot.held).toBeGreaterThanOrEqual(1);
  });

  it('records what is booked per sailing, channel, market and currency, with the pipeline', async () => {
    const { night } = await takeAnalyticsSnapshot(worker, w.ctx);
    const row = (await rows('analytics_sailing_day', night)).find(
      (r) => r.sailing_id === sailingId && r.channel_id === w.channels.nilecrz,
    )!;
    const { rows: booking } = await owner().query<{
      total: string;
      net_total: string;
      currency: string;
    }>(`select total::text, net_total::text, currency from vs.booking where id = $1`, [
      booked.bookingId,
    ]);
    expect(row).toMatchObject({
      market: 'international',
      currency: booking[0]!.currency,
      bookings: 1,
      cabins: 2,
      guests: 4,
      cabin_nights: 8,
      value_total: booking[0]!.total,
      value_net: booking[0]!.net_total,
      holds_open: 1,
    });
  });

  it('replaces a night when it runs again, never doubling it', async () => {
    const first = await takeAnalyticsSnapshot(worker, w.ctx);
    const second = await takeAnalyticsSnapshot(worker, w.ctx);
    expect(second).toEqual(first);
    expect((await rows('analytics_sailing_day', first.night)).length).toBe(first.sailingRows);
  });

  it('is written by the worker only', async () => {
    await expect(
      w.db.withTenantTx(w.ctx.operatorId, w.ctx.actor, ({ db: tx }) =>
        tx.deleteFrom('analytics_sailing_day').execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('rebuilds past nights once, from booking dates, marked as reconstructed', async () => {
    // A fresh company whose booking was confirmed ten days ago.
    const fresh = await bookingWorld();
    try {
      const sid = await fresh.sailing('LXR-4', 28);
      const b = await staffBook(fresh.db, fresh.ctx, {
        channelId: fresh.channels.nilecrz,
        sailingId: sid,
        market: 'international',
        cabins: [{ categoryId: fresh.demo.categories.STD, adults: 2 }],
        guests: [{ cabin: 0, firstName: 'Omar', lastName: 'Fathy', lead: true }],
        requestKey: 'snapshot-backfill-1',
      });
      await owner().query(
        `update vs.booking set confirmed_at = now() - interval '10 days' where id = $1`,
        [b.bookingId],
      );
      await owner().query(
        `update vs.booking_line set created_at = now() - interval '10 days' where booking_id = $1`,
        [b.bookingId],
      );
      const result = await backfillAnalytics(worker, fresh.ctx);
      expect(result.nights).toBeGreaterThanOrEqual(9);
      const { rows: nights } = await owner().query<{ reconstructed: boolean; bookings: number }>(
        `select reconstructed, bookings from vs.analytics_sailing_day where operator_id = $1 and sailing_id = $2`,
        [fresh.ctx.operatorId, sid],
      );
      expect(nights.length).toBe(result.nights);
      expect(nights.every((n) => n.reconstructed && n.bookings === 1)).toBe(true);
      // Only once: a second run, or a company that already has nights, rebuilds nothing.
      expect((await backfillAnalytics(worker, fresh.ctx)).nights).toBe(0);
      expect((await backfillAnalytics(worker, w.ctx)).nights).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});
