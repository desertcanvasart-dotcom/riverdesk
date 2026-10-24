import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@vs/shared';
import { importBookings, parseCsv } from '../src/index';
import { bookingWorld, type BookingWorld } from './helpers/booking-world';

describe('pilot import', () => {
  let w: BookingWorld;
  let csv = '';

  beforeAll(async () => {
    w = await bookingWorld();
    const day = (offset: number) => addDays(w.M, offset);
    csv = [
      'external_ref,channel_code,vessel_code,itinerary,embark_date,market,category_code,adults,child_ages,guests,nationality,expected_total,paid_amount,paid_reference',
      '# a comment line',
      `OLD-1,,NILEDEMO,LXR-4,${day(21)},international,STD,2,,"Clarke, Emma|James Clarke",GB,1170.00,2000.00,TT-1`,
      `OLD-2,nilecrz,NILEDEMO,LXR-7,${day(21)},international,SUP,2,6,Lukas Weber|Ben Weber,DE,1.00,,`,
      `OLD-2,nilecrz,NILEDEMO,LXR-7,${day(21)},international,STD,1,,Paul Weber,DE,,,`,
      `OLD-3,nilecrz,NILEDEMO,LXR-4,${day(22)},international,STD,2,,Ana Lopez,ES,,,`,
      `OLD-4,nilecrz,NILEDEMO,LXR-4,${day(21)},international,XXL,2,,Ana Lopez,ES,,,`,
      `OLD-5,ghost,NILEDEMO,LXR-4,${day(21)},international,STD,2,,Ana Lopez,ES,,,`,
    ].join('\n');
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('dry run prices everything and books nothing', async () => {
    const results = await importBookings(w.db, w.ctx, parseCsv(csv), { dryRun: true });
    expect(results.map((r) => [r.externalRef, r.outcome])).toEqual([
      ['OLD-1', 'would_create'],
      ['OLD-2', 'would_create'],
      ['OLD-3', 'conflict'],
      ['OLD-4', 'invalid'],
      ['OLD-5', 'invalid'],
    ]);
  });

  it('imports through the engine, reports conflicts and price differences, and is re-runnable', async () => {
    const first = await importBookings(w.db, w.ctx, parseCsv(csv));
    const byRef = Object.fromEntries(first.map((r) => [r.externalRef, r]));
    // Direct booking, prepaid: the recorded payment covers the deposit, so it is confirmed.
    expect(byRef['OLD-1']).toMatchObject({ outcome: 'created', status: 'confirmed' });
    // Two cabins on one booking; the agreed total differs from today's rates.
    expect(byRef['OLD-2']).toMatchObject({ outcome: 'created', status: 'confirmed' });
    expect(byRef['OLD-2']!.warnings.join()).toMatch(/Price differs/);
    expect(byRef['OLD-3']).toMatchObject({ outcome: 'conflict' });
    expect(byRef['OLD-3']!.message).toMatch(/No LXR-4 sailing/);
    expect(byRef['OLD-4']!.message).toMatch(/Unknown category XXL/);
    expect(byRef['OLD-5']!.message).toMatch(/Unknown channel ghost/);

    const again = await importBookings(w.db, w.ctx, parseCsv(csv));
    expect(again.filter((r) => r.outcome === 'already_imported').map((r) => r.ref)).toEqual([
      byRef['OLD-1']!.ref,
      byRef['OLD-2']!.ref,
    ]);
  });

  it('refuses a file without the template columns', () => {
    expect(() => parseCsv('ref,date\n1,2')).toThrow(/Missing columns/);
  });
});
