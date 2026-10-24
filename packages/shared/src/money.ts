import { z } from 'zod';

/**
 * Money is an integer amount of minor units plus an ISO 4217 code (rule 10).
 * There is no float anywhere: amounts are bigint, rates and percentages are decimal strings
 * or basis points.
 */
export type CurrencyCode = string & { readonly __currency: unique symbol };

export interface Money {
  readonly amount: bigint;
  readonly currency: CurrencyCode;
}

/**
 * Minor units per currency (ISO 4217). Every currency the system prices in must be listed.
 * KWD, BHD and OMR have 3 decimals (fils / baisa): 1.250 KWD is 1250 minor units.
 */
const MINOR_UNITS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  EGP: 2,
  GBP: 2,
  SAR: 2,
  AED: 2,
  QAR: 2,
  CHF: 2,
  CAD: 2,
  AUD: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
};

/** The currencies a company can price in, in the order screens offer them. */
export const CURRENCIES = Object.keys(MINOR_UNITS) as readonly string[];

/** Decimals of any currency code (2 for one this system does not know). */
export function decimalsOf(code: string): number {
  return MINOR_UNITS[code] ?? 2;
}

/** 58550n USD → "585.50"; 1250n KWD → "1.250". Latin digits, no grouping. */
export function minorToDecimal(amount: bigint, code: string): string {
  const digits = decimalsOf(code);
  const negative = amount < 0n;
  const abs = (negative ? -amount : amount).toString().padStart(digits + 1, '0');
  const whole = digits === 0 ? abs : abs.slice(0, -digits);
  const fraction = digits === 0 ? '' : `.${abs.slice(-digits)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** "585.5" USD → 58550n; "1.25" KWD → 1250n; null when it has more decimals than the currency. */
export function decimalToMinor(text: string, code: string): bigint | null {
  const digits = decimalsOf(code);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match || (match[2] ?? '').length > digits) return null;
  return (
    BigInt(match[1]!) * 10n ** BigInt(digits) + BigInt((match[2] ?? '').padEnd(digits, '0') || '0')
  );
}

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .refine((code) => code in MINOR_UNITS, 'Unsupported currency')
  .transform((code) => code as CurrencyCode);

export function currency(code: string): CurrencyCode {
  return currencySchema.parse(code);
}

export function minorUnits(code: CurrencyCode): number {
  return MINOR_UNITS[code] as number;
}

export function money(amount: bigint | number, code: string): Money {
  if (typeof amount === 'number' && !Number.isSafeInteger(amount)) {
    throw new RangeError(`Money amount must be an integer number of minor units: ${amount}`);
  }
  return { amount: BigInt(amount), currency: currency(code) };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new RangeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function negate(a: Money): Money {
  return { amount: -a.amount, currency: a.currency };
}

export function sum(items: readonly Money[], code: string): Money {
  return items.reduce((total, item) => add(total, item), money(0n, code));
}

export function multiply(a: Money, factor: bigint | number): Money {
  const f = BigInt(factor);
  return { amount: a.amount * f, currency: a.currency };
}

/** a × numerator ÷ denominator, rounded half away from zero ("half-up" for positive amounts). */
export function mulDivHalfUp(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('Denominator must be positive');
  const product = amount * numerator;
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}

/** Percentage given in basis points (2500 = 25%), rounded half-up once. */
export function percentOf(a: Money, basisPoints: bigint | number): Money {
  return { amount: mulDivHalfUp(a.amount, BigInt(basisPoints), 10_000n), currency: a.currency };
}

/** Parses a positive decimal string such as "48.6125" into an integer and a power-of-ten scale. */
export function parseDecimal(value: string): { units: bigint; scale: bigint } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new RangeError(`Not a positive decimal: ${value}`);
  const [, whole, fraction = ''] = match;
  return { units: BigInt(`${whole}${fraction}`), scale: 10n ** BigInt(fraction.length) };
}

/**
 * Converts using a rate given as a decimal string: 1 unit of `from` = `rate` units of `to`.
 * Rounded half-up once.
 */
export function convert(a: Money, rate: string, to: string): Money {
  const target = currency(to);
  const shift = minorUnits(target) - minorUnits(a.currency);
  const { units, scale } = parseDecimal(rate);
  const numerator = shift >= 0 ? units * 10n ** BigInt(shift) : units;
  const denominator = shift >= 0 ? scale : scale * 10n ** BigInt(-shift);
  return { amount: mulDivHalfUp(a.amount, numerator, denominator), currency: target };
}

export function formatMinor(a: Money): string {
  const digits = minorUnits(a.currency);
  const negative = a.amount < 0n;
  const abs = (negative ? -a.amount : a.amount).toString().padStart(digits + 1, '0');
  const whole = abs.slice(0, abs.length - digits);
  const fraction = digits > 0 ? `.${abs.slice(abs.length - digits)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction} ${a.currency}`;
}
