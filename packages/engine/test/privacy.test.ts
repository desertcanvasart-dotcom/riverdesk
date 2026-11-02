import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import {
  eraseGuest,
  exportGuestData,
  getBookingDetail,
  postCharge,
  recordPayment,
  saveExtraItem,
  staffBook,
  todayInCairo,
  updateVesselFolio,
} from '../src/index';
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

  it('erasure also covers the guest billing party and folio charges; the export shows the money', async () => {
    const sailingId = await w.sailing('LXR-4', 21);
    const booked = await staffBook(w.db, w.ctx, {
      channelId: w.channels.backOffice,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: [
        { cabin: 0, firstName: 'Salma', lastName: 'Nabil', lead: true, phone: '+201001234567' },
        { cabin: 0, firstName: 'Karim', lastName: 'Nabil' },
      ],
      requestKey: 'privacy-0002',
    });
    const detail = await getBookingDetail(w.db, w.ctx, booked.ref);
    const salma = detail.guests.find((g) => g.firstName === 'Salma')!;
    await owner().query(`update vs.guest set language = 'ar' where id = $1`, [salma.id]);
    // Paying it (which confirms it) makes the booking's guest billing party, named after the lead.
    await recordPayment(w.db, w.ctx, {
      bookingId: booked.bookingId,
      method: 'cash',
      amount: booked.total,
      currency: 'USD',
      reference: 'PRIV-1',
      receivedOn: await todayInCairo(w.db),
    });
    // A charge on her cabin's folio, with her name on it.
    await updateVesselFolio(w.db, w.ctx, { vesselId: w.demo.vesselId, folioEnabled: true });
    const water = await saveExtraItem(w.db, w.ctx, {
      category: 'bar',
      nameAr: 'مياه',
      nameEn: 'Water',
      price: 300n,
      currency: 'USD',
    });
    const { rows: legs } = await owner().query<{ id: string }>(
      `select l.id from vs.leg l join vs.sailing s on s.embark_date = l.depart_date and s.embark_port_id = l.from_port_id
       where s.id = $1 and l.vessel_id = s.vessel_id`,
      [sailingId],
    );
    const cabin = await owner().query<{ booking_cabin_id: string }>(
      `select booking_cabin_id from vs.guest where id = $1`,
      [salma.id],
    );
    await postCharge(
      w.db,
      w.ctx,
      {
        legId: legs[0]!.id,
        bookingCabinId: cabin.rows[0]!.booking_cabin_id,
        itemId: water.id,
        guestName: 'Salma Nabil',
      },
      { vesselId: null },
    );

    const exported = await exportGuestData(w.db, w.ctx, { guestId: salma.id });
    expect(exported.payments).toEqual([
      expect.objectContaining({
        amount: booked.total.toString(),
        currency: 'USD',
        reference: 'PRIV-1',
      }),
    ]);
    expect(exported.folio?.charges).toEqual([
      expect.objectContaining({ description: 'Water', guestName: 'Salma Nabil' }),
    ]);

    await eraseGuest(w.db, w.ctx, { guestId: salma.id });
    const party = await owner().query<{ name: string; phone: string | null }>(
      `select p.name, p.phone from vs.billing_party p join vs.receipt r on r.billing_party_id = p.id
       where r.booking_id = $1`,
      [booked.bookingId],
    );
    expect(party.rows[0]).toEqual({ name: 'Erased guest', phone: null });
    const charge = await owner().query<{ guest_name: string | null }>(
      `select c.guest_name from vs.folio_charge c join vs.folio f on f.id = c.folio_id where f.booking_id = $1`,
      [booked.bookingId],
    );
    expect(charge.rows).toEqual([{ guest_name: null }]);
    const guest = await owner().query<{ language: string | null }>(
      `select language from vs.guest where id = $1`,
      [salma.id],
    );
    expect(guest.rows[0]!.language).toBeNull();
    const everything = await owner().query(
      `select (select json_agg(p) from vs.billing_party p where p.operator_id = $1) as parties,
              (select json_agg(c) from vs.folio_charge c where c.operator_id = $1) as charges`,
      [w.ctx.operatorId],
    );
    expect(JSON.stringify(everything.rows)).not.toMatch(/Salma|201001234567/);
  });
});
