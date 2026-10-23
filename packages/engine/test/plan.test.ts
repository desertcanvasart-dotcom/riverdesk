import { describe, expect, it } from 'vitest';
import { businessDate as d, type BusinessDate } from '@vs/shared';
import { chainLegs, cycleStarts, overlapsRange, planLegs, type ChainLeg } from '../src/index';

// Demo cycle: Luxor day 0 → Aswan day 4 → Luxor day 7 (boarding stops only).
const stops = [
  { seq: 0, portId: 'LXR', dayOffset: 0, boarding: true },
  { seq: 1, portId: 'ESN', dayOffset: 0, boarding: false },
  { seq: 4, portId: 'ASW', dayOffset: 4, boarding: true },
  { seq: 8, portId: 'LXR', dayOffset: 7, boarding: true },
];

function plan(
  validFrom: string,
  until: string,
  today = validFrom,
  dryDocks: { from: BusinessDate; to: BusinessDate }[] = [],
) {
  return planLegs({
    stops,
    validFrom: d(validFrom),
    validTo: null,
    cycleDays: 7,
    today: d(today),
    until: d(until),
    dryDocks,
  });
}

describe('planLegs', () => {
  it('makes leg A (Mon, 4 nights) and leg B (Fri, 3 nights) per week, skipping non-boarding stops', () => {
    const legs = plan('2026-11-02', '2026-11-08');
    expect(
      legs.map((leg) => [leg.fromPortId, leg.toPortId, leg.departDate, leg.arriveDate]),
    ).toEqual([
      ['LXR', 'ASW', '2026-11-02', '2026-11-06'],
      ['ASW', 'LXR', '2026-11-06', '2026-11-09'],
    ]);
  });

  it('gets dates right across month and year ends', () => {
    const legs = plan('2026-12-21', '2027-01-10');
    expect(legs.map((leg) => `${leg.departDate}→${leg.arriveDate}`)).toEqual([
      '2026-12-21→2026-12-25',
      '2026-12-25→2026-12-28',
      '2026-12-28→2027-01-01', // leg A crosses the year end
      '2027-01-01→2027-01-04',
      '2027-01-04→2027-01-08',
      '2027-01-08→2027-01-11',
    ]);
    const feb = plan('2028-02-28', '2028-03-06'); // 2028 is a leap year
    expect(feb.map((leg) => `${leg.departDate}→${leg.arriveDate}`)).toEqual([
      '2028-02-28→2028-03-03',
      '2028-03-03→2028-03-06',
      '2028-03-06→2028-03-10',
    ]);
  });

  it('keeps only legs departing between today and until', () => {
    const legs = plan('2026-11-02', '2026-11-20', '2026-11-05');
    expect(legs[0]!.departDate).toBe('2026-11-06');
    expect(legs.at(-1)!.departDate).toBe('2026-11-20');
  });

  it('skips legs that overlap a dry-dock range', () => {
    const legs = plan('2026-11-02', '2026-11-30', '2026-11-02', [
      { from: d('2026-11-10'), to: d('2026-11-12') },
    ]);
    const departures = legs.map((leg) => leg.departDate);
    expect(departures).not.toContain('2026-11-09'); // A 9→13 overlaps
    expect(departures).toContain('2026-11-13'); // B 13→16 is clear
    expect(
      overlapsRange(d('2026-11-06'), d('2026-11-10'), {
        from: d('2026-11-10'),
        to: d('2026-11-12'),
      }),
    ).toBe(false);
  });

  it('respects valid_to', () => {
    expect(cycleStarts(d('2026-11-02'), d('2026-11-16'), 7, d('2027-01-01'))).toEqual([
      '2026-11-02',
      '2026-11-09',
      '2026-11-16',
    ]);
  });
});

describe('chainLegs', () => {
  const legs = new Map<string, ChainLeg>();
  for (const start of ['2026-11-02', '2026-11-09'] as BusinessDate[]) {
    legs.set(`${start}|0`, {
      id: `A ${start}`,
      cycleStart: start,
      fromSeq: 0,
      toSeq: 4,
      status: 'open',
    });
    legs.set(`${start}|4`, {
      id: `B ${start}`,
      cycleStart: start,
      fromSeq: 4,
      toSeq: 8,
      status: 'open',
    });
  }
  const chain = (
    embarkSeq: number,
    disembarkSeq: number,
    cycleOffset: number,
    cycleStart = '2026-11-02',
  ) =>
    chainLegs({
      cycleStart: d(cycleStart),
      cycleDays: 7,
      lastSeq: 8,
      embarkSeq,
      disembarkSeq,
      cycleOffset,
      legs,
    })?.map((leg) => leg.id) ?? null;

  it('builds 4 and 7 nights from Luxor, 3 nights from Aswan', () => {
    expect(chain(0, 4, 0)).toEqual(['A 2026-11-02']);
    expect(chain(0, 8, 0)).toEqual(['A 2026-11-02', 'B 2026-11-02']);
    expect(chain(4, 8, 0)).toEqual(['B 2026-11-02']);
  });

  it("builds 7 nights from Aswan as leg B plus the next week's leg A", () => {
    expect(chain(4, 4, 1)).toEqual(['B 2026-11-02', 'A 2026-11-09']);
  });

  it('returns null when a leg is missing or not open', () => {
    expect(chain(4, 4, 1, '2026-11-09')).toBeNull(); // the week after is not generated
    legs.set('2026-11-09|0', { ...legs.get('2026-11-09|0')!, status: 'cancelled' });
    expect(chain(4, 4, 1)).toBeNull();
  });
});
