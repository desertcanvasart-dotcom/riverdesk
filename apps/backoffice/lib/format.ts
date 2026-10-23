/**
 * Locale-aware formatting. Money arrives as integer minor units and is formatted from a decimal
 * string (Intl accepts exact decimal strings), so no float ever touches an amount.
 */
const tag = (locale: string) => (locale === 'ar' ? 'ar-EG' : 'en-GB');

export function formatMoney(
  amount: bigint | number | string,
  currency: string,
  locale: string,
): string {
  const minor = BigInt(amount);
  const negative = minor < 0n;
  const abs = (negative ? -minor : minor).toString().padStart(3, '0');
  const decimal = `${negative ? '-' : ''}${abs.slice(0, -2)}.${abs.slice(-2)}`;
  return new Intl.NumberFormat(tag(locale), {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(decimal as unknown as number);
}

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(tag(locale)).format(value);
}

/** A Cairo calendar date 'YYYY-MM-DD'. */
export function formatDate(
  date: string,
  locale: string,
  style: 'short' | 'long' = 'short',
): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(tag(locale), {
    timeZone: 'UTC',
    weekday: style === 'long' ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: style === 'long' ? 'numeric' : undefined,
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatDateTime(value: Date | string, locale: string): string {
  return new Intl.DateTimeFormat(tag(locale), {
    timeZone: 'Africa/Cairo',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function hoursLeft(value: Date | string): number {
  return Math.max(0, Math.round((new Date(value).getTime() - Date.now()) / 360_000) / 10);
}
