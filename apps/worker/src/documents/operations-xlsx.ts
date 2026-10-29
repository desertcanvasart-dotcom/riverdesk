import ExcelJS from 'exceljs';
import { textTranslator, type DocLocale } from '@vs/documents';
import type { DepartureCheckin, DocumentBrand } from '@vs/engine';
import { finish, header, sheet } from './xlsx';

/**
 * On-board lists (Batch D3) as workbooks, for the kitchen, the restaurant and the transfer desk:
 * the same rows as the PDFs, one guest per row.
 */
export function operationsXlsx(
  kind: 'diet_list' | 'occasion_list' | 'disembarkation_list',
  d: DepartureCheckin,
  brand: DocumentBrand,
  locale: DocLocale,
): Promise<Buffer> {
  const t = textTranslator(locale);
  const workbook = new ExcelJS.Workbook();
  const ws = sheet(workbook, t(kind), locale);
  const rows = d.parties.flatMap((party) =>
    party.guests.map((g) => ({ party, g, cabin: party.cabin?.number ?? '' })),
  );
  const date = kind === 'disembarkation_list' ? d.leg.arriveDate : d.leg.departDate;
  if (kind === 'diet_list') {
    header(workbook, ws, brand, t(kind), `${d.leg.vessel} · ${date}`, [
      { header: t('cabin'), width: 8 },
      { header: t('guests'), width: 28 },
      { header: t('opDiet'), width: 28 },
      { header: t('opAllergies'), width: 34 },
      { header: t('bookingRef'), width: 14 },
    ]);
    for (const { party, g, cabin } of rows.filter((r) => r.g.dietary.length || r.g.allergies))
      ws.addRow([
        cabin,
        `${g.lastName}, ${g.firstName}`,
        g.dietary.map((x) => t(x)).join(', '),
        g.allergies ?? '',
        party.ref,
      ]);
  } else if (kind === 'occasion_list') {
    header(workbook, ws, brand, t(kind), `${d.leg.vessel} · ${date}`, [
      { header: t('cabin'), width: 8 },
      { header: t('guests'), width: 28 },
      { header: t('opOccasion'), width: 18 },
      { header: t('opOn'), width: 12 },
      { header: t('bookingRef'), width: 14 },
    ]);
    for (const { party, g, cabin } of rows.filter((r) => r.g.occasion))
      ws.addRow([
        cabin,
        `${g.lastName}, ${g.firstName}`,
        t(g.occasion === 'other' ? 'otherOccasion' : g.occasion!),
        g.occasionDate ?? '',
        party.ref,
      ]);
  } else {
    header(workbook, ws, brand, t(kind), `${d.leg.vessel} · ${d.leg.to.nameEn} · ${date}`, [
      { header: t('cabin'), width: 8 },
      { header: t('guests'), width: 28 },
      { header: t('opFlight'), width: 12 },
      { header: t('opFlightDate'), width: 12 },
      { header: t('opFlightTime'), width: 9 },
      { header: t('phone'), width: 18 },
      { header: t('bookingRef'), width: 14 },
    ]);
    for (const { party, g, cabin } of rows)
      ws.addRow([
        cabin,
        `${g.lastName}, ${g.firstName}`,
        g.departureFlight ?? '',
        g.departureDate ?? '',
        g.departureTime ?? '',
        g.phone ?? '',
        party.ref,
      ]);
  }
  return finish(workbook);
}
