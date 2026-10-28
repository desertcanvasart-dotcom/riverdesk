import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner, testConfig } from '@vs/db/testing';
import { addDays, cairoDayStart, daysBetween, type BusinessDate } from '@vs/shared';
import {
  analyticsOverview,
  cancelBooking,
  occupancyReport,
  openDatabase,
  sailingPace,
  staffBook,
  takeAnalyticsSnapshot,
  todayInCairo,
  type VsDatabase,
} from '../src/index';
import { bookingWorld, type BookingWorld } from './helpers/booking-world';

describe('analytics reports (A1.2)', () => {
  let w: BookingWorld;
  let worker: VsDatabase;
  let sailingId: string;
  let today: string;

  beforeAll(async () => {
    w = await bookingWorld();
    worker = openDatabase('vs_worker', { config: testConfig(), max: 2 });
    today = await todayInCairo(w.db);
    sailingId = await w.sailing('LXR-4', 14);
    await staffBook(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      sailingId,
      market: 'international',
      cabins: [
        { categoryId: w.demo.categories.STD, adults: 2 },
        { categoryId: w.demo.categories.STD, adults: 2 },
      ],
      guests: [{ cabin: 0, firstName: 'Hana', lastName: 'Ali', lead: true }],
      requestKey: 'reports-booking-1',
    });
    const cancelled = await staffBook(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: [{ cabin: 0, firstName: 'Karim', lastName: 'Nabil', lead: true }],
      requestKey: 'reports-booking-2',
    });
    await cancelBooking(w.db, w.ctx, {
      bookingId: cancelled.bookingId,
      reason: 'Test',
      requestKey: 'reports-cancel-2',
    });
  }, 120_000);

  afterAll(async () => {
    await worker.close();
    await w.close();
  });

  it('measures occupancy as cabin-nights booked over cabin-nights on sale', async () => {
    const overview = await analyticsOverview(w.db, w.ctx, {}, { withMoney: false });
    const { rows } = await owner().query<{ booked: number; sale: number }>(
      `select coalesce(sum(b.booked * (l.arrive_date - l.depart_date)), 0)::int as booked,
              coalesce(sum(b.total * (l.arrive_date - l.depart_date)), 0)::int as sale
       from vs.leg l join vs.inventory_bucket b on b.leg_id = l.id and b.kind in ('pool', 'allotment')
       where l.operator_id = $1 and l.depart_date >= $2::date and l.depart_date < $2::date + 30`,
      [w.ctx.operatorId, today],
    );
    expect(overview.occupancy.next30).toEqual({
      bookedNights: rows[0]!.booked,
      saleNights: rows[0]!.sale,
    });
    expect(overview.occupancy.next30.bookedNights).toBeGreaterThanOrEqual(2 * 4);
  });

  it('counts confirmations in the period, money only for those who see it', async () => {
    const plain = await analyticsOverview(w.db, w.ctx, {}, { withMoney: false });
    // Both bookings were confirmed today; the cancelled one still counts as booked this week.
    expect(plain.sales.week).toMatchObject({ bookings: 2, cabins: 3 });
    expect(plain.sales.week).not.toHaveProperty('value');
    expect(plain.sales.weekLastYear).toMatchObject({ bookings: 0, cabins: 0 });
    expect(plain.historyFrom).toBe(today);
    const withMoney = await analyticsOverview(w.db, w.ctx, {}, { withMoney: true });
    expect(withMoney.sales.week.value?.[0]?.total).toBeGreaterThan(0n);
    expect(plain.cancellations).toEqual({ cancelled: 1, confirmed: 2 });
  });

  it('reads pace from the nightly record, and says when there is none', async () => {
    let overview = await analyticsOverview(w.db, w.ctx, {}, { withMoney: false });
    expect(overview.pace).toMatchObject({
      now: 2,
      sevenNightsAgo: null,
      twentyEightNightsAgo: null,
    });
    // A snapshot taken a week ago (what was on the books then: the same two cabins).
    // Noon in Cairo a week ago: the snapshot's night is the run time less two hours, so a test
    // run just after midnight would otherwise write the night before.
    const weekAgo = addDays(today as BusinessDate, -7);
    await takeAnalyticsSnapshot(
      worker,
      w.ctx,
      new Date(cairoDayStart(weekAgo).getTime() + 12 * 3_600_000),
    );
    overview = await analyticsOverview(w.db, w.ctx, {}, { withMoney: false });
    expect(overview.pace.sevenNightsAgo).toBe(2);
  });

  it('lists sailings with their own bookings and the occupancy of their departures', async () => {
    const report = await occupancyReport(
      w.db,
      w.ctx,
      { from: today, days: 30 },
      { withMoney: false },
    );
    const row = report.sailings.find((s) => s.sailingId === sailingId)!;
    expect(row).toMatchObject({ bookings: 1, cabins: 2, nights: 4 });
    expect(row.bookedNights).toBeGreaterThanOrEqual(8);
    expect(row).not.toHaveProperty('value');
    const cell = report.cells.find(
      (c) => c.sailingId === sailingId && c.categoryId === w.demo.categories.STD,
    )!;
    expect(cell.bookedNights).toBeGreaterThanOrEqual(8);
    expect(report.categories.map((c) => c.categoryId)).toContain(w.demo.categories.STD);
    const money = await occupancyReport(
      w.db,
      w.ctx,
      { from: today, days: 30 },
      { withMoney: true },
    );
    expect(money.sailings.find((s) => s.sailingId === sailingId)!.value).toHaveLength(1);
  });

  it('draws a sailing’s pace by days before embarkation', async () => {
    await takeAnalyticsSnapshot(worker, w.ctx);
    const pace = await sailingPace(w.db, w.ctx, { sailingId });
    const days = pace.current.map((p) => p.daysBefore);
    // Tonight's snapshot (yesterday's night just after midnight) and the one the overview test
    // took at noon a week ago; M is 0–6 days from today.
    const ahead = daysBetween(today as BusinessDate, pace.embarkDate! as BusinessDate);
    expect([ahead, ahead + 1]).toContain(days.at(-1));
    expect(days).toContain(ahead + 7);
    expect(pace.current.every((p) => p.cabins === 2)).toBe(true);
    // No sailing of this vessel embarked on the same date a year earlier.
    expect(pace).toMatchObject({ lastYearDate: null, lastYear: [] });
  });

  it('narrows everything to one vessel', async () => {
    const other = '00000000-0000-7000-8000-000000000001';
    const overview = await analyticsOverview(
      w.db,
      w.ctx,
      { vesselId: other },
      { withMoney: false },
    );
    expect(overview.sales.week.bookings).toBe(0);
    expect(overview.occupancy.next30).toEqual({ bookedNights: 0, saleNights: 0 });
    const report = await occupancyReport(
      w.db,
      w.ctx,
      { vesselId: other, from: today, days: 30 },
      { withMoney: false },
    );
    expect(report.sailings).toEqual([]);
  });
});
