import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import {
  dailyProgrammeData,
  departureCheckin,
  getOperationsSettings,
  predepartureData,
  requestDocument,
  staffBook,
  updateGuestInfo,
  updatePortGuide,
  updateVesselDay,
} from '../src/index';
import { bookingWorld, type BookingWorld } from './helpers/booking-world';

const codeOf = async (promise: Promise<unknown>): Promise<ErrorCode | 'ok'> =>
  promise.then(
    () => 'ok' as const,
    (e: unknown) => (isDomainError(e) ? e.code : Promise.reject(e)),
  );

describe('documents D3: on-board operations', () => {
  let w: BookingWorld;
  let n = 0;
  let shortId: string;
  let longId: string;
  let legId: string;
  let embark: string;
  const book = (pattern: string, sailingId: string, guests: Record<string, unknown>[]) =>
    staffBook(w.db, w.ctx, {
      channelId: w.agents.credit,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: guests.map((g, i) => ({ cabin: 0, lead: i === 0, ...g })) as never,
      requestKey: `operations-${pattern}-${++n}`,
    });

  beforeAll(async () => {
    w = await bookingWorld();
    // Luxor → Aswan (4 nights) and Luxor → Luxor (7 nights), same Monday.
    const short = await w.sailing('LXR-4', 28);
    const long = await w.sailing('LXR-7', 28);
    shortId = (
      await book('LXR-4', short, [
        {
          firstName: 'Nadia',
          lastName: 'Farouk',
          dietary: ['vegetarian'],
          allergies: 'Peanuts',
          departureDate: undefined,
          departureFlight: 'MS 778',
          departureTime: '18:40',
        },
        { firstName: 'Omar', lastName: 'Farouk', occasion: 'birthday' },
      ])
    ).bookingId;
    longId = (
      await book('LXR-7', long, [{ firstName: 'Lena', lastName: 'Berg', dietary: ['vegan'] }])
    ).bookingId;
    const { rows } = await owner().query<{ id: string; depart: string }>(
      `select l.id, l.depart_date::text as depart from vs.leg l
       join vs.sailing s on s.embark_date = l.depart_date and s.embark_port_id = l.from_port_id
       where s.id = $1 and l.vessel_id = s.vessel_id`,
      [short],
    );
    legId = rows[0]!.id;
    embark = rows[0]!.depart;
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('keeps each vessel’s day, each port’s berth and visits, and the company’s texts', async () => {
    await updateVesselDay(w.db, w.ctx, {
      vesselId: w.demo.vesselId,
      boardingTime: '12:00',
      breakfastTime: '07:00',
      dinnerTime: '19:30',
      luggageTime: '06:30',
      checkoutTime: '08:00',
      programmeNoteEn: 'Galabeya party on the last night.',
    });
    const luxor = (await getOperationsSettings(w.db, w.ctx)).ports.find((p) => p.code === 'LXR')!;
    await updatePortGuide(w.db, w.ctx, {
      portId: luxor.id,
      berthEn: 'Corniche El Nil, opposite the Winter Palace',
      visitsEn: 'Karnak and Luxor temples',
    });
    await updateGuestInfo(w.db, w.ctx, { dressCodeEn: 'Smart casual for dinner.' });
    const settings = await getOperationsSettings(w.db, w.ctx);
    expect(settings.vessels.find((v) => v.id === w.demo.vesselId)).toMatchObject({
      boardingTime: '12:00',
      lunchTime: null,
      luggageTime: '06:30',
    });
    expect(settings.guestInfo).toMatchObject({
      dressCodeEn: 'Smart casual for dinner.',
      dressCodeAr: null,
    });
    expect(
      await codeOf(updateVesselDay(w.db, w.ctx, { vesselId: w.demo.vesselId, lunchTime: '25:00' })),
    ).toBe('VALIDATION_FAILED');
  });

  it('lists guests boarding, aboard, or leaving where a departure ends', async () => {
    const office = { vesselId: null };
    const boarding = await departureCheckin(w.db, w.ctx, legId, office);
    const aboard = await departureCheckin(w.db, w.ctx, legId, { ...office, mode: 'aboard' });
    const leaving = await departureCheckin(w.db, w.ctx, legId, { ...office, mode: 'leaving' });
    const refsOf = (d: typeof boarding) => new Set(d.parties.map((p) => p.ref));
    const [shortRef, longRef] = await Promise.all(
      [shortId, longId].map(
        async (id) =>
          (await owner().query<{ ref: string }>(`select ref from vs.booking where id = $1`, [id]))
            .rows[0]!.ref,
      ),
    );
    expect(refsOf(boarding)).toEqual(new Set([shortRef, longRef]));
    expect(refsOf(aboard)).toEqual(new Set([shortRef, longRef]));
    // Only the 4-night cruise ends in Aswan, where this departure arrives.
    expect(refsOf(leaving)).toEqual(new Set([shortRef]));
    const nadia = leaving.parties[0]!.guests.find((g) => g.firstName === 'Nadia')!;
    expect(nadia).toMatchObject({ departureFlight: 'MS 778', departureTime: '18:40' });
    expect(leaving.leg).toMatchObject({ departTime: '15:00', arriveTime: '08:00' });
  });

  it('builds a daily programme from the schedule’s stop times, visits and meals', async () => {
    const programme = await dailyProgrammeData(w.db, w.ctx, w.demo.vesselId, {
      from: embark,
      days: 3,
    });
    expect(programme.days.map((d) => d.date)).toHaveLength(3);
    const first = programme.days[0]!;
    expect(first.stops.map((s) => [s.time, s.kind, s.port.code])).toEqual([
      ['08:00', 'arrive', 'LXR'],
      ['15:00', 'depart', 'LXR'],
      ['19:00', 'arrive', 'ESN'],
      ['22:00', 'depart', 'ESN'],
    ]);
    expect(first.visits).toEqual([expect.objectContaining({ en: 'Karnak and Luxor temples' })]);
    expect(programme.days[1]!.stops.map((s) => s.port.code)).toEqual(['EDF', 'EDF']);
    expect(programme.vessel).toMatchObject({ breakfastTime: '07:00', dinnerTime: '19:30' });
  });

  it('tells the guest where and when to board, and what to bring', async () => {
    const d = await predepartureData(w.db, w.ctx, shortId);
    expect(d.embark).toMatchObject({
      date: embark,
      berthEn: 'Corniche El Nil, opposite the Winter Palace',
      boardingTime: '12:00',
      departTime: '15:00',
    });
    expect(d.disembark).toMatchObject({ arriveTime: '08:00', checkoutTime: '08:00' });
    expect(d.cruise.nights).toBe(4);
    expect(d.guests.map((g) => g.name)).toEqual(['Nadia Farouk', 'Omar Farouk']);
    // Six months after the cruise ends.
    expect(d.passportValidUntil > d.disembark.date).toBe(true);
    expect(d.texts.whatToBringEn).toBeNull();
  });

  it('queues the new documents, and keeps door cards a PDF', async () => {
    for (const kind of ['diet_list', 'occasion_list', 'disembarkation_list'] as const)
      for (const format of ['pdf', 'xlsx'] as const)
        expect(
          await requestDocument(w.db, w.ctx, { kind, legId, locale: 'en', format }),
        ).toHaveProperty('documentId');
    expect(
      await codeOf(
        requestDocument(w.db, w.ctx, { kind: 'door_cards', legId, locale: 'en', format: 'xlsx' }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await requestDocument(w.db, w.ctx, {
        kind: 'daily_programme',
        vesselId: w.demo.vesselId,
        from: embark,
        days: 7,
        locale: 'both',
      }),
    ).toHaveProperty('documentId');
    expect(
      await requestDocument(w.db, w.ctx, {
        kind: 'predeparture',
        bookingId: shortId,
        locale: 'ar',
      }),
    ).toHaveProperty('documentId');
    // An on-board login of another vessel cannot print this vessel's programme.
    expect(
      await codeOf(
        requestDocument(
          w.db,
          w.ctx,
          { kind: 'daily_programme', vesselId: w.demo.vesselId, from: embark, locale: 'en' },
          { vesselId: '01a00000-0000-7000-8000-00000000ffff' },
        ),
      ),
    ).toBe('NOT_FOUND');
  });
});
