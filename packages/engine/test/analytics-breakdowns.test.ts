import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError } from '@vs/contracts';
import {
  behaviourReport,
  cancelBooking,
  channelsReport,
  createAllotment,
  createHold,
  requestAnalyticsExport,
  staffBook,
  todayInCairo,
} from '../src/index';
import { bookingWorld, legsOf, type BookingWorld } from './helpers/booking-world';

describe('analytics breakdowns (A1.3)', () => {
  let w: BookingWorld;
  let today: string;
  let sailingId: string;
  const period = () => ({ from: today, to: today });

  beforeAll(async () => {
    w = await bookingWorld();
    today = await todayInCairo(w.db);
    sailingId = await w.sailing('LXR-4', 14);
    // Two platform bookings today: one with a child, one cancelled the same day.
    await staffBook(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      sailingId,
      market: 'international',
      cabins: [
        { categoryId: w.demo.categories.STD, adults: 2, childAges: [7] },
        { categoryId: w.demo.categories.SUP, adults: 2 },
      ],
      guests: [{ cabin: 0, firstName: 'Lina', lastName: 'Saad', lead: true, nationality: 'FR' }],
      requestKey: 'breakdown-1',
    });
    const cancelled = await staffBook(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 1 }],
      guests: [{ cabin: 0, firstName: 'Adam', lastName: 'Fawzy', lead: true, nationality: 'EG' }],
      requestKey: 'breakdown-2',
    });
    await cancelBooking(w.db, w.ctx, {
      bookingId: cancelled.bookingId,
      reason: 'Test',
      requestKey: 'breakdown-cancel-2',
    });
    // An option hold, still active.
    const quoteId = await w.quote(w.channels.nilecrz, sailingId, [{ cat: 'STD', adults: 2 }]);
    await createHold(w.db, w.ctx, { channelId: w.channels.nilecrz, quoteId, kind: 'option' });
    // Three cabins allotted to an agency on the sailing's first departure.
    await createAllotment(w.db, w.ctx, {
      channelId: w.agents.allotment,
      vesselId: w.demo.vesselId,
      legIds: [(await legsOf(sailingId))[0]!],
      categories: [{ categoryId: w.demo.categories.STD, cabins: 3 }],
      releaseDays: 7,
    });
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('breaks bookings down by channel, counting cancelled ones and cabin-nights', async () => {
    const report = await channelsReport(w.db, w.ctx, period(), { withMoney: false });
    const nilecrz = report.channels.find((c) => c.channelId === w.channels.nilecrz)!;
    expect(nilecrz).toMatchObject({ bookings: 2, cabins: 3, cabinNights: 12, cancelled: 1 });
    expect(nilecrz).not.toHaveProperty('value');
    const money = await channelsReport(w.db, w.ctx, period(), { withMoney: true });
    const value = money.channels.find((c) => c.channelId === w.channels.nilecrz)!.value!;
    expect(value[0]).toMatchObject({ currency: 'USD', cabinNights: 12 });
    expect(value[0]!.total).toBeGreaterThan(0n);
  });

  it('breaks bookings down by market and guest nationality', async () => {
    const report = await channelsReport(w.db, w.ctx, period(), { withMoney: false });
    expect(report.markets).toEqual([
      expect.objectContaining({
        market: 'international',
        bookings: 2,
        cabins: 3,
        guests: 2 + 1 + 2 + 1,
        withChildren: 1,
      }),
    ]);
    expect(report.nationalities.map((n) => n.nationality).sort()).toEqual(['EG', 'FR']);
  });

  it('shows agency allotments on departures in the period', async () => {
    const { rows } = await owner().query<{ depart_date: string }>(
      `select l.depart_date::text from vs.sailing_leg sl join vs.leg l on l.id = sl.leg_id
       where sl.sailing_id = $1 order by sl.seq limit 1`,
      [sailingId],
    );
    const day = rows[0]!.depart_date;
    const report = await channelsReport(w.db, w.ctx, { from: day, to: day }, { withMoney: false });
    expect(report.allotments).toEqual([
      expect.objectContaining({
        channelId: w.agents.allotment,
        allotted: 3,
        sold: 0,
        released: 0,
        open: 3,
      }),
    ]);
  });

  it('narrows by channel, market and cabin category', async () => {
    const byCategory = await channelsReport(
      w.db,
      w.ctx,
      { ...period(), categoryId: w.demo.categories.SUP },
      { withMoney: false },
    );
    expect(byCategory.channels.find((c) => c.channelId === w.channels.nilecrz)).toMatchObject({
      bookings: 1,
    });
    const otherMarket = await channelsReport(
      w.db,
      w.ctx,
      { ...period(), market: 'egyptian_resident' },
      { withMoney: false },
    );
    expect(otherMarket.channels).toEqual([]);
    const bySailing = await channelsReport(
      w.db,
      w.ctx,
      { from: today, to: today, basis: 'sailing' },
      { withMoney: false },
    );
    expect(bySailing.channels).toEqual([]);
  });

  it('describes booking behaviour: window, length, holds, cancellations', async () => {
    const report = await behaviourReport(w.db, w.ctx, period(), { withMoney: true });
    const windowBookings = report.bookingWindow.bands.reduce((s, b) => s + b.bookings, 0);
    expect(windowBookings).toBe(2);
    expect(report.bookingWindow.median).toBeGreaterThanOrEqual(8);
    expect(report.lengths).toEqual([{ nights: 4, bookings: 2, cabins: 3 }]);
    expect(report.itineraries[0]).toMatchObject({ code: 'LXR-4', bookings: 2 });
    expect(report.holds.find((h) => h.kind === 'option')).toMatchObject({ active: 1 });
    expect(report.cancellations.bands.reduce((s, b) => s + b.bookings, 0)).toBe(1);
    expect(report.cancellations.penalties).toBeDefined();
    expect(report.amendments).toMatchObject({ amendments: 0, bookings: 0, changes: [] });
    const plain = await behaviourReport(w.db, w.ctx, period(), { withMoney: false });
    expect(plain.cancellations).not.toHaveProperty('penalties');
  });

  it('refuses a period longer than 400 days', async () => {
    const result = await channelsReport(
      w.db,
      w.ctx,
      { from: '2025-01-01', to: '2026-12-31' },
      { withMoney: false },
    ).catch((e: unknown) => e);
    expect(isDomainError(result, 'VALIDATION_FAILED')).toBe(true);
  });

  it('records an Excel export with money decided by the caller, not the browser', async () => {
    const { documentId } = await requestAnalyticsExport(
      w.db,
      w.ctx,
      { report: 'channels', locale: 'en', filter: period() },
      { withMoney: false },
    );
    const { rows } = await owner().query(
      `select kind, format, entity, entity_id, variant, params from vs.document where id = $1`,
      [documentId],
    );
    expect(rows[0]).toMatchObject({
      kind: 'analytics_export',
      format: 'xlsx',
      entity: 'operator',
      entity_id: w.ctx.operatorId,
      variant: 'agent',
      params: { report: 'channels', withMoney: false },
    });
  });
});
