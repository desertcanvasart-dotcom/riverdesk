import { describe, expect, it } from 'vitest';
import type { DocumentBrand, InvoiceDocumentData } from '@vs/engine';
import { invoiceFileBase, invoiceHtml } from '../src/index';

const brand: DocumentBrand = {
  name: 'Nile Star',
  logo: null,
  primary: '#165a5c',
  secondary: '#c97416',
  contact: {
    phone: null,
    whatsapp: null,
    email: null,
    website: null,
    address: { ar: '', en: '' },
  },
};

const invoice = (over: Partial<InvoiceDocumentData> = {}): InvoiceDocumentData => ({
  id: '01a00000-0000-7000-8000-000000000001',
  type: 'invoice',
  status: 'issued',
  number: 'INV-2026-00042',
  bookingRefs: ['VS-26-00007'],
  issueDate: '2026-10-26',
  dueDate: '2026-11-09',
  createdAt: new Date('2026-10-26T10:00:00Z'),
  currency: 'USD',
  baseCurrency: 'EGP',
  fx: { rate: '50.25', source: 'CBE', date: '2026-10-26', baseTotal: 14_698_125n },
  issuer: {
    name: 'Nile Star',
    legalNameAr: 'نايل ستار للفنادق العائمة',
    legalNameEn: 'Nile Star Floating Hotels S.A.E.',
    addressAr: null,
    addressEn: null,
    taxRegistrationNo: '123-456-789',
    commercialRegistrationNo: null,
    phone: null,
    email: null,
    website: null,
    bankDetailsAr: null,
    bankDetailsEn: 'CIB · IBAN EG00 <0000>',
    noteAr: null,
    noteEn: null,
    etaFooter: true,
  },
  party: {
    kind: 'agency',
    name: 'Sun & <Sea> Travel',
    legalNameAr: null,
    legalNameEn: null,
    address: null,
    taxRegistrationNo: null,
    commercialRegistrationNo: null,
    email: null,
    phone: null,
    country: null,
  },
  credits: null,
  creditReason: null,
  lines: [
    {
      seq: 0,
      kind: 'cabin',
      bookingRef: 'VS-26-00007',
      description: { ar: 'كابينة سوبيريور', en: 'Superior cabin' },
      quantity: 1,
      unitAmount: 292_500n,
      amount: 292_500n,
      tax: { name: { ar: 'ضريبة', en: 'VAT' }, bps: 1400, inclusive: true },
      taxAmount: 35_921n,
    },
  ],
  taxes: [{ name: { ar: 'ضريبة', en: 'VAT' }, bps: 1400, base: 256_579n, tax: 35_921n }],
  subtotal: 256_579n,
  taxTotal: 35_921n,
  total: 292_500n,
  amountCredited: 0n,
  amountPaid: 0n,
  notes: null,
  ...over,
});

describe('invoice PDF (F2)', () => {
  it('prints the number, both parties, tax, totals, rate and the tax-authority footer', () => {
    const html = invoiceHtml(invoice(), brand, 'en');
    expect(html).toContain('INV-2026-00042');
    expect(html).toContain('Nile Star Floating Hotels S.A.E.');
    expect(html).toContain('Sun &amp; &lt;Sea&gt; Travel');
    expect(html).toContain('CIB · IBAN EG00 &lt;0000&gt;');
    expect(html).toContain('VAT 14%');
    expect(html).toContain('1 USD = 50.25 EGP');
    expect(html).toContain('not an e-invoice certified');
    expect(html).not.toContain('<Sea>');
  });

  it('writes Arabic, and both languages stacked', () => {
    expect(invoiceHtml(invoice(), brand, 'ar')).toContain('فاتورة');
    const both = invoiceHtml(invoice(), brand, 'both');
    expect(both).toContain('نايل ستار للفنادق العائمة');
    expect(both).toContain('Nile Star Floating Hotels S.A.E.');
  });

  it('marks a draft, explains a proforma, and names files by number or booking', () => {
    const draft = invoice({ status: 'draft', number: null, issueDate: null });
    expect(invoiceHtml(draft, brand, 'en')).toContain('Draft — not issued');
    expect(invoiceFileBase(draft)).toBe('draft-invoice-VS-26-00007');
    const proforma = invoice({ type: 'proforma', status: 'draft', number: null, fx: null });
    const html = invoiceHtml(proforma, brand, 'en');
    expect(html).toContain('A proforma is not a tax invoice');
    expect(html).not.toContain('Draft — not issued');
    expect(invoiceFileBase(proforma)).toBe('proforma-VS-26-00007');
    expect(invoiceFileBase(invoice())).toBe('INV-2026-00042');
  });

  it('shows what a credit note credits, and leaves the footer out when switched off', () => {
    const note = invoice({
      type: 'credit_note',
      number: 'CN-2026-00003',
      credits: { number: 'INV-2026-00042', issueDate: '2026-10-20' },
      creditReason: 'Goodwill',
      issuer: { ...invoice().issuer, etaFooter: false },
    });
    const html = invoiceHtml(note, brand, 'en');
    expect(html).toContain('Credits invoice');
    expect(html).toContain('Goodwill');
    expect(html).not.toContain('not an e-invoice certified');
  });
});
