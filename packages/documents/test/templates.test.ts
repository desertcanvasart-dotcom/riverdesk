import { describe, expect, it } from 'vitest';
import type { DocumentBrand } from '@vs/engine';
import { brandPalette } from '@vs/shared/color';
import {
  bookingDocumentHtml,
  loc,
  locList,
  sampleBooking,
  textTranslator,
  translator,
} from '../src/index';

const brand = (over: Partial<DocumentBrand> = {}): DocumentBrand => ({
  name: 'Nile <Star> Cruises',
  logo: null,
  primary: '#7a1e3a',
  secondary: '#ffd54f',
  contact: {
    phone: '+20 95 123 4567',
    whatsapp: null,
    email: 'res@example.test',
    website: 'https://example.test',
    address: { ar: 'الأقصر', en: 'Luxor' },
  },
  ...over,
});

describe('bilingual wording', () => {
  it('stacks Arabic and English labels in a bilingual document', () => {
    expect(translator('ar')('cabin')).toBe('الكابينة');
    expect(translator('en')('cabin')).toBe('Cabin');
    expect(translator('both')('cabin')).toBe(
      '<span class="bi">الكابينة<span class="en" dir="ltr">Cabin</span></span>',
    );
    expect(textTranslator('both')('cabin')).toBe('الكابينة / Cabin');
  });

  it('escapes data and falls back to the other language when one is missing', () => {
    expect(loc({ ar: '', en: '<Luxor>' }, 'ar')).toBe('&lt;Luxor&gt;');
    expect(loc({ ar: 'الأقصر', en: 'Luxor' }, 'both')).toContain('class="en"');
    expect(loc({ ar: 'X', en: 'X' }, 'both')).toBe('X');
    expect(locList({ ar: ['أ', 'ب'], en: ['A'] }, 'both')).toEqual([
      '<span class="bi">أ<span class="en" dir="ltr">A</span></span>',
      'ب',
    ]);
  });
});

describe('branded documents', () => {
  const d = sampleBooking('Nile <Star> Cruises');

  it('prints the brand colours (made readable), escaped name and contact block', () => {
    const html = bookingDocumentHtml('voucher', d, 'en', false, brand());
    const c = brandPalette('#7a1e3a', '#ffd54f');
    expect(html).toContain(`--brand: ${c.primary}`);
    expect(html).toContain(`--accent-text: ${c.secondaryText}`);
    expect(c.secondaryText).not.toBe('#ffd54f'); // pale yellow is darkened for text
    expect(html).toContain('Nile &lt;Star&gt; Cruises');
    expect(html).not.toContain('<Star>');
    expect(html).toContain('res@example.test');
    expect(html).toContain('example.test</bdi>');
    expect(html).not.toContain('<img');
  });

  it('embeds the logo only as a data: URL', () => {
    const logo = 'data:image/png;base64,iVBORw0KGgo=';
    const html = bookingDocumentHtml('voucher', d, 'ar', false, brand({ logo }));
    expect(html).toContain(`<img class="logo" src="${logo}"`);
    expect(html).toMatch(/<html lang="ar" dir="rtl">/);
  });

  it('writes a bilingual document right-to-left with both languages', () => {
    const html = bookingDocumentHtml('voucher', d, 'both', false, brand());
    expect(html).toMatch(/<html lang="ar" dir="rtl">/);
    expect(html).toContain('<title>قسيمة الحجز / Voucher</title>');
    expect(html).toContain('Guided visits as per itinerary');
    expect(html).toContain('زيارات بصحبة مرشد حسب البرنامج');
  });

  it('keeps a one-language voucher note off the other language', () => {
    const noted = { ...d, operator: { ...d.operator, voucherNote: { ar: 'ملاحظة', en: '' } } };
    expect(bookingDocumentHtml('voucher', noted, 'ar', false, brand())).toContain('ملاحظة');
    expect(bookingDocumentHtml('voucher', noted, 'en', false, brand())).not.toContain('ملاحظة');
    expect(bookingDocumentHtml('voucher', noted, 'both', false, brand())).toContain('ملاحظة');
  });

  it('leaves prices out of the agency copy', () => {
    const html = bookingDocumentHtml('voucher', d, 'en', true, brand());
    expect(html).not.toContain('US$1,680.00');
    expect(bookingDocumentHtml('voucher', d, 'en', false, brand())).toContain('US$1,680.00');
  });
});
