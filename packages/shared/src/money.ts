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

/** Minor units per currency. Every currency the system prices in must be listed. */
const MINOR_UNITS: Record<string, number> = { USD: 2, EUR: 2, EGP: 2, GBP: 2 };

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
