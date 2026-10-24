import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignCabin,
  autoAssignCabins,
  blockCabins,
  changeCapacity,
  getCabinMap,
  staffBook,
} from '../src/index';
import { bookingWorld, legsOf, type BookingWorld } from './helpers/booking-world';

describe('staff cabin map', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('shows every cabin of the departure with its party, block or free state', async () => {
    const sailing = await w.sailing('LXR-7', 21);
    const [firstLeg, secondLeg] = await legsOf(sailing);
    const week = await staffBook(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      sailingId: sailing,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2, childAges: [6] }],
      guests: [{ cabin: 0, firstName: 'Lina', lastName: 'Map', lead: true }],
      requestKey: 'cabin-map-1',
    });
    let map = await getCabinMap(w.db, w.ctx, firstLeg!);
    expect(map.cabins).toHaveLength(30);
    expect(map.unassigned).toEqual([
      expect.objectContaining({
        ref: week.ref,
        lead: 'Lina Map',
        guests: 3,
        boardedEarlier: false,
        staysLonger: true,
        category: expect.objectContaining({ code: 'STD' }),
      }),
    ]);
    expect(map.counts.find((c) => c.code === 'STD')).toMatchObject({ booked: 1 });

    await autoAssignCabins(w.db, w.ctx, {
      vesselId: w.demo.vesselId,
      legIds: [firstLeg!, secondLeg!],
    });
    map = await getCabinMap(w.db, w.ctx, secondLeg!);
    const occupied = map.cabins.filter((c) => c.state === 'occupied');
    expect(occupied).toHaveLength(1);
    expect(occupied[0]!.party).toMatchObject({
      ref: week.ref,
      boardedEarlier: true,
      staysLonger: false,
    });
    expect(map.unassigned).toEqual([]);

    // Moving the party is a click on the map: the same assignCabin as the list.
    const target = map.cabins.find(
      (c) => c.state === 'free' && c.category?.code === 'STD' && c.id !== occupied[0]!.id,
    )!;
    await assignCabin(w.db, w.ctx, {
      bookingCabinId: occupied[0]!.party!.bookingCabinId,
      cabinId: target.id,
    });
    map = await getCabinMap(w.db, w.ctx, firstLeg!);
    expect(map.cabins.find((c) => c.id === target.id)!.state).toBe('occupied');

    // A block on one cabin shows on that cabin, with its reason.
    const blocked = map.cabins.find((c) => c.state === 'free' && c.category?.code === 'SUP')!;
    await blockCabins(w.db, w.ctx, {
      legIds: [firstLeg!],
      categoryId: blocked.category!.id,
      count: 1,
      cabinId: blocked.id,
      reason: 'Air conditioning repair',
    });
    map = await getCabinMap(w.db, w.ctx, firstLeg!);
    expect(map.cabins.find((c) => c.id === blocked.id)).toMatchObject({
      state: 'blocked',
      blockReason: 'Air conditioning repair',
    });
  });

  it('a cabin with no category on that date is out of service', async () => {
    const sailing = await w.sailing('LXR-4', 28);
    const [leg] = await legsOf(sailing);
    const before = await getCabinMap(w.db, w.ctx, leg!);
    const cabin = before.cabins.find((c) => c.state === 'free')!;
    await changeCapacity(w.db, w.ctx, {
      vesselId: w.demo.vesselId,
      effectiveFrom: before.leg.departDate,
      change: { kind: 'remove', cabinId: cabin.id },
      reason: 'Refit',
    });
    const map = await getCabinMap(w.db, w.ctx, leg!);
    expect(map.cabins.find((c) => c.id === cabin.id)).toMatchObject({
      state: 'out_of_service',
      category: null,
    });
  });
});
