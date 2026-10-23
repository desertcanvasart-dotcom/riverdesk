/** Calendar arithmetic on 'YYYY-MM-DD' strings (UTC-based, so no time zone shifts). */
export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today in Cairo, for default date ranges (the server decides anything that matters). */
export function cairoTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
}

/** "4, 8" → [4, 8]; ignores blanks, null when something is not an age. */
export function parseAges(text: string): number[] | null {
  const parts = text.split(/[,،\s]+/).filter(Boolean);
  const ages = parts.map((p) =>
    Number(p.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))),
  );
  return ages.every((a) => Number.isInteger(a) && a >= 0 && a <= 17) ? ages : null;
}
