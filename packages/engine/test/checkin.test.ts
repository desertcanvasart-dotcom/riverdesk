import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError } from '@vs/contracts';
import {
  checkinDepartures,
  departureCheckin,
  erasePassports,
  exportGuestData,
  finishCheckinPack,
  inviteStaff,
  pendingCheckinPacks,
  requestCheckinPack,
  setCheckin,
  staffBook,
  updateStaff,
  upsertGuests,
  updateVesselCheckin,
} from '../src/index';
import { bookingWorld, legsOf, type BookingWorld } from './helpers/booking-world';

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (e: unknown) => (isDomainError(e) ? e.code : Promise.reject(e)),
  );

// Invitations are unique across companies: each run uses its own addresses.
const run = crypto.randomUUID().slice(0, 8);

describe('check-in (Batch D2)', () => {
  let w: BookingWorld;
  let legId: string;
  let booked: { bookingId: string; ref: string };
  const office = { vesselId: null };

  beforeAll(async () => {
    w = await bookingWorld();
    const sailingId = await w.sailing('LXR-4', 21);
    legId = (await legsOf(sailingId))[0]!;
    // A platform booking (the platform collected the money) is confirmed at once.
    booked = await staffBook(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: [
        {
          cabin: 0,
          firstName: 'Sara',
          lastName: 'Ahmed',
          lead: true,
          nationality: 'GB',
          passportNumber: 'P1234567',
          passportCountry: 'GB',
          // Expires a month after the cruise: within six months.
          passportExpiresOn: '2099-01-01',
          visaType: 'e_visa',
          visaNumber: 'EV-998877',
          dietary: ['vegetarian', 'gluten_free'],
          medicalNotes: 'Uses a wheelchair on stairs',
          occasion: 'honeymoon',
          arrivalFlight: 'MS 777',
        },
        { cabin: 0, firstName: 'Omar', lastName: 'Ahmed', lead: false, nationality: 'GB' },
      ],
      requestKey: 'checkin-booking-1',
    });
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  const partyOf = async (options: { withSensitive?: boolean; withMoney?: boolean } = {}) =>
    (await departureCheckin(w.db, w.ctx, legId, { ...office, ...options })).parties.find(
      (p) => p.ref === booked.ref,
    )!;

  it('lists who boards with their details; numbers and medical notes only when asked', async () => {
    const party = await partyOf({ withMoney: true });
    const sara = party.guests.find((g) => g.firstName === 'Sara')!;
    expect(sara).toMatchObject({
      nationality: 'GB',
      visaType: 'e_visa',
      dietary: ['vegetarian', 'gluten_free'],
      occasion: 'honeymoon',
      arrivalFlight: 'MS 777',
      hasPassport: true,
      hasMedicalNotes: true,
      warnings: [],
    });
    expect(sara).not.toHaveProperty('passportNumber');
    expect(sara).not.toHaveProperty('medicalNotes');
    expect(party.balance?.amount).toBeGreaterThan(0n);
    // Omar has no passport number yet: reception is told.
    expect(party.guests.find((g) => g.firstName === 'Omar')!.warnings).toEqual(['no_passport']);

    const full = (await partyOf({ withSensitive: true })).guests.find(
      (g) => g.firstName === 'Sara',
    )!;
    expect(full).toMatchObject({
      passportNumber: 'P1234567',
      visaNumber: 'EV-998877',
      medicalNotes: 'Uses a wheelchair on stairs',
    });
    expect((await partyOf()).balance).toBeUndefined();
  });

  it('flags a passport that expires within six months of the end of the cruise', async () => {
    await owner().query(
      `update vs.guest set passport_expires_on = (select s.disembark_date + 30 from vs.sailing s
         join vs.booking b on b.sailing_id = s.id where b.id = $1)
       where booking_id = $1 and first_name = 'Sara'`,
      [booked.bookingId],
    );
    const sara = (await partyOf()).guests.find((g) => g.firstName === 'Sara')!;
    expect(sara.warnings).toEqual(['passport_expiring']);
  });

  it('keeps visa numbers and medical notes when the guest list is saved again', async () => {
    const { rows } = await owner().query<{ id: string }>(
      `select id from vs.guest where booking_id = $1 and first_name = 'Sara'`,
      [booked.bookingId],
    );
    await upsertGuests(w.db, w.ctx, {
      bookingId: booked.bookingId,
      requestKey: 'checkin-guests-resave',
      guests: [
        {
          cabin: 0,
          firstName: 'Sara',
          lastName: 'Ahmed',
          lead: true,
          nationality: 'GB',
          keepPassportOf: rows[0]!.id,
        },
        { cabin: 0, firstName: 'Omar', lastName: 'Ahmed', lead: false },
      ],
    });
    const sara = (await partyOf({ withSensitive: true })).guests.find(
      (g) => g.firstName === 'Sara',
    )!;
    expect(sara).toMatchObject({
      passportNumber: 'P1234567',
      visaNumber: 'EV-998877',
      medicalNotes: 'Uses a wheelchair on stairs',
    });
  });

  it('ticks the reception boxes and checks a cabin in; marks survive a guest edit', async () => {
    const party = await partyOf();
    await setCheckin(
      w.db,
      w.ctx,
      { legId, bookingCabinId: party.bookingCabinId, passportsSeen: true },
      office,
    );
    let now = await partyOf();
    expect(now.checkin).toMatchObject({
      passportsSeen: true,
      cardsSigned: false,
      checkedInAt: null,
    });
    await setCheckin(
      w.db,
      w.ctx,
      {
        legId,
        bookingCabinId: party.bookingCabinId,
        cardsSigned: true,
        keyHanded: true,
        checkedIn: true,
      },
      office,
    );
    now = await partyOf();
    expect(now.checkin.checkedInAt).toBeInstanceOf(Date);
    const listed = await checkinDepartures(
      w.db,
      w.ctx,
      { from: (await departureCheckin(w.db, w.ctx, legId, office)).leg.departDate, days: 1 },
      office,
    );
    expect(listed.departures.find((d) => d.legId === legId)).toMatchObject({ checkedIn: 1 });

    await setCheckin(
      w.db,
      w.ctx,
      { legId, bookingCabinId: party.bookingCabinId, checkedIn: false },
      office,
    );
    expect((await partyOf()).checkin).toMatchObject({ passportsSeen: true, checkedInAt: null });

    const { rows } = await owner().query(
      `select diff from vs.audit_log where action = 'checkin.updated' and entity_id = $1`,
      [party.bookingCabinId],
    );
    expect(rows).toHaveLength(3);
  });

  it('limits an on-board login to its own vessel', async () => {
    const other = { vesselId: '00000000-0000-7000-8000-000000000000' };
    expect(await codeOf(departureCheckin(w.db, w.ctx, legId, other))).toBe('NOT_FOUND');
    const party = await partyOf();
    expect(
      await codeOf(
        setCheckin(
          w.db,
          w.ctx,
          { legId, bookingCabinId: party.bookingCabinId, keyHanded: true },
          other,
        ),
      ),
    ).toBe('NOT_FOUND');
    expect((await checkinDepartures(w.db, w.ctx, { days: 31 }, other)).departures).toEqual([]);
    const own = { vesselId: w.demo.vesselId };
    expect((await departureCheckin(w.db, w.ctx, legId, own)).leg.id).toBe(legId);
  });

  it('invites on-board staff only with a vessel, and keeps the vessel with the role', async () => {
    expect(
      await codeOf(
        inviteStaff(w.db, w.ctx, {
          email: 'deck@example.test',
          displayName: 'Deck',
          role: 'onboard',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    await inviteStaff(w.db, w.ctx, {
      email: `purser-${run}@example.test`,
      displayName: 'Purser',
      role: 'onboard',
      vesselId: w.demo.vesselId,
    });
    const { rows } = await owner().query<{ id: string }>(
      `insert into vs.staff_user (operator_id, auth_user_id, email, display_name, role)
       values ($1, gen_random_uuid(), $2, 'Res', 'reservations') returning id`,
      [w.ctx.operatorId, `res-${run}@example.test`],
    );
    const moved = await updateStaff(w.db, w.ctx, {
      staffUserId: rows[0]!.id,
      role: 'onboard',
      vesselId: w.demo.vesselId,
    });
    expect(moved).toMatchObject({ role: 'onboard', vesselId: w.demo.vesselId });
    expect(
      await updateStaff(w.db, w.ctx, { staffUserId: rows[0]!.id, role: 'reservations' }),
    ).toMatchObject({
      vesselId: null,
    });
  });

  it('sends the check-in pack by hand and on schedule, once per departure', async () => {
    expect(await codeOf(requestCheckinPack(w.db, w.ctx, legId, office))).toBe('INVALID_STATE');
    expect(
      await codeOf(
        updateVesselCheckin(w.db, w.ctx, {
          vesselId: w.demo.vesselId,
          onboardEmail: null,
          checkinPackHours: 24,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    await updateVesselCheckin(w.db, w.ctx, {
      vesselId: w.demo.vesselId,
      onboardEmail: 'Reception@Ship.test',
      checkinPackHours: 24,
    });
    const send = await requestCheckinPack(w.db, w.ctx, legId, office);
    expect(send.sentTo).toBe('reception@ship.test');
    // The departure is weeks away: no scheduled send yet, only the button press.
    let pending = await pendingCheckinPacks(w.db, w.ctx);
    expect(pending.map((p) => p.trigger)).toEqual(['button']);
    await finishCheckinPack(w.db, w.ctx, send.sendId, { sent: true });

    // Twelve hours before the departure (Cairo, 12:00 when the schedule has no time) it is
    // inside the 24-hour window: one scheduled send, created once however often the job runs.
    const { rows } = await owner().query<{ at: Date }>(
      `select ((l.depart_date + coalesce(st.depart_time, time '12:00')) at time zone 'Africa/Cairo')
                - interval '12 hours' as at
       from vs.leg l left join vs.schedule_template_stop st
         on st.template_id = l.template_id and st.seq = l.from_stop_seq
       where l.id = $1`,
      [legId],
    );
    const at = rows[0]!.at;
    await pendingCheckinPacks(w.db, w.ctx, at);
    pending = await pendingCheckinPacks(w.db, w.ctx, at);
    const scheduled = pending.filter((p) => p.legId === legId && p.trigger === 'scheduled');
    expect(scheduled).toHaveLength(1);
    await finishCheckinPack(w.db, w.ctx, scheduled[0]!.id, { sent: false, error: 'No SMTP' });
    expect(await pendingCheckinPacks(w.db, w.ctx, at)).toEqual([]);
  });

  it('erases every personal check-in detail with the passport after the cruise', async () => {
    const sailing = await owner().query<{ id: string }>(
      `select sailing_id as id from vs.booking where id = $1`,
      [booked.bookingId],
    );
    const shift = (days: number) =>
      owner().query(
        `update vs.sailing set embark_date = embark_date + $2::int, disembark_date = disembark_date + $2::int where id = $1`,
        [sailing.rows[0]!.id, days],
      );
    await shift(-400);
    try {
      expect((await erasePassports(w.db, w.ctx)).erased).toBeGreaterThanOrEqual(1);
    } finally {
      await shift(400);
    }
    const { rows } = await owner().query(
      `select first_name, nationality, passport_ciphertext, visa_ciphertext, medical_ciphertext, dietary,
              occasion, arrival_flight, passport_expires_on
       from vs.guest where booking_id = $1 and first_name = 'Sara'`,
      [booked.bookingId],
    );
    expect(rows[0]).toEqual({
      first_name: 'Sara',
      nationality: 'GB',
      passport_ciphertext: null,
      visa_ciphertext: null,
      medical_ciphertext: null,
      dietary: [],
      occasion: null,
      arrival_flight: null,
      passport_expires_on: null,
    });
    const guestId = (
      await owner().query<{ id: string }>(
        `select id from vs.guest where booking_id = $1 and first_name = 'Sara'`,
        [booked.bookingId],
      )
    ).rows[0]!.id;
    expect((await exportGuestData(w.db, w.ctx, { guestId })).guest).toMatchObject({
      visaNumber: null,
      medicalNotes: null,
    });
  });
});
