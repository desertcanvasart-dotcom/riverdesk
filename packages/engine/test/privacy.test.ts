import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { eraseGuest, exportGuestData, getBookingDetail, staffBook } from '../src/index';
import { bookingWorld, type BookingWorld } from './helpers/booking-world';

describe('data subject requests', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('exports everything held about one guest, then erases it; both audited without values', async () => {
    const booked = await staffBook(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      sailingId: await w.sailing('LXR-4', 14),
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: [
        {
          cabin: 0,
          firstName: 'Hana',
          lastName: 'Kamel',
          lead: true,
          nationality: 'EG',
          dateOfBirth: '1990-02-03',
          passportNumber: 'A24681357',
        },
        { cabin: 0, firstName: 'Omar', lastName: 'Kamel' },
      ],
      requestKey: 'privacy-0001',
    });
    const detail = await getBookingDetail(w.db, w.ctx, booked.ref);
    const hana = detail.guests.find((g) => g.firstName === 'Hana')!;

    const exported = await exportGuestData(w.db, w.ctx, { guestId: hana.id });
    expect(exported.guest).toMatchObject({
      lastName: 'Kamel',
      passportNumber: 'A24681357',
      dateOfBirth: '1990-02-03',
    });
    expect(exported.booking.ref).toBe(booked.ref);

    await eraseGuest(w.db, w.ctx, { guestId: hana.id });
    const after = await getBookingDetail(w.db, w.ctx, booked.ref);
    expect(after.guests.find((g) => g.id === hana.id)).toMatchObject({
      firstName: 'Erased',
      nationality: null,
      dateOfBirth: null,
      hasPassport: false,
    });
    expect(after.guests).toHaveLength(2);

    const audit = await owner().query<{ action: string; diff: unknown }>(
      `select action, diff from vs.audit_log where entity_id = $1 order by created_at`,
      [hana.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['guest.data_exported', 'guest.erased']);
    expect(JSON.stringify(audit.rows)).not.toMatch(/A24681357|Hana|1990-02-03/);
  });
});
