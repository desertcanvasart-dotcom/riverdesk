import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { addDays } from '@vs/shared';
import {
  addCabinCategory,
  addCabins,
  addVessel,
  cancelBooking,
  confirmHold,
  createHold,
  createQuote,
  generateSchedule,
  getFleet,
  updateCabinCategory,
  updateVessel,
} from '../src/index';
import { buckets, demoWorld, legs, sailingOverLeg, type World } from './helpers/world';

describe('Ships & cabins (fleet setup)', () => {
  let world: World;
  let today: string;

  beforeAll(async () => {
    world = await demoWorld();
    await generateSchedule(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      until: addDays(world.demo.validFrom, 13),
    });
    const { rows } = await owner().query<{ d: string }>(
      `select (now() at time zone 'Africa/Cairo')::date::text as d`,
    );
    today = rows[0]!.d;
  });

  afterAll(async () => {
    await world.close();
  });

  it('a new ship with categories and many cabins at once; the fleet shows the counts', async () => {
    const ship = await addVessel(world.db, world.ctx, {
      code: 'NEWSHIP',
      name: 'New Ship',
      type: 'dahabiya',
      maxGuests: 20,
    });
    const deluxe = await addCabinCategory(world.db, world.ctx, {
      vesselId: ship.id,
      code: 'DLX',
      nameEn: 'Deluxe',
      nameAr: 'ديلوكس',
      maxAdults: 2,
      maxOccupancy: 3,
    });
    const added = await addCabins(world.db, world.ctx, {
      vesselId: ship.id,
      categoryId: deluxe.id,
      numbers: ['101', '102', '103', '104'],
      deck: 'Main',
      effectiveFrom: today,
      reason: 'Initial setup',
    });
    expect(added).toEqual({ added: 4, legsAffected: 0 });

    const fleet = await getFleet(world.db, world.ctx);
    const row = fleet.find((v) => v.id === ship.id)!;
    expect(row).toMatchObject({ code: 'NEWSHIP', type: 'dahabiya', cabins: 4, upcomingLegs: 0 });
    expect(row.categories).toEqual([expect.objectContaining({ code: 'DLX', cabins: 4 })]);
    const demo = fleet.find((v) => v.id === world.demo.vesselId)!;
    expect(demo.cabins).toBe(30);
    expect(demo.upcomingLegs).toBeGreaterThan(0);
  });

  it('refuses a ship or category code already used, and cabin numbers already on the ship', async () => {
    await expect(
      addVessel(world.db, world.ctx, {
        code: 'NEWSHIP',
        name: 'Again',
        type: 'steam',
        maxGuests: 5,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'code_taken' } });
    await expect(
      addCabinCategory(world.db, world.ctx, {
        vesselId: world.demo.vesselId,
        code: 'STD',
        nameEn: 'Dup',
        nameAr: 'مكرر',
        maxAdults: 2,
        maxOccupancy: 2,
      }),
    ).rejects.toMatchObject({ details: { reason: 'code_taken' } });

    const before = await owner().query(
      `select count(*)::int as n from vs.cabin where vessel_id = $1`,
      [world.demo.vesselId],
    );
    // 999 is new, but the existing number makes the whole batch fail: nothing is added.
    const existing = (
      await owner().query<{ number: string }>(
        `select number from vs.cabin where vessel_id = $1 limit 1`,
        [world.demo.vesselId],
      )
    ).rows[0]!.number;
    await expect(
      addCabins(world.db, world.ctx, {
        vesselId: world.demo.vesselId,
        categoryId: world.demo.categories.STD,
        numbers: ['999', existing],
        effectiveFrom: today,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ details: { reason: 'number_taken', numbers: [existing] } });
    const after = await owner().query(
      `select count(*)::int as n from vs.cabin where vessel_id = $1`,
      [world.demo.vesselId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('cabins added to a ship with departures raise availability on every later leg', async () => {
    const allLegs = await legs(world.demo.vesselId);
    const total = async () =>
      (await buckets(world.demo.vesselId))
        .filter((b) => b.kind === 'pool' && b.category_id === world.demo.categories.STD)
        .map((b) => b.total);
    const start = await total();
    const from = allLegs[2]!.depart_date;
    const result = await addCabins(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      categoryId: world.demo.categories.STD,
      numbers: ['150', '151'],
      effectiveFrom: from,
      reason: 'Refit',
    });
    expect(result.legsAffected).toBe(allLegs.length - 2);
    expect(await total()).toEqual(start.map((n, i) => (i >= 2 ? n + 2 : n)));
  });

  it('edits a ship but keeps its code, with an audit entry', async () => {
    const updated = await updateVessel(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      name: 'Renamed Ship',
      type: 'cruise_ship',
      maxGuests: 72,
    });
    expect(updated).toMatchObject({ name: 'Renamed Ship', max_guests: 72 });
    const audit = await owner().query(
      `select diff from vs.audit_log where action = 'vessel.updated' and entity_id = $1`,
      [world.demo.vesselId],
    );
    expect(audit.rows[0].diff).toMatchObject({ name: { to: 'Renamed Ship' } });
  });

  it('a lower guest limit is refused while a booking still to sail has more guests', async () => {
    const jsId = world.demo.categories.JS; // max 2 adults, 3 guests
    const leg = (await legs(world.demo.vesselId))[1]!;
    const quote = await createQuote(world.db, world.ctx, {
      channelId: world.channels.nilecrz,
      sailingId: await sailingOverLeg(leg.id),
      market: 'international',
      cabins: [{ categoryId: jsId, adults: 2 }],
    });
    const hold = await createHold(world.db, world.ctx, {
      channelId: world.channels.nilecrz,
      quoteId: quote.id,
      kind: 'option',
    });
    const booking = await confirmHold(world.db, world.ctx, {
      holdId: hold.holdId,
      guests: [{ cabin: 0, firstName: 'Two', lastName: 'Adults', lead: true }],
    });
    const edit = (maxAdults: number, maxOccupancy: number) =>
      updateCabinCategory(world.db, world.ctx, {
        categoryId: jsId,
        nameEn: 'Junior suite',
        nameAr: 'جناح صغير',
        maxAdults,
        maxOccupancy,
        extraBedAllowed: false,
        sortOrder: 3,
      });
    await expect(edit(1, 3)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'occupancy_in_use', bookings: 1 },
    });
    // Raising, or lowering only what no booking uses, is fine.
    await expect(edit(2, 2)).resolves.toMatchObject({ max_adults: 2, max_occupancy: 2 });
    await cancelBooking(world.db, world.ctx, { bookingId: booking.bookingId, reason: 'test' });
    await expect(edit(1, 2)).resolves.toMatchObject({ max_adults: 1, name_en: 'Junior suite' });
  });
});
