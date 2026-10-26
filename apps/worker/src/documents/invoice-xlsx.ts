import ExcelJS from 'exceljs';
import { textTranslator, type DocLocale } from '@vs/documents';
import type { DocumentBrand, InvoiceRegisterParams, InvoiceRegisterRow } from '@vs/engine';
import { minorToDecimal } from '@vs/shared';
import { finish, header, sheet } from './xlsx';

const amount = (minor: bigint, currency: string) => Number(minorToDecimal(minor, currency));

/**
 * The invoice register (invoicing F2) for the accountant: every invoice and credit note issued
 * in the period, one row each, amounts in the document's currency and in the base currency.
 * Credit notes are negative in the base-currency column, so the column sums to net sales.
 */
export function invoiceRegisterXlsx(
  rows: InvoiceRegisterRow[],
  params: InvoiceRegisterParams,
  brand: DocumentBrand,
  locale: DocLocale,
): Promise<Buffer> {
  const t = textTranslator(locale);
  const workbook = new ExcelJS.Workbook();
  const ws = sheet(workbook, t('invoice_register'), locale);
  const base = rows[0]?.baseCurrency ?? 'EGP';
  const columns = [
    { header: t('invNumber'), width: 18 },
    { header: t('invIssueDate'), width: 13 },
    { header: t('invDueDate'), width: 13 },
    { header: t('invBillTo'), width: 30 },
    { header: t('invTaxNo'), width: 18 },
    { header: t('bookingRef'), width: 22 },
    { header: t('credit_note'), width: 18 },
    { header: 'Currency', width: 9 },
    { header: t('invSubtotal'), width: 14 },
    { header: t('invTax'), width: 12 },
    { header: t('invTotal'), width: 14 },
    { header: t('invCredited'), width: 13 },
    { header: t('invPaid'), width: 13 },
    { header: 'FX', width: 10 },
    { header: `${t('invTotal')} (${base})`, width: 16 },
  ];
  header(workbook, ws, brand, t('invoice_register'), `${params.from} → ${params.to}`, columns);
  for (const r of rows) {
    const sign = r.type === 'credit_note' ? -1 : 1;
    const row = ws.addRow([
      r.number,
      r.issueDate,
      r.dueDate ?? '',
      r.party,
      r.partyTaxNo ?? '',
      r.bookingRefs.join(', '),
      r.credits ?? '',
      r.currency,
      sign * amount(r.subtotal, r.currency),
      sign * amount(r.taxTotal, r.currency),
      sign * amount(r.total, r.currency),
      r.type === 'invoice' ? amount(r.amountCredited, r.currency) : '',
      r.type === 'invoice' ? amount(r.amountPaid, r.currency) : '',
      r.fxRate ? Number(r.fxRate) : '',
      sign * amount(r.baseTotal, r.baseCurrency),
    ]);
    for (const i of [9, 10, 11, 12, 13, 15]) row.getCell(i).numFmt = '#,##0.00';
  }
  return finish(workbook);
}
