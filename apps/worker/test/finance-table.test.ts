import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { DocumentBrand, FinanceTable } from '@vs/engine';
import {
  financeTableBase,
  financeTableCsv,
  financeTableXlsx,
} from '../src/documents/finance-table';

const brand: DocumentBrand = {
  name: 'Nile Star',
  logo: null,
  primary: '#165a5c',
  secondary: '#c97416',
  contact: { phone: null, whatsapp: null, email: null, website: null, address: { ar: '', en: '' } },
};

const table: FinanceTable = {
  name: 'journal',
  from: '2026-10-01',
  to: '2026-10-31',
  columns: [
    { key: 'date', type: 'date' },
    { key: 'description', type: 'text' },
    { key: 'currency', type: 'text' },
    { key: 'debit', type: 'money' },
    { key: 'base_currency', type: 'text' },
    { key: 'base_debit', type: 'money' },
  ],
  rows: [
    {
      date: '2026-10-05',
      description: 'Sun, "Sea" & Co',
      currency: 'KWD',
      debit: 1_250n,
      base_currency: 'EGP',
      base_debit: 20_312_50n,
    },
    {
      date: '2026-10-06',
      description: 'شركة النيل',
      currency: 'USD',
      debit: 99n,
      base_currency: 'EGP',
      base_debit: null,
    },
  ],
  unmapped: [{ kind: 'bank', ref: null }],
};

describe('finance tables', () => {
  it('writes CSV with a BOM, quoted text and decimals in each row’s currency', () => {
    const text = financeTableCsv(table, 'en').toString('utf8');
    expect(text.startsWith('\uFEFFDate,Description,Currency,Debit,Base currency,Debit (base)\r\n')).toBe(
      true,
    );
    expect(text).toContain('2026-10-05,"Sun, ""Sea"" & Co",KWD,1.250,EGP,20312.50\r\n');
    expect(text).toContain('2026-10-06,شركة النيل,USD,0.99,EGP,\r\n');
    expect(financeTableBase(table)).toBe('finance-journal-2026-10-01-2026-10-31');
  });

  it('writes a workbook with numbers and a sheet of the codes still to set', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await financeTableXlsx(table, brand, 'en')) as unknown as ArrayBuffer,
    );
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Journal', 'Account codes not set']);
    const values: unknown[][] = [];
    workbook.worksheets[0]!.eachRow((row) => values.push((row.values as unknown[]).slice(1)));
    expect(values).toContainEqual(['2026-10-05', 'Sun, "Sea" & Co', 'KWD', 1.25, 'EGP', 20312.5]);
  });
});
