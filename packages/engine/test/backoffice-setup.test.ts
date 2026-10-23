import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { addDays } from '@vs/shared';
import {
  blockCabins,
  getInventoryGrid,
  getRatesSetup,
  getScheduleSetup,
  listCabins,
  previewScheduleException,
  staffBook,
} from '../src/index';
import { bookingWorld, lead, legsOf, type BookingWorld } from './helpers/booking-world';

describe('inventory, schedule and rates read models', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('shows booked, blocked and free per leg × category, and the active blocks', async () => {
    const sailingId = await w.sailing('LXR-4', 21);
    const [legId] = await legsOf(sailingId);
    await staffBook(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: 'grid-booking-0001',
    });
    await blockCabins(w.db, w.ctx, {
      legIds: [legId!],
      categoryId: w.demo.categories.STD,
      count: 2,
      reason: 'Repairs',
    });
    const day = (
      await owner().query<{ d: string }>(
        `select depart_date::text as d from vs.leg where id = $1`,
        [legId],
      )
    ).rows[0]!.d;
    const grid = await getInventoryGrid(w.db, w.ctx, {
      vesselId: w.demo.vesselId,
      from: day,
      to: day,
    });
    const cell = grid.legs
      .find((l) => l.id === legId)!
      .cells.find((c) => c.categoryId === w.demo.categories.STD)!;
    expect(cell.pool.booked).toBe(1);
    expect(cell.blocked).toBe(2);
    expect(cell.free).toBe(cell.pool.total - cell.pool.held - cell.pool.booked);
    expect(grid.blocks).toEqual([
      expect.objectContaining({ count: 2, reason: 'Repairs', legs: 1 }),
    ]);
  });

  it('previews a cancellation exactly, then leaves the schedule untouched', async () => {
    const sailingId = await w.sailing('LXR-4', 28);
    const legIds = await legsOf(sailingId);
    const booking = await staffBook(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: 'preview-booking-0001',
    });
    const events = async () =>
      (await owner().query<{ n: number }>(`select count(*)::int as n from vs.event`)).rows[0]!.n;
    const before = await events();
    const preview = await previewScheduleException(w.db, w.ctx, {
      vesselId: w.demo.vesselId,
      kind: 'cancel',
      legIds: [legIds[0]!],
      reason: 'Low water',
    });
    expect(preview.legsChanged).toBe(1);
    expect(preview.sailingsChanged).toBeGreaterThanOrEqual(1);
    expect(preview.bookings).toEqual([expect.objectContaining({ ref: booking.ref, cabins: 1 })]);
    const leg = await owner().query<{ status: string }>(`select status from vs.leg where id = $1`, [
      legIds[0],
    ]);
    expect(leg.rows[0]!.status).toBe('open');
    expect(await events()).toBe(before);
    expect(
      (await owner().query(`select 1 from vs.schedule_exception where reason = 'Low water'`))
        .rowCount,
    ).toBe(0);
  });

  it('lists templates with stops, patterns and departures', async () => {
    const setup = await getScheduleSetup(w.db, w.ctx, {
      vesselId: w.demo.vesselId,
      from: w.M,
      to: addDays(w.M, 13),
    });
    expect(setup.templates.length).toBeGreaterThan(0);
    expect(setup.templates[0]!.stops.length).toBeGreaterThan(1);
    expect(setup.patterns.map((p) => p.code)).toEqual(expect.arrayContaining(['LXR-4', 'LXR-7']));
    expect(setup.departures.length).toBeGreaterThan(0);
    expect(setup.lastDeparture).not.toBeNull();
    const cabins = await listCabins(w.db, w.ctx, w.demo.vesselId);
    expect(cabins.length).toBeGreaterThan(0);
    expect(cabins.every((c) => c.categoryId)).toBe(true);
  });

  it('lists rate plans with rates, seasons and policies', async () => {
    const rates = await getRatesSetup(w.db, w.ctx, w.demo.vesselId);
    expect(rates.plans.map((p) => p.market)).toContain('international');
    expect(rates.rates.length).toBeGreaterThan(0);
    expect(rates.seasons[0]!.periods.length).toBeGreaterThan(0);
    expect(rates.policies.cancellation[0]!.rules.length).toBeGreaterThan(0);
    expect(rates.policies.children[0]!.bands.length).toBeGreaterThan(0);
  });
});
