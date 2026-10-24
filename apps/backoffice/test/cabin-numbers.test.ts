import { describe, expect, it } from 'vitest';
import { parseCabinNumbers } from '../lib/cabin-numbers';

describe('parseCabinNumbers', () => {
  it('reads single numbers and ranges, keeping prefixes and leading zeros', () => {
    expect(parseCabinNumbers('101-104, 201')).toEqual({
      numbers: ['101', '102', '103', '104', '201'],
    });
    expect(parseCabinNumbers('A01-A03 B7')).toEqual({ numbers: ['A01', 'A02', 'A03', 'B7'] });
    expect(parseCabinNumbers('٣٠١، 302'.replace('٣٠١', '301'))).toEqual({
      numbers: ['301', '302'],
    });
  });

  it('refuses empty input, bad parts, backwards ranges and repeats', () => {
    expect(parseCabinNumbers('  ')).toEqual({ error: 'empty' });
    expect(parseCabinNumbers('101-99')).toEqual({ error: 'invalid', part: '101-99' });
    expect(parseCabinNumbers('A1-B3')).toEqual({ error: 'invalid', part: 'A1-B3' });
    expect(parseCabinNumbers('10#1')).toEqual({ error: 'invalid', part: '10#1' });
    expect(parseCabinNumbers('101-103, 102')).toEqual({ error: 'repeat', part: '102' });
    expect(parseCabinNumbers('1-300')).toEqual({ error: 'invalid', part: '1-300' });
  });
});
