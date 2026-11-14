import { describe, expect, it } from 'vitest';
import { parseMoney } from '../lib/format';

describe('amounts typed by staff', () => {
  it('reads a point or an Arabic decimal mark as decimals', () => {
    expect(parseMoney('585.5')).toBe(58550n);
    expect(parseMoney('٥٨٥٫٥٠')).toBe(58550n);
    expect(parseMoney(' 1200 ')).toBe(120000n);
  });

  it('reads a comma before one or two last digits as a decimal comma, never as 100 times more', () => {
    expect(parseMoney('585,50')).toBe(58550n);
    expect(parseMoney('585,5')).toBe(58550n);
    expect(parseMoney('٥٨٥,٥٠')).toBe(58550n);
  });

  it('reads commas between groups of three as thousands', () => {
    expect(parseMoney('1,234')).toBe(123400n);
    expect(parseMoney('1,234,567.89')).toBe(123456789n);
    expect(parseMoney('١٬٢٣٤٫٥٠')).toBe(123450n);
    expect(parseMoney('1,234', 'KWD')).toBe(1234000n);
  });

  it('refuses any other comma rather than dropping it', () => {
    for (const text of ['12,3456', '1,23,456', '1,234,5', ',50', '585,50.5', '1.5,00'])
      expect(parseMoney(text)).toBeNull();
  });
});
