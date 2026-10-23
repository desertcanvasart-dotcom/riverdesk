import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError } from '@vs/contracts';
import {
  assignCabin,
  autoAssignCabins,
  cabinOptions,
  cancelBooking,
  erasePassports,
  getLegManifest,
  listDepartures,
  staffBook,
} from '../src/index';
import { bookingWorld, legsOf, type BookingWorld } from './helpers/booking-world';

describe('cabin assignment, manifests and passport erasure', () => {
  let w: BookingWorld;
  let n = 0;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  const book = (pattern: 'LXR-4' | 'LXR-7', offset: number, passport?: string) =>
    w.sailing(pattern, offset).then((sailingId) =>
      staffBook(w.db, w.ctx, {
        channelId: w.channels.nilecrz,
        sailingId,
        market: 'international',
        cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
        guests: [
          {
            cabin: 0,
            firstName: 'Lina',
            lastName: `Guest${n}`,
            lead: true,
            passportNumber: passport,
          },
        ],
        requestKey: `assign-${(n += 1)}`,
      }),
    );
  const partyOf = async (bookingId: string) =>
    (
      await owner().query<{ id: string }>(`select id from vs.booking_cabin where booking_id = $1`, [
        bookingId,
      ])
    ).rows[0]!.id;
  const cabinsOf = async (bookingId: string) =>
    (
      await owner().query<{ leg_id: string; cabin: string | null }>(
        `select leg_id, assigned_cabin_id as cabin from vs.booking_line where booking_id = $1 and status = 'confirmed'`,
        [bookingId],
      )
    ).rows;

  it('auto-assigns one cabin per party for its whole cruise, never the same cabin twice on a leg', async () => {
    const week = await book('LXR-7', 14); // two legs
    const short = await book('LXR-4', 14); // the first leg only
    const legIds = await legsOf(await w.sailing('LXR-7', 14));
    const result = await autoAssignCabins(w.db, w.ctx, { vesselId: w.demo.vesselId, legIds });
    expect(result).toMatchObject({ assigned: 2, unplaced: 0 });
    const weekCabins = await cabinsOf(week.bookingId);
    expect(new Set(weekCabins.map((l) => l.cabin)).size).toBe(1);
    const [shortLine] = await cabinsOf(short.bookingId);
    expect(shortLine!.cabin).not.toBe(weekCabins[0]!.cabin);
    // A second run has nothing to do.
    expect(
      await autoAssignCabins(w.db, w.ctx, { vesselId: w.demo.vesselId, legIds }),
    ).toMatchObject({
      assigned: 0,
    });
    const departures = await listDepartures(w.db, w.ctx, {
      vesselId: w.demo.vesselId,
      from: '2000-01-01',
      to: '2100-01-01',
    });
    expect(departures.find((d) => d.id === legIds[0])).toMatchObject({ unassigned: 0 });
  });

  it('lets staff move a party to a free cabin, refuses a taken one, and frees it on cancellation', async () => {
    const a = await book('LXR-4', 21);
    const b = await book('LXR-4', 21);
    const legIds = await legsOf(await w.sailing('LXR-4', 21));
    await autoAssignCabins(w.db, w.ctx, { vesselId: w.demo.vesselId, legIds });
    const [aLine] = await cabinsOf(a.bookingId);
    const partyB = await partyOf(b.bookingId);
    const refused = await assignCabin(w.db, w.ctx, {
      bookingCabinId: partyB,
      cabinId: aLine!.cabin,
    }).catch((e: unknown) => e);
    expect(isDomainError(refused, 'INVALID_STATE')).toBe(true);
    const options = await cabinOptions(w.db, w.ctx, partyB);
    expect(options.map((o) => o.id)).not.toContain(aLine!.cabin);
    const other = options.find((o) => !o.current)!;
    await assignCabin(w.db, w.ctx, { bookingCabinId: partyB, cabinId: other.id });
    expect((await cabinsOf(b.bookingId))[0]!.cabin).toBe(other.id);

    await cancelBooking(w.db, w.ctx, { bookingId: a.bookingId, reason: 'test' });
    expect((await cabinOptions(w.db, w.ctx, partyB)).map((o) => o.id)).toContain(aLine!.cabin);
  });

  it('shows passports only in the manifest export, and erases them after the retention period', async () => {
    const booked = await book('LXR-4', 28, 'P7654321');
    const [legId] = await legsOf(await w.sailing('LXR-4', 28));
    const screen = await getLegManifest(w.db, w.ctx, legId!);
    const guest = screen.parties.find((p) => p.ref === booked.ref)!.guests[0]!;
    expect(guest).toMatchObject({ hasPassport: true });
    expect(guest).not.toHaveProperty('passportNumber');
    const exported = await getLegManifest(w.db, w.ctx, legId!, { withPassports: true });
    expect(exported.parties.find((p) => p.ref === booked.ref)!.guests[0]!.passportNumber).toBe(
      'P7654321',
    );

    // Time travel: this cruise ended long ago.
    const sailing = await owner().query<{ id: string }>(
      `select s.id from vs.sailing s join vs.booking b on b.sailing_id = s.id where b.id = $1`,
      [booked.bookingId],
    );
    const sailingId = sailing.rows[0]!.id;
    const shift = (days: number) =>
      owner().query(
        `update vs.sailing set embark_date = embark_date + $2::int, disembark_date = disembark_date + $2::int where id = $1`,
        [sailingId, days],
      );
    await shift(-400);
    try {
      expect((await erasePassports(w.db, w.ctx)).erased).toBeGreaterThanOrEqual(1);
    } finally {
      await shift(400);
    }
    const after = await owner().query(
      `select passport_ciphertext, date_of_birth, first_name from vs.guest where booking_id = $1`,
      [booked.bookingId],
    );
    expect(after.rows[0]).toMatchObject({
      passport_ciphertext: null,
      date_of_birth: null,
      first_name: 'Lina',
    });
  });
});
