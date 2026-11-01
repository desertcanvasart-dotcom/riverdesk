import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError } from '@vs/contracts';
import {
  cancelBooking,
  channelAvailability,
  confirmHold,
  createAllotment,
  createHold,
  extendAllotment,
  reduceAllotment,
  releaseDueAllotments,
  releaseHold,
} from '../src/index';
import { bookingWorld, counters, lead, legsOf, type BookingWorld } from './helpers/booking-world';

describe('allotments', () => {
  let w: BookingWorld;
  let legA: string;
  let legB: string;
  let std: string;
  let allotmentId: string;

  beforeAll(async () => {
    w = await bookingWorld();
    [legA, legB] = (await legsOf(await w.sailing('LXR-7', 21))) as [string, string];
    std = w.demo.categories.STD;
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  const byKind = async (legId: string) =>
    Object.fromEntries((await counters(legId, std)).map((c) => [c.kind, c]));

  it('create: pool total −N, allotment bucket = N, only from free pool cabins', async () => {
    const allotment = await createAllotment(w.db, w.ctx, {
      channelId: w.agents.allotment,
      vesselId: w.demo.vesselId,
      legIds: [legA, legB],
      categories: [{ categoryId: std, cabins: 3 }],
      releaseDays: 7,
    });
    allotmentId = allotment.id;
    expect(await byKind(legA)).toMatchObject({ pool: { total: 9 }, allotment: { total: 3 } });
    const tooMany = await createAllotment(w.db, w.ctx, {
      channelId: w.agents.allotment,
      vesselId: w.demo.vesselId,
      legIds: [legA],
      categories: [{ categoryId: std, cabins: 10 }],
    }).catch((e: unknown) => e);
    expect(isDomainError(tooMany, 'NOT_AVAILABLE')).toBe(true);
  });

  it('the channel books from its allotment first; an allotment-only contract never falls back to the pool', async () => {
    const sailing = await w.sailing('LXR-7', 21);
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.agents.allotment,
      quoteId: await w.quote(w.agents.allotment, sailing, [
        { cat: 'STD' },
        { cat: 'STD' },
        { cat: 'STD' },
      ]),
      kind: 'option',
    });
    expect(await byKind(legA)).toMatchObject({ pool: { held: 0 }, allotment: { held: 3 } });
    const more = await createHold(w.db, w.ctx, {
      channelId: w.agents.allotment,
      quoteId: await w.quote(w.agents.allotment, sailing, [{ cat: 'STD' }]),
      kind: 'option',
    }).catch((e: unknown) => e);
    expect(isDomainError(more, 'NOT_AVAILABLE')).toBe(true);
    // Other channels never see the allotment.
    const nilecrz = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, sailing, [{ cat: 'STD' }]),
      kind: 'option',
    });
    expect(await byKind(legA)).toMatchObject({ pool: { held: 1 }, allotment: { held: 3 } });
    await releaseHold(w.db, w.ctx, { holdId: nilecrz.holdId });
    await releaseHold(w.db, w.ctx, { holdId: hold.holdId });
  });

  it('extend adds cabins; reduce takes only unused cabins', async () => {
    await extendAllotment(w.db, w.ctx, {
      allotmentId,
      legIds: [legA, legB],
      categories: [{ categoryId: std, cabins: 1 }],
    });
    expect(await byKind(legA)).toMatchObject({ pool: { total: 8 }, allotment: { total: 4 } });
    const sailing = await w.sailing('LXR-7', 21);
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.agents.allotment,
      quoteId: await w.quote(w.agents.allotment, sailing, [
        { cat: 'STD' },
        { cat: 'STD' },
        { cat: 'STD' },
      ]),
      kind: 'option',
    });
    const refused = await reduceAllotment(w.db, w.ctx, {
      allotmentId,
      legIds: [legA],
      categoryId: std,
      cabins: 2,
    }).catch((e: unknown) => e);
    expect(isDomainError(refused, 'NOT_AVAILABLE')).toBe(true);
    await reduceAllotment(w.db, w.ctx, {
      allotmentId,
      legIds: [legA, legB],
      categoryId: std,
      cabins: 1,
    });
    expect(await byKind(legA)).toMatchObject({
      pool: { total: 9 },
      allotment: { total: 3, held: 3 },
    });
    await releaseHold(w.db, w.ctx, { holdId: hold.holdId });
  });

  it('release: unused cabins return to the pool; a later cancellation moves its cabin to the pool too', async () => {
    const sailing = await w.sailing('LXR-7', 21);
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.agents.allotment,
      quoteId: await w.quote(w.agents.allotment, sailing, [{ cat: 'STD' }]),
      kind: 'option',
    });
    const booking = await confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead });
    expect((await releaseDueAllotments(w.db, w.ctx)).released).toBe(0); // not due yet (M+21 − 7 days)

    // Test-only time travel: the release date has come.
    await owner().query(`update vs.allotment set release_days = 60 where id = $1`, [allotmentId]);
    expect((await releaseDueAllotments(w.db, w.ctx)).released).toBe(2);
    expect(await byKind(legA)).toMatchObject({
      pool: { total: 11 },
      allotment: { total: 1, booked: 1 },
    });

    await cancelBooking(w.db, w.ctx, { bookingId: booking.bookingId, reason: 'Agent cancelled' });
    expect(await byKind(legA)).toMatchObject({
      pool: { total: 12, booked: 0 },
      allotment: { total: 0, booked: 0 },
    });
    expect(await byKind(legB)).toMatchObject({ pool: { total: 12 }, allotment: { total: 0 } });
    const { rows } = await owner().query(`select status from vs.allotment where id = $1`, [
      allotmentId,
    ]);
    expect(rows[0].status).toBe('released');
  });

  it('availability shows what one booking can take: the larger of allotment and pool, not both', async () => {
    const sailing = await w.sailing('LXR-4', 63);
    const [leg] = (await legsOf(sailing)) as [string];
    const rs = w.demo.categories.RS;
    // Two royal suites: one in the credit agent's allotment, one left in the pool.
    await createAllotment(w.db, w.ctx, {
      channelId: w.agents.credit,
      vesselId: w.demo.vesselId,
      legIds: [leg],
      categories: [{ categoryId: rs, cabins: 1 }],
    });
    const embark = (
      await owner().query<{ d: string }>(
        `select embark_date::text as d from vs.sailing where id = $1`,
        [sailing],
      )
    ).rows[0]!.d;
    const shown = await channelAvailability(w.db, w.ctx, {
      channelId: w.agents.credit,
      vesselId: w.demo.vesselId,
      from: embark,
      to: embark,
    });
    const suites = shown.sailings
      .find((s) => s.sailingId === sailing)!
      .categories.find((c) => c.categoryId === rs);
    expect(suites?.free).toBe(1);
    const two = await createHold(w.db, w.ctx, {
      channelId: w.agents.credit,
      quoteId: await w.quote(w.agents.credit, sailing, [{ cat: 'RS' }, { cat: 'RS' }]),
      kind: 'option',
    }).catch((e: unknown) => e);
    expect(isDomainError(two, 'NOT_AVAILABLE')).toBe(true);
    const one = await createHold(w.db, w.ctx, {
      channelId: w.agents.credit,
      quoteId: await w.quote(w.agents.credit, sailing, [{ cat: 'RS' }]),
      kind: 'option',
    });
    await releaseHold(w.db, w.ctx, { holdId: one.holdId });
  });
});
