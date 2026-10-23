import { describe, expect, it } from 'vitest';
import {
  addDays,
  ageOn,
  businessDate,
  cairoDateOf,
  cairoDayStart,
  daysBetween,
  isoWeekday,
} from '../src/time';

const d = businessDate;

describe('Cairo business dates', () => {
  it('validates dates', () => {
    expect(() => d('2026-02-30')).toThrow();
    expect(() => d('2026-2-3')).toThrow();
    expect(d('2028-02-29')).toBe('2028-02-29');
  });

  it('maps instants to the Cairo date, not the UTC date', () => {
    // 22:30 UTC on 14 Jan is 00:30 on 15 Jan in Cairo (UTC+2 in winter)
    expect(cairoDateOf(new Date('2026-01-14T22:30:00Z'))).toBe('2026-01-15');
    // 21:30 UTC on 14 Jul is 00:30 on 15 Jul in Cairo (UTC+3 in summer)
    expect(cairoDateOf(new Date('2026-07-14T21:30:00Z'))).toBe('2026-07-15');
  });

  it('finds the start of a Cairo day across DST', () => {
    expect(cairoDayStart(d('2026-01-15')).toISOString()).toBe('2026-01-14T22:00:00.000Z');
    expect(cairoDayStart(d('2026-07-15')).toISOString()).toBe('2026-07-14T21:00:00.000Z');
    // Whatever the transition rules in the tz database, every day start must be the first
    // instant of that Cairo date.
    for (let day = d('2026-01-01'); day < '2027-01-01'; day = addDays(day, 1)) {
      const start = cairoDayStart(day);
      expect(cairoDateOf(start)).toBe(day);
      expect(cairoDateOf(new Date(start.getTime() - 1))).toBe(addDays(day, -1));
    }
  });

  it('does date arithmetic across month and year ends', () => {
    expect(addDays(d('2026-12-29'), 4)).toBe('2027-01-02');
    expect(addDays(d('2028-02-28'), 1)).toBe('2028-02-29');
    expect(daysBetween(d('2026-12-25'), d('2027-01-01'))).toBe(7);
    expect(isoWeekday(d('2026-10-26'))).toBe(1); // Monday
    expect(isoWeekday(d('2026-11-01'))).toBe(7); // Sunday
  });

  it('computes ages on the embark date', () => {
    expect(ageOn(d('2020-05-10'), d('2026-05-10'))).toBe(6); // turns 6 that day
    expect(ageOn(d('2020-05-10'), d('2026-05-09'))).toBe(5);
    expect(ageOn(d('2024-02-29'), d('2027-02-28'))).toBe(2);
    expect(ageOn(d('2024-02-29'), d('2027-03-01'))).toBe(3);
  });
});
