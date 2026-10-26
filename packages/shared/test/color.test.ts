import { describe, expect, it } from 'vitest';
import { brandPalette, contrast, inkOn, mix, normalizeHex, readableOn } from '../src/color';

describe('brand colours', () => {
  it('normalises what people type', () => {
    expect(normalizeHex(' #ABC ')).toBe('#aabbcc');
    expect(normalizeHex('165A5C')).toBe('#165a5c');
    expect(normalizeHex('teal')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
  });

  it('measures contrast like WCAG', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBe(1);
  });

  it('keeps a dark colour and darkens a pale one until it reads on white', () => {
    expect(readableOn('#165a5c')).toBe('#165a5c');
    const gold = readableOn('#ffd54f');
    expect(gold).not.toBe('#ffd54f');
    expect(contrast(gold, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('picks white ink on dark fills and dark ink on light ones', () => {
    expect(inkOn('#165a5c')).toBe('#ffffff');
    expect(inkOn('#ffd54f')).toBe('#1c2430');
  });

  it('derives every shade from the two colours', () => {
    const p = brandPalette('#ffd54f', '#c58b3c');
    expect(contrast(p.primaryText, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.secondaryText, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(p.primaryTint).toBe(mix('#ffd54f', '#ffffff', 0.9));
  });
});
