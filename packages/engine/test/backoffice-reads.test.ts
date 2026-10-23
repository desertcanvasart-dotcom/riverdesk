import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mulDivHalfUp } from '@vs/shared';
import {
  confirmHold,
  createHold,
  createRequest,
  getBookingDetail,
  listBookableChannels,
  listRequests,
  listVessels,
  previewCancellation,
  searchBookings,
  staffBook,
  upsertGuests,
} from '../src/index';
import { owner } from '@vs/db/testing';
import { bookingWorld, lead, type BookingWorld } from './helpers/booking-world';

describe('back-office read models', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('lists vessels with categories and the channels staff can book for', async () => {
    const vessels = await listVessels(w.db, w.ctx);
    const vessel = vessels.find((v) => v.id === w.demo.vesselId)!;
    expect(vessel.categories.map((c) => c.id)).toContain(w.demo.categories.STD);
    const channels = await listBookableChannels(w.db, w.ctx, w.demo.vesselId);
    expect(channels[0]!.type).toBe('back_office');
    expect(channels.map((c) => c.id)).toContain(w.channels.nilecrz);
  });

  it('searches bookings by guest name and reference and shows the detail', async () => {
    const sailing = await w.sailing('LXR-4', 35);
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, sailing, [{ cat: 'STD' }]),
      kind: 'option',
    });
    const booking = await confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead });
    const byName = await searchBookings(w.db, w.ctx, { q: 'mona hass' });
    const found = byName.find((b) => b.id === booking.bookingId)!;
    expect(found).toMatchObject({ ref: booking.ref, leadGuest: 'Mona Hassan', cabins: 1 });
    expect((await searchBookings(w.db, w.ctx, { q: booking.ref }))[0]!.id).toBe(booking.bookingId);
    expect(await searchBookings(w.db, w.ctx, { q: booking.ref, status: 'cancelled' })).toEqual([]);

    const detail = await getBookingDetail(w.db, w.ctx, booking.ref);
    expect(detail.guests).toEqual([
      expect.objectContaining({ firstName: 'Mona', lead: true, hasPassport: false }),
    ]);
    expect(detail.revisions.map((r) => r.rev)).toEqual([1]);
    expect(detail.channel.paymentMode).toBe('channel_collected');

    // 35 days out on the standard policy: 25% of the total.
    const preview = await previewCancellation(w.db, w.ctx, booking.bookingId);
    expect(preview.penaltyBps).toBe(2500);
    expect(preview.penalty).toBe(mulDivHalfUp(detail.total, 2500n, 10_000n));
  });

  it('lists open requests with their cabins, oldest deadline first', async () => {
    const sailing = await w.sailing('LXR-7', 21);
    const request = await createRequest(w.db, w.ctx, {
      channelId: w.agents.onRequest,
      quoteId: await w.quote(w.agents.onRequest, sailing, [{ cat: 'STD' }]),
      guests: lead,
    });
    const inbox = await listRequests(w.db, w.ctx);
    const item = inbox.find((r) => r.bookingId === request.bookingId)!;
    expect(item.status).toBe('requested');
    expect(item.cabins).toEqual([
      expect.objectContaining({ categoryId: w.demo.categories.STD, adults: 2 }),
    ]);
    expect(item.expiresAt).toBeInstanceOf(Date);
    expect(item.offer).toBeNull();
  });
});

describe('fast booking (staffBook)', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('books in one call, and the same request key returns the same booking', async () => {
    const sailingId = await w.sailing('LXR-4', 28);
    const input = {
      channelId: w.channels.nilecrz,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2, childAges: [4] }],
      guests: lead,
      requestKey: 'phone-booking-0001',
    };
    const first = await staffBook(w.db, w.ctx, input);
    expect(first.status).toBe('confirmed');
    const again = await staffBook(w.db, w.ctx, input);
    expect(again.bookingId).toBe(first.bookingId);
    expect(await searchBookings(w.db, w.ctx, { q: first.ref })).toHaveLength(1);
  });

  it('keeps a passport on file when staff edit the guest without retyping it', async () => {
    const sailingId = await w.sailing('LXR-4', 42);
    const booked = await staffBook(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: [{ ...lead[0]!, passportNumber: 'P1234567' }],
      requestKey: 'phone-booking-0003',
    });
    const before = await getBookingDetail(w.db, w.ctx, booked.ref);
    const kept = before.guests[0]!;
    await upsertGuests(w.db, w.ctx, {
      bookingId: booked.bookingId,
      guests: [
        {
          cabin: 0,
          firstName: 'Mona',
          lastName: 'Hassan-Ali',
          lead: true,
          keepPassportOf: kept.id,
        },
        { cabin: 0, firstName: 'Omar', lastName: 'Ali' },
      ],
    });
    const after = await getBookingDetail(w.db, w.ctx, booked.ref);
    expect(after.guests.map((g) => [g.lastName, g.hasPassport])).toEqual([
      ['Hassan-Ali', true],
      ['Ali', false],
    ]);
    const audit = await owner().query<{ diff: unknown }>(
      `select diff from vs.audit_log where entity_id = $1 and action = 'guests.replaced' order by created_at desc limit 1`,
      [booked.bookingId],
    );
    expect(JSON.stringify(audit.rows[0]!.diff)).not.toContain('P1234567');
  });

  it('dates the deposit on the Cairo calendar day, not the UTC one', async () => {
    const sailingId = await w.sailing('LXR-4', 49);
    const booked = await staffBook(w.db, w.ctx, {
      channelId: w.channels.backOffice,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: 'phone-booking-0004',
    });
    // 23:30 UTC on 1 March is 01:30 on 2 March in Cairo.
    await owner().query(
      `update vs.booking set created_at = '2026-03-01 23:30:00+00' where id = $1`,
      [booked.bookingId],
    );
    const detail = await getBookingDetail(w.db, w.ctx, booked.ref);
    expect(detail.paymentsDue.find((p) => p.kind === 'deposit')?.dueDate).toBe('2026-03-02');
  });

  it('files a request on an on-request contract', async () => {
    const sailingId = await w.sailing('LXR-7', 28);
    const result = await staffBook(w.db, w.ctx, {
      channelId: w.agents.onRequest,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: 'phone-booking-0002',
    });
    expect(result.status).toBe('requested');
  });
});
