import { decimalsOf, decimalToMinor, minorToDecimal } from '@vs/shared/money';

/**
 * Locale-aware formatting. Money arrives as integer minor units and is formatted from a decimal
 * string (Intl accepts exact decimal strings), so no float ever touches an amount.
 */
const tag = (locale: string) => (locale.startsWith('ar') ? 'ar-EG' : 'en-GB');

export function formatMoney(
  amount: bigint | number | string,
  currency: string,
  locale: string,
): string {
  const digits = decimalsOf(currency);
  return new Intl.NumberFormat(tag(locale), {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minorToDecimal(BigInt(amount), currency) as unknown as number);
}

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(tag(locale)).format(value);
}

/** A Cairo calendar date 'YYYY-MM-DD'. 'year' adds the year without the weekday (date ranges). */
export function formatDate(
  date: string,
  locale: string,
  style: 'short' | 'long' | 'year' = 'short',
): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(tag(locale), {
    timeZone: 'UTC',
    weekday: style === 'long' ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: style === 'short' ? undefined : 'numeric',
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

/**
 * "585.5" / "٥٨٥٫٥٠" → 58550n minor units of `currency` (3 decimals for KWD, BHD, OMR); null
 * when it is not an amount or has more decimals than the currency.
 */
export function parseMoney(text: string, currency = 'USD'): bigint | null {
  const western = text
    .trim()
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
    .replace(/[٫,]/g, (c) => (c === '٫' ? '.' : ''));
  return decimalToMinor(western, currency);
}

/** 58550n → "585.50" for an input field (always Latin digits, no grouping). */
export function minorToInput(amount: bigint, currency = 'USD'): string {
  return minorToDecimal(amount, currency);
}
