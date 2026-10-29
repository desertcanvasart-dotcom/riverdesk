import ExcelJS from 'exceljs';
import { textTranslator, type DocLocale } from '@vs/documents';
import type { DocumentBrand, FolioShiftReportData } from '@vs/engine';
import { minorToDecimal } from '@vs/shared';
import { finish, header, sheet } from './xlsx';

const MONEY = '#,##0.00';
const amount = (minor: bigint, currency: string) => Number(minorToDecimal(minor, currency));

/**
 * The purser's shift report (extras E2) as a workbook: one row per payment taken at reception,
 * then the charges by category, the voids and what is to be handed over.
 */
export function folioShiftXlsx(
  d: FolioShiftReportData,
  brand: DocumentBrand,
  locale: DocLocale,
): Promise<Buffer> {
  const t = textTranslator(locale);
  const workbook = new ExcelJS.Workbook();
  const ws = sheet(workbook, t('folio_shift_report'), locale);
  header(workbook, ws, brand, t('folio_shift_report'), `${d.vessel} · ${d.date}`, [
    { header: t('srTime'), width: 10 },
    { header: t('foCabin'), width: 10 },
    { header: t('foInvoice'), width: 18 },
    { header: t('srMethod'), width: 14 },
    { header: t('foAmount'), width: 14 },
    { header: 'CCY', width: 6 },
    { header: t('srBy'), width: 22 },
  ]);
  const time = (at: Date) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      hour: '2-digit',
      minute: '2-digit',
    }).format(at);
  for (const p of d.payments) {
    const row = ws.addRow([
      time(p.at),
      p.cabin ?? '',
      p.invoice,
      t(`fo_method_${p.method}`),
      amount(p.amount, p.currency),
      p.currency,
      p.by ?? '',
    ]);
    row.getCell(5).numFmt = MONEY;
  }
  ws.addRow([]);
  for (const x of d.takings) {
    const row = ws.addRow([
      t('srTakings'),
      '',
      '',
      t(`fo_method_${x.method}`),
      amount(x.amount, x.currency),
      x.currency,
    ]);
    row.font = { bold: true };
    row.getCell(5).numFmt = MONEY;
  }
  ws.addRow([]);
  ws.addRow([t('srCharged')]).font = { bold: true };
  for (const c of d.byCategory) {
    const row = ws.addRow([
      t(`fo_cat_${c.category}`),
      c.charges,
      '',
      '',
      amount(c.amount, d.currency),
      d.currency,
    ]);
    row.getCell(5).numFmt = MONEY;
  }
  const total = ws.addRow([t('foTotal'), '', '', '', amount(d.charged, d.currency), d.currency]);
  total.font = { bold: true };
  total.getCell(5).numFmt = MONEY;
  if (d.voids.length) {
    ws.addRow([]);
    ws.addRow([t('srVoids')]).font = { bold: true };
    for (const v of d.voids) {
      const row = ws.addRow([
        '',
        v.cabin ?? '',
        v.description,
        v.reason,
        amount(v.amount, d.currency),
        d.currency,
        v.by ?? '',
      ]);
      row.getCell(5).numFmt = MONEY;
    }
  }
  return finish(workbook);
}
