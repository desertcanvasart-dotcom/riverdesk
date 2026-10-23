import ExcelJS from 'exceljs';
import type { LegManifest, VacancyData } from '@vs/engine';
import { translator, type Locale } from './i18n';

/** Spreadsheets: plain values (dates as ISO text, numbers as numbers), right-to-left in Arabic. */

function sheet(workbook: ExcelJS.Workbook, name: string, locale: Locale) {
  const ws = workbook.addWorksheet(name, {
    views: [{ rightToLeft: locale === 'ar', state: 'frozen', ySplit: 3 }],
  });
  return ws;
}

function header(
  ws: ExcelJS.Worksheet,
  title: string,
  subtitle: string,
  columns: { header: string; width: number }[],
) {
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = subtitle;
  const row = ws.getRow(3);
  columns.forEach((c, i) => {
    row.getCell(i + 1).value = c.header;
    ws.getColumn(i + 1).width = c.width;
  });
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6F7' } };
}

async function finish(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function manifestXlsx(
  m: LegManifest,
  locale: Locale,
  withPassports: boolean,
): Promise<Buffer> {
  const t = translator(locale);
  const workbook = new ExcelJS.Workbook();
  const ws = sheet(workbook, withPassports ? t('manifest') : t('rooming_list'), locale);
  const from = locale === 'ar' ? m.leg.from.nameAr : m.leg.from.nameEn;
  header(
    ws,
    withPassports ? t('manifest') : t('rooming_list'),
    `${m.leg.vessel} · ${m.leg.departDate} · ${from}`,
    [
      { header: t('cabin'), width: 10 },
      { header: t('category'), width: 18 },
      ...(withPassports
        ? [
            { header: t('name'), width: 28 },
            { header: t('nationality'), width: 12 },
            { header: t('dob'), width: 14 },
            { header: t('passport'), width: 16 },
          ]
        : [
            { header: t('guests'), width: 40 },
            { header: t('adults'), width: 9 },
            { header: t('children'), width: 16 },
          ]),
      { header: t('booking'), width: 16 },
      { header: t('embark'), width: 12 },
      { header: t('disembark'), width: 12 },
    ],
  );
  for (const p of m.parties) {
    const category = locale === 'ar' ? p.category.nameAr : p.category.nameEn;
    const tail = [
      p.ref,
      `${p.embark.port} ${p.embark.date}`,
      `${p.disembark.port} ${p.disembark.date}`,
    ];
    if (withPassports) {
      for (const g of p.guests) {
        ws.addRow([
          p.cabin?.number ?? '',
          category,
          `${g.lastName}, ${g.firstName}`,
          g.nationality ?? '',
          g.dateOfBirth ?? '',
          g.passportNumber ?? '',
          ...tail,
        ]);
      }
    } else {
      ws.addRow([
        p.cabin?.number ?? '',
        category,
        p.guests.map((g) => `${g.firstName} ${g.lastName}`).join('; '),
        p.adults,
        p.childAges.join(', '),
        ...tail,
      ]);
    }
  }
  return finish(workbook);
}

export function vacancyXlsx(v: VacancyData, locale: Locale): Promise<Buffer> {
  const t = translator(locale);
  const workbook = new ExcelJS.Workbook();
  const ws = sheet(workbook, t('vacancy_sheet'), locale);
  header(ws, t('vacancy_sheet'), `${v.operator} · ${v.vessel} · ${v.from} – ${v.to}`, [
    { header: t('embark'), width: 12 },
    { header: t('cruise'), width: 30 },
    { header: t('nights'), width: 8 },
    ...v.categories.map((c) => ({ header: c.code, width: 8 })),
  ]);
  for (const s of v.sailings) {
    ws.addRow([
      s.embarkDate,
      t('sailFrom', { from: s.embark[locale], to: s.disembark[locale] }),
      s.nights,
      ...v.categories.map((c) => s.free[c.id] ?? 0),
    ]);
  }
  return finish(workbook);
}
