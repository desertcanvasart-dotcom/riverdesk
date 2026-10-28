import ExcelJS from 'exceljs';
import { textTranslator, type DocLocale } from '@vs/documents';
import type { DocumentBrand, FinanceTable } from '@vs/engine';
import { minorToDecimal } from '@vs/shared';
import { finish, header, sheet } from './xlsx';

/**
 * Finance reports and accountant exports (invoicing F5): one table, as Excel or CSV. Money is in
 * each row's `currency` (or `base_currency` for base columns), written as a decimal number.
 */

const currencyOf = (key: string, row: FinanceTable['rows'][number]) =>
  String((key.startsWith('base_') ? row.base_currency : row.currency) ?? 'USD');

const decimal = (value: FinanceTable['rows'][number][string] | undefined, currency: string) =>
  value === null || value === undefined || value === ''
    ? null
    : minorToDecimal(BigInt(value as bigint), currency);

export function financeTableBase(table: FinanceTable): string {
  return ['finance', table.name, table.from, table.to].filter(Boolean).join('-');
}

export function financeTableXlsx(
  table: FinanceTable,
  brand: DocumentBrand,
  locale: DocLocale,
): Promise<Buffer> {
  const t = textTranslator(locale);
  const workbook = new ExcelJS.Workbook();
  const title = t(`fr_title_${table.name}`);
  const ws = sheet(workbook, title, locale);
  header(
    workbook,
    ws,
    brand,
    title,
    [table.from, table.to].filter(Boolean).join(' → '),
    table.columns.map((c) => ({
      header: t(`fr_${c.key}`),
      width: c.type === 'money' ? 15 : c.type === 'date' ? 13 : c.key === 'description' ? 32 : 18,
    })),
  );
  for (const row of table.rows) {
    const added = ws.addRow(
      table.columns.map((c) => {
        const value = row[c.key];
        if (c.type === 'money') {
          const d = decimal(value, currencyOf(c.key, row));
          return d === null ? '' : Number(d);
        }
        if (c.type === 'number') return value === null ? '' : Number(value);
        return value === null || value === undefined ? '' : String(value);
      }),
    );
    table.columns.forEach((c, i) => {
      if (c.type === 'money') added.getCell(i + 1).numFmt = '#,##0.00';
    });
  }
  if (table.unmapped?.length) {
    const notes = workbook.addWorksheet(t('fr_title_unmapped').slice(0, 31));
    notes.addRow([t('fr_account'), t('fr_ref')]);
    for (const u of table.unmapped) notes.addRow([u.kind, u.ref ?? '']);
  }
  return finish(workbook);
}

/** RFC 4180 CSV, UTF-8 with a byte-order mark so Excel reads Arabic; decimals with a point. */
export function financeTableCsv(table: FinanceTable, locale: DocLocale): Buffer {
  const t = textTranslator(locale === 'both' ? 'en' : locale);
  const quote = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines = [table.columns.map((c) => quote(t(`fr_${c.key}`))).join(',')];
  for (const row of table.rows)
    lines.push(
      table.columns
        .map((c) => {
          const value = row[c.key];
          if (c.type === 'money') return decimal(value, currencyOf(c.key, row)) ?? '';
          return value === null || value === undefined ? '' : quote(String(value));
        })
        .join(','),
    );
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}
