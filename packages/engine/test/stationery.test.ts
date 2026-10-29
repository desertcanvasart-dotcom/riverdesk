import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import {
  autoAssignCabins,
  boardingPassData,
  excursionData,
  getOperationsSettings,
  guideLanguage,
  housekeepingData,
  requestDocument,
  staffBook,
  transferVoucherData,
  updatePortGuide,
  updateVesselDay,
} from '../src/index';
import { bookingWorld, type BookingWorld } from './helpers/booking-world';

const codeOf = async (promise: Promise<unknown>): Promise<ErrorCode | 'ok'> =>
  promise.then(
    () => 'ok' as const,
    (e: unknown) => (isDomainError(e) ? e.code : Promise.reject(e)),
  );

describe('documents D4: the remaining stationery', () => {
  let w: BookingWorld;
  let n = 0;
  let bookingId: string;
  let ref: string;
  let legId: string;
  let embark: string;
  let disembark: string;

  beforeAll(async () => {
    w = await bookingWorld();
    const sailingId = await w.sailing('LXR-4', 35);
    const booked = await staffBook(w.db, w.ctx, {
      channelId: w.agents.credit,
      sailingId,
      market: 'international',
      cabins: [
        { categoryId: w.demo.categories.STD, adults: 2 },
        { categoryId: w.demo.categories.STD, adults: 1 },
      ],
      guests: [
        {
          cabin: 0,
          lead: true,
          firstName: 'Klaus',
          lastName: 'Meyer',
          nationality: 'DE',
          arrivalFlight: 'LH 582',
          arrivalDate: undefined,
          departureFlight: 'LH 583',
          departureTime: '14:10',
        },
        { cabin: 0, firstName: 'Ute', lastName: 'Meyer', nationality: 'DE', language: 'en' },
        {
          cabin: 1,
          firstName: 'Jean',
          lastName: 'Martin',
          nationality: 'FR',
          arrivalFlight: 'LH 582',
        },
      ] as never,
      requestKey: `stationery-${++n}`,
    });
    bookingId = booked.bookingId;
    ref = booked.ref;
    const { rows } = await owner().query<{
      id: string;
      depart: string;
      arrive: string;
      disembark: string;
    }>(
      `select l.id, l.depart_date::text as depart, l.arrive_date::text as arrive, s.disembark_date::text as disembark
       from vs.leg l join vs.sailing s on s.embark_date = l.depart_date and s.embark_port_id = l.from_port_id
       where s.id = $1 and l.vessel_id = s.vessel_id`,
      [sailingId],
    );
    legId = rows[0]!.id;
    embark = rows[0]!.depart;
    disembark = rows[0]!.disembark;
    await autoAssignCabins(w.db, w.ctx, { vesselId: w.demo.vesselId, legIds: [legId] });
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('reads a guide language from the guest, else from nationality, else English', () => {
    expect(guideLanguage({ language: 'it', nationality: 'DE' })).toBe('it');
    expect(guideLanguage({ language: null, nationality: 'DE' })).toBe('de');
    expect(guideLanguage({ language: null, nationality: 'BR' })).toBe('pt');
    expect(guideLanguage({ language: null, nationality: null })).toBe('en');
  });

  it('puts guests on one flight together on the transfer voucher', async () => {
    const d = await transferVoucherData(w.db, w.ctx, bookingId);
    expect(d.transferGuests.map((g) => g.name)).toEqual([
      'Klaus Meyer',
      'Ute Meyer',
      'Jean Martin',
    ]);
    expect(d.transferGuests[0]!.arrival.flight).toBe('LH 582');
    expect(d.transferGuests[0]!.departure).toMatchObject({ flight: 'LH 583', time: '14:10' });
    expect(d.embark.date).toBe(embark);
  });

  it('makes one boarding pass per cabin, with a code that names no one', async () => {
    const d = await boardingPassData(w.db, w.ctx, bookingId);
    expect(d.passes.map((p) => p.code)).toEqual([`RD:${ref}:1`, `RD:${ref}:2`]);
    expect(d.passes[0]!.guests).toEqual(['Klaus Meyer', 'Ute Meyer']);
    expect(d.passes.every((p) => p.cabin !== null)).toBe(true);
  });

  it('groups guests by language for each visit of the departure', async () => {
    const luxor = (await getOperationsSettings(w.db, w.ctx)).ports.find((p) => p.code === 'EDF')!;
    await updatePortGuide(w.db, w.ctx, { portId: luxor.id, visitsEn: 'Temple of Horus' });
    const d = await excursionData(w.db, w.ctx, legId);
    expect(d.visits.map((v) => v.en)).toEqual(['Temple of Horus']);
    expect(d.groups.map((g) => [g.language, g.guests.length])).toEqual([
      ['de', 1],
      ['en', 1],
      ['fr', 1],
    ]);
  });

  it('keeps muster stations per deck and the table size on the vessel', async () => {
    const before = (await getOperationsSettings(w.db, w.ctx)).vessels[0]!;
    expect(before.decks.length).toBeGreaterThan(0);
    const deck = before.decks[0]!;
    const after = await updateVesselDay(w.db, w.ctx, {
      vesselId: w.demo.vesselId,
      musterStations: { [deck]: 'Station A — aft lounge', Nowhere: '' },
      tableSize: 6,
    });
    expect(after).toMatchObject({
      musterStations: { [deck]: 'Station A — aft lounge' },
      tableSize: 6,
    });
    expect(
      await codeOf(updateVesselDay(w.db, w.ctx, { vesselId: w.demo.vesselId, tableSize: 20 })),
    ).toBe('VALIDATION_FAILED');
  });

  it('tells housekeeping who arrives, stays, leaves, and what is empty', async () => {
    const arrival = await housekeepingData(w.db, w.ctx, w.demo.vesselId, embark);
    const theirs = arrival.cabins.filter((c) => c.status === 'arriving');
    expect(theirs.map((c) => c.guests).sort()).toEqual([1, 2]);
    expect(arrival.totals.vacant).toBe(
      arrival.cabins.length -
        arrival.totals.arriving -
        arrival.totals.stayover -
        arrival.totals.turnover,
    );
    const leaving = await housekeepingData(w.db, w.ctx, w.demo.vesselId, disembark);
    expect(
      leaving.cabins.filter((c) => c.status === 'departing' || c.status === 'turnover'),
    ).toHaveLength(2);
    expect(leaving.cabins.find((c) => c.status === 'departing')?.guests ?? 0).toBe(0);
  });

  it('queues the new documents', async () => {
    for (const kind of ['transfer_voucher', 'boarding_pass'] as const)
      expect(await requestDocument(w.db, w.ctx, { kind, bookingId, locale: 'en' })).toHaveProperty(
        'documentId',
      );
    for (const kind of [
      'luggage_tags',
      'excursion_list',
      'table_plan',
      'muster_list',
      'feedback_forms',
    ] as const)
      expect(await requestDocument(w.db, w.ctx, { kind, legId, locale: 'both' })).toHaveProperty(
        'documentId',
      );
    expect(
      await requestDocument(w.db, w.ctx, {
        kind: 'housekeeping_sheet',
        vesselId: w.demo.vesselId,
        date: embark,
        locale: 'ar',
      }),
    ).toHaveProperty('documentId');
  });
});
