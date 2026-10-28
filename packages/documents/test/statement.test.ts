import { describe, expect, it } from 'vitest';
import type { DocumentBrand, StatementData } from '@vs/engine';
import { statementFileBase, statementHtml } from '../src/index';

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

const statement: StatementData = {
  party: {
    id: '01a00000-0000-7000-8000-000000000002',
    kind: 'agency',
    name: 'Sun & <Sea> Travel',
    legalNameAr: null,
    legalNameEn: 'Sun and Sea Travel LLC',
    address: null,
    taxRegistrationNo: '555-111',
    email: null,
  },
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
    bankDetailsEn: null,
    noteAr: null,
    noteEn: null,
    etaFooter: true,
  },
  from: '2026-10-01',
  to: '2026-10-31',
  today: '2026-10-29',
  currencies: [
    {
      currency: 'USD',
      opening: 50_000n,
      rows: [
        {
          date: '2026-10-05',
          kind: 'invoice',
          id: 'a',
          reference: 'INV-2026-00042',
          debit: 292_500n,
          credit: 0n,
          balance: 342_500n,
          dueDate: '2026-10-19',
        },
        {
          date: '2026-10-20',
          kind: 'receipt',
          id: 'b',
          reference: 'SWIFT <77>',
          debit: 0n,
          credit: 300_000n,
          balance: 42_500n,
          dueDate: null,
        },
      ],
      closing: 42_500n,
      openInvoices: 42_500n,
      unappliedCredit: 0n,
    },
  ],
};

describe('statement of account', () => {
  it('prints opening, movements with a running balance, and closing, escaped', () => {
    const html = statementHtml(statement, brand, 'en');
    expect(html).toContain('Statement of account');
    expect(html).toContain('Opening balance');
    expect(html).toContain('INV-2026-00042');
    expect(html).toContain('SWIFT &lt;77&gt;');
    expect(html).not.toContain('<Sea>');
    expect(html).toContain('Sun and Sea Travel LLC');
    expect(html).toContain('425.00'); // closing 425.00 USD
    expect(html).toContain('Closing balance');
  });

  it('prints in Arabic and in both languages', () => {
    expect(statementHtml(statement, brand, 'ar')).toContain('كشف حساب');
    const both = statementHtml(statement, brand, 'both');
    expect(both).toContain('كشف حساب');
    expect(both).toContain('Statement of account');
  });

  it('names the file after the party and the period', () => {
    expect(statementFileBase(statement)).toBe('statement-Sun-Sea-Travel-2026-10-01-2026-10-31');
  });

  it('says so when a period has no movements', () => {
    const empty = { ...statement, currencies: [] };
    expect(statementHtml(empty, brand, 'en')).toContain('No movements in this period.');
  });
});
