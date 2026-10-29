import { describe, expect, it } from 'vitest';
import type { DocumentBrand, FolioShiftReportData, GuestFolioData } from '@vs/engine';
import { folioShiftReportHtml, guestFolioHtml } from '../src/index';

const brand: DocumentBrand = {
  name: 'Nile Star',
  logo: null,
  primary: '#165a5c',
  secondary: '#c97416',
  contact: { phone: null, whatsapp: null, email: null, website: null, address: { ar: '', en: '' } },
};
const port = (nameEn: string, nameAr: string) => ({ nameEn, nameAr });
const folio: GuestFolioData = {
  vessel: 'MS Nile Star',
  ref: 'NS-26-00012',
  cabin: '204',
  guests: ['Klaus Meyer', 'Ute Meyer'],
  embark: { date: '2026-11-02', port: port('Luxor', 'الأقصر') },
  disembark: { date: '2026-11-06', port: port('Aswan', 'أسوان') },
  currency: 'USD',
  status: 'closed',
  billTo: 'guest',
  agency: 'Sunny Tours',
  charges: [
    {
      chargedOn: '2026-11-02',
      category: 'bar',
      descriptionAr: 'مياه معدنية',
      descriptionEn: 'Mineral water',
      guestName: 'Ute Meyer',
      quantity: 2,
      unitAmount: 300n,
      amount: 600n,
    },
    {
      chargedOn: '2026-11-03',
      category: 'spa',
      descriptionAr: 'تدليك',
      descriptionEn: 'Massage',
      guestName: null,
      quantity: 1,
      unitAmount: 4500n,
      amount: 4500n,
    },
  ],
  byCategory: { bar: 600n, spa: 4500n },
  total: 5100n,
  invoice: {
    number: 'INV-2026-00042',
    issueDate: '2026-11-06',
    subtotal: 5100n,
    taxTotal: 0n,
    total: 5100n,
    balance: 2100n,
    payments: [
      {
        receivedOn: '2026-11-06',
        method: 'card',
        amount: 3000n,
        currency: 'USD',
        invoiceAmount: 3000n,
      },
    ],
  },
};

describe('guest folio', () => {
  it('lists the charges, the invoice, what was paid and what is left', () => {
    const html = guestFolioHtml(folio, brand, 'en');
    expect(html).toContain('Guest folio');
    expect(html).toContain('Mineral water');
    expect(html).toContain('INV-2026-00042');
    expect(html).toContain('Paid · Card');
    expect(html).toContain('Balance due');
    expect(html).toContain('US$21.00');
    expect(html).not.toContain('Billed to');
  });

  it('says when the agency pays, and when the folio is still open', () => {
    const html = guestFolioHtml(
      { ...folio, billTo: 'agency', invoice: null, status: 'open' },
      brand,
      'ar',
    );
    expect(html).toContain('حساب الضيف');
    expect(html).toContain('على حساب Sunny Tours');
    expect(html).toContain('ما زال مفتوحًا');
  });
});

describe('extras shift report', () => {
  const report: FolioShiftReportData = {
    vessel: 'MS Nile Star',
    date: '2026-11-06',
    currency: 'USD',
    byCategory: [{ category: 'bar', charges: 3, amount: 1500n }],
    charged: 1500n,
    voids: [
      { cabin: '204', description: 'Local beer', amount: -600n, reason: 'Wrong cabin', by: 'Hany' },
    ],
    payments: [
      {
        cabin: '204',
        invoice: 'INV-2026-00042',
        method: 'cash',
        amount: 101850n,
        currency: 'EGP',
        by: 'Hany',
        at: new Date('2026-11-06T08:15:00Z'),
      },
    ],
    takings: [{ method: 'cash', currency: 'EGP', amount: 101850n }],
    closed: { count: 1, total: 5100n, toAgency: 0 },
    open: { count: 3, total: 9000n },
  };

  it('shows charges, voids, payments and the cash to hand over', () => {
    const html = folioShiftReportHtml(report, brand, 'en');
    expect(html).toContain('Extras shift report');
    expect(html).toContain('Wrong cabin');
    expect(html).toContain('10:15');
    expect(html).toContain('To hand over');
    expect(html).toContain('EGP');
    expect(folioShiftReportHtml(report, brand, 'both')).toContain('تقرير وردية الإضافات');
  });
});
