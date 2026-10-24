import { describe, expect, it } from 'vitest';
import { itineraryCode, leaveOptions, routeLegs } from '../lib/routes';

const week = [
  { portId: 'LXR', dayOffset: 0, boarding: true, disembarkAllowed: true },
  { portId: 'EDF', dayOffset: 2, boarding: false, disembarkAllowed: false },
  { portId: 'ASW', dayOffset: 4, boarding: true, disembarkAllowed: true },
  { portId: 'LXR', dayOffset: 7, boarding: true, disembarkAllowed: true },
];

describe('route helpers', () => {
  it('lists the departures of one cycle between boarding stops', () => {
    expect(routeLegs(week)).toEqual([
      { from: 'LXR', to: 'ASW', nights: 4 },
      { from: 'ASW', to: 'LXR', nights: 3 },
    ]);
  });

  it('offers later stops in this cycle and the next one, with nights', () => {
    expect(leaveOptions(week, 7, 0).map((o) => [o.seq, o.offset, o.nights])).toEqual([
      [2, 0, 4],
      [3, 0, 7],
    ]);
    expect(leaveOptions(week, 7, 2).map((o) => [o.seq, o.offset, o.nights])).toEqual([
      [3, 0, 3],
      [2, 1, 7],
    ]);
    expect(itineraryCode('asw', 7)).toBe('ASW-7');
  });
});
