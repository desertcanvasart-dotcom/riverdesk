import { describe, expect, it } from 'vitest';
import {
  add,
  convert,
  convertBack,
  decimalToMinor,
  decimalsOf,
  formatMinor,
  minorToDecimal,
  money,
  mulDivHalfUp,
  multiply,
  percentOf,
  sum,
} from '../src/money';

describe('money', () => {
  it('stores integer minor units as bigint', () => {
    expect(money(12_345, 'USD')).toEqual({ amount: 12_345n, currency: 'USD' });
    expect(() => money(1.5, 'USD')).toThrow(RangeError);
    expect(() => money(1, 'usd')).toThrow();
    expect(() => money(1, 'JPY')).toThrow();
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(1, 'USD'), money(1, 'EUR'))).toThrow('Currency mismatch');
  });

  it('sums and multiplies', () => {
    expect(sum([money(100, 'EGP'), money(250, 'EGP')], 'EGP').amount).toBe(350n);
    expect(multiply(money(19_900, 'USD'), 7).amount).toBe(139_300n);
  });

  it('rounds half-up once', () => {
    expect(mulDivHalfUp(5n, 1n, 2n)).toBe(3n); // 2.5 → 3
    expect(mulDivHalfUp(7n, 1n, 3n)).toBe(2n); // 2.33 → 2
    expect(mulDivHalfUp(-5n, 1n, 2n)).toBe(-3n); // symmetric for refunds
    expect(percentOf(money(12_345, 'USD'), 2500).amount).toBe(3_086n); // 3086.25 → 3086
    expect(percentOf(money(10_001, 'USD'), 5000).amount).toBe(5_001n); // 5000.5 → 5001
  });

  it('converts with a decimal-string rate and no floats', () => {
    // 100.00 USD at 0.9215 EUR per USD = 92.15 EUR
    expect(convert(money(10_000, 'USD'), '0.9215', 'EUR')).toEqual({
      amount: 9_215n,
      currency: 'EUR',
    });
    // 33.33 EUR at 1.0851 = 36.166... → 36.17 USD
    expect(convert(money(3_333, 'EUR'), '1.0851', 'USD').amount).toBe(3_617n);
    expect(() => convert(money(1, 'USD'), '-1', 'EUR')).toThrow();
  });

  it('converts back: how much of one currency makes an amount of another', () => {
    // 5025.00 EGP at 50.25 EGP per USD = 100.00 USD
    expect(convertBack(money(502_500, 'EGP'), '50.25', 'USD')).toEqual({
      amount: 10_000n,
      currency: 'USD',
    });
    // 36.17 USD at 1.0851 USD per EUR = 33.333... → 33.33 EUR
    expect(convertBack(money(3_617, 'USD'), '1.0851', 'EUR').amount).toBe(3_333n);
    // 1.250 KWD at 3.25 USD per KWD: 4.06 USD back to KWD = 1.249... → 1.249 KWD
    expect(convertBack(money(406, 'USD'), '3.25', 'KWD').amount).toBe(1_249n);
    expect(() => convertBack(money(1, 'USD'), '0', 'EUR')).toThrow();
  });

  it('formats for logs and debugging', () => {
    expect(formatMinor(money(5, 'EGP'))).toBe('0.05 EGP');
    expect(formatMinor(money(-123_456, 'USD'))).toBe('-1234.56 USD');
  });

  it('knows 3-decimal currencies and converts decimal text both ways', () => {
    expect(decimalsOf('KWD')).toBe(3);
    expect(decimalsOf('SAR')).toBe(2);
    expect(minorToDecimal(1250n, 'KWD')).toBe('1.250');
    expect(minorToDecimal(5n, 'BHD')).toBe('0.005');
    expect(minorToDecimal(58550n, 'USD')).toBe('585.50');
    expect(minorToDecimal(-150n, 'EUR')).toBe('-1.50');
    expect(decimalToMinor('1.25', 'KWD')).toBe(1250n);
    expect(decimalToMinor('12', 'OMR')).toBe(12000n);
    expect(decimalToMinor('1.255', 'USD')).toBeNull();
    expect(decimalToMinor('0.125', 'KWD')).toBe(125n);
    expect(money(1250n, 'QAR').currency).toBe('QAR');
  });
});
