/**
 * Business dates (embarkation, release, penalty days) are calendar dates in Africa/Cairo.
 * Instants are stored as UTC timestamptz.
 *
 * Rule 4: expiry, deadline and TTL decisions use Postgres now(), never these helpers with the
 * application clock. These helpers convert between instants and Cairo dates for display,
 * pricing (ages on the embark date) and building query bounds.
 */
export const CAIRO_TZ = 'Africa/Cairo';

/** A calendar date, 'YYYY-MM-DD'. */
export type BusinessDate = string & { readonly __businessDate: unique symbol };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function businessDate(value: string): BusinessDate {
  const match = DATE_RE.exec(value);
  if (!match) throw new RangeError(`Not a date: ${value}`);
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new RangeError(`Not a date: ${value}`);
  }
  return value as BusinessDate;
}

function parts(date: BusinessDate): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

function fromUtcMidnight(ms: number): BusinessDate {
  return new Date(ms).toISOString().slice(0, 10) as BusinessDate;
}

const cairoFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAIRO_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Cairo calendar date of an instant. */
export function cairoDateOf(instant: Date): BusinessDate {
  return cairoFormatter.format(instant) as BusinessDate;
}

/**
 * The first instant of a Cairo calendar date, as UTC. Handles DST: Egypt's offset is +02:00 in
 * winter and +03:00 in summer, and on the spring change local midnight does not exist.
 */
export function cairoDayStart(date: BusinessDate): Date {
  const [y, m, d] = parts(date);
  const utcMidnight = Date.UTC(y, m - 1, d);
  for (const offsetHours of [3, 2]) {
    const candidate = utcMidnight - offsetHours * 3_600_000;
    if (
      cairoDateOf(new Date(candidate)) === date &&
      cairoDateOf(new Date(candidate - 1)) !== date
    ) {
      return new Date(candidate);
    }
  }
  // Only reachable if Cairo ever uses another offset; fall back to a minute-level search.
  for (let ms = utcMidnight - 4 * 3_600_000; ms < utcMidnight + 3_600_000; ms += 60_000) {
    if (cairoDateOf(new Date(ms)) === date) return new Date(ms);
  }
  throw new RangeError(`Cannot find the start of ${date} in ${CAIRO_TZ}`);
}

export function addDays(date: BusinessDate, days: number): BusinessDate {
  const [y, m, d] = parts(date);
  return fromUtcMidnight(Date.UTC(y, m - 1, d) + days * DAY_MS);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  const [y1, m1, d1] = parts(from);
  const [y2, m2, d2] = parts(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: BusinessDate): number {
  const [y, m, d] = parts(date);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Age in whole years on a date; a birthday on that date counts. 29 February birthdays turn on 1 March. */
export function ageOn(dateOfBirth: BusinessDate, on: BusinessDate): number {
  const [by, bm, bd] = parts(dateOfBirth);
  const [y, m, d] = parts(on);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}
