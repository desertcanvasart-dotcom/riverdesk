import ExcelJS from 'exceljs';
import { textTranslator, type DocLocale } from '@vs/documents';
import type { AgingData, DocumentBrand, StatementData } from '@vs/engine';
import { minorToDecimal } from '@vs/shared';
import { finish, header, sheet } from './xlsx';

const amount = (minor: bigint, currency: string) => Number(minorToDecimal(minor, currency));
const MONEY = '#,##0.00';

/** A party's statement as a workbook (invoicing F4): one block per currency, running balance. */
export function statementXlsx(
  d: StatementData,
  brand: DocumentBrand,
  locale: DocLocale,
): Promise<Buffer> {
  const t = textTranslator(locale);
  const workbook = new ExcelJS.Workbook();
  const ws = sheet(workbook, t('statement'), locale);
  const columns = [
    { header: t('stDate'), width: 13 },
    { header: t('stDocument'), width: 18 },
    { header: t('invNumber'), width: 22 },
    { header: 'Currency', width: 9 },
    { header: t('stDebit'), width: 14 },
    { header: t('stCredit'), width: 14 },
    { header: t('stBalance'), width: 14 },
  ];
  header(
    workbook,
    ws,
    brand,
    `${t('statement')} · ${d.party.legalNameEn || d.party.name}`,
    `${d.from} → ${d.to}`,
    columns,
  );
  const kind = (k: string) =>
    k === 'invoice' || k === 'credit_note' ? t(k) : t(`stKind_${k}` as 'stKind_receipt');
  for (const c of d.currencies) {
    const money = (row: ExcelJS.Row) => {
      for (const i of [5, 6, 7]) row.getCell(i).numFmt = MONEY;
    };
    const opening = ws.addRow([
      d.from,
      t('stOpening'),
      '',
      c.currency,
      '',
      '',
      amount(c.opening, c.currency),
    ]);
    money(opening);
    opening.font = { italic: true };
    for (const r of c.rows)
      money(
        ws.addRow([
          r.date,
          kind(r.kind),
          r.reference,
          c.currency,
          r.debit ? amount(r.debit, c.currency) : '',
          r.credit ? amount(r.credit, c.currency) : '',
          amount(r.balance, c.currency),
        ]),
      );
    const closing = ws.addRow([
      d.to,
      t('stClosing'),
      '',
      c.currency,
      '',
      '',
      amount(c.closing, c.currency),
    ]);
    money(closing);
    closing.font = { bold: true };
    ws.addRow([]);
  }
  return finish(workbook);
}

/** The receivables aging as a workbook: one row per party and currency, then totals. */
export function agingXlsx(d: AgingData, brand: DocumentBrand, locale: DocLocale): Promise<Buffer> {
  const t = textTranslator(locale);
  const workbook = new ExcelJS.Workbook();
  const ws = sheet(workbook, t('aging'), locale);
  const columns = [
    { header: t('agParty'), width: 30 },
    { header: 'Currency', width: 9 },
    { header: t('agCurrent'), width: 14 },
    { header: t('ag1_30'), width: 13 },
    { header: t('ag31_60'), width: 13 },
    { header: t('ag61_90'), width: 13 },
    { header: t('ag90'), width: 14 },
    { header: t('agTotal'), width: 14 },
    { header: t('agCredit'), width: 14 },
    { header: t('agNet'), width: 14 },
    { header: t('agInvoices'), width: 10 },
  ];
  header(workbook, ws, brand, t('aging'), t('agAsOf', { d: d.asOf }), columns);
  const line = (
    name: string,
    x: Pick<
      AgingData['rows'][number],
      'currency' | 'buckets' | 'total' | 'unappliedCredit' | 'net' | 'invoices'
    >,
  ) => {
    const row = ws.addRow([
      name,
      x.currency,
      amount(x.buckets.current, x.currency),
      amount(x.buckets.d1_30, x.currency),
      amount(x.buckets.d31_60, x.currency),
      amount(x.buckets.d61_90, x.currency),
      amount(x.buckets.d90_plus, x.currency),
      amount(x.total, x.currency),
      amount(x.unappliedCredit, x.currency),
      amount(x.net, x.currency),
      x.invoices,
    ]);
    for (let i = 3; i <= 10; i++) row.getCell(i).numFmt = MONEY;
    return row;
  };
  for (const r of d.rows) line(r.partyName, r);
  for (const total of d.totals) line(t('agAll'), total).font = { bold: true };
  return finish(workbook);
}
