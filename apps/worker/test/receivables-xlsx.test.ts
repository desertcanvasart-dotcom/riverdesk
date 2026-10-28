import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { AgingData, DocumentBrand, StatementData } from '@vs/engine';
import { agingXlsx, statementXlsx } from '../src/documents/receivables-xlsx';

const brand: DocumentBrand = {
  name: 'Nile Star',
  logo: null,
  primary: '#165a5c',
  secondary: '#c97416',
  contact: { phone: null, whatsapp: null, email: null, website: null, address: { ar: '', en: '' } },
};

const cells = async (buffer: Buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const values: unknown[][] = [];
  workbook.worksheets[0]!.eachRow((row) => values.push((row.values as unknown[]).slice(1)));
  return values;
};

describe('receivables workbooks', () => {
  it('writes a statement with opening, movements and closing per currency', async () => {
    const data = {
      party: {
        id: 'p',
        kind: 'agency',
        name: 'Sun Travel',
        legalNameAr: null,
        legalNameEn: null,
        address: null,
        taxRegistrationNo: null,
        email: null,
      },
      issuer: { name: 'Nile Star', etaFooter: false } as StatementData['issuer'],
      from: '2026-10-01',
      to: '2026-10-31',
      today: '2026-10-29',
      currencies: [
        {
          currency: 'USD',
          opening: 10_000n,
          rows: [
            {
              date: '2026-10-05',
              kind: 'invoice',
              id: 'a',
              reference: 'INV-1',
              debit: 5_000n,
              credit: 0n,
              balance: 15_000n,
              dueDate: null,
            },
          ],
          closing: 15_000n,
          openInvoices: 15_000n,
          unappliedCredit: 0n,
        },
      ],
    } satisfies StatementData;
    const rows = await cells(await statementXlsx(data, brand, 'en'));
    const flat = rows.map((r) => r.join('|'));
    expect(flat.some((r) => r.includes('Opening balance') && r.includes('100'))).toBe(true);
    expect(flat.some((r) => r.includes('INV-1') && r.includes('50') && r.includes('150'))).toBe(
      true,
    );
    expect(flat.some((r) => r.includes('Closing balance') && r.includes('150'))).toBe(true);
  });

  it('writes the aging with one row per party and a total per currency', async () => {
    const buckets = { current: 1_000n, d1_30: 2_000n, d31_60: 0n, d61_90: 0n, d90_plus: 500n };
    const data: AgingData = {
      asOf: '2026-10-29',
      rows: [
        {
          partyId: 'p',
          partyName: 'Sun Travel',
          partyKind: 'agency',
          currency: 'USD',
          buckets,
          total: 3_500n,
          unappliedCredit: 500n,
          net: 3_000n,
          invoices: 3,
        },
      ],
      totals: [
        {
          currency: 'USD',
          buckets,
          total: 3_500n,
          unappliedCredit: 500n,
          net: 3_000n,
          invoices: 3,
        },
      ],
    };
    const flat = (await cells(await agingXlsx(data, brand, 'en'))).map((r) => r.join('|'));
    expect(flat.some((r) => r.startsWith('Sun Travel|USD|10|20|0|0|5|35|5|30|3'))).toBe(true);
    expect(flat.some((r) => r.startsWith('All parties|USD'))).toBe(true);
  });
});
