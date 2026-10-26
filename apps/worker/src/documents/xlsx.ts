import ExcelJS from 'exceljs';
import { checkinColumns, locText, textTranslator, type DocLocale } from '@vs/documents';
import type { DepartureCheckin, DocumentBrand, LegManifest, VacancyData } from '@vs/engine';
import { brandPalette } from '@vs/shared/color';

/**
 * Spreadsheets: plain values (dates as ISO text, numbers as numbers), right-to-left in Arabic,
 * with the company's logo, name and colours above a frozen header row.
 */

const argb = (hex: string) => `FF${hex.slice(1).toUpperCase()}`;

export function sheet(workbook: ExcelJS.Workbook, name: string, locale: DocLocale) {
  // Sheet names are limited to 31 characters and may not contain / \ ? * [ ].
  const safe = name.replace(/[/\\?*[\]:]/g, '-').slice(0, 31);
  return workbook.addWorksheet(safe, {
    views: [{ rightToLeft: locale !== 'en', state: 'frozen', ySplit: 4 }],
  });
}

export function header(
  workbook: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  brand: DocumentBrand,
  title: string,
  subtitle: string,
  columns: { header: string; width: number }[],
) {
  const c = brandPalette(brand.primary, brand.secondary);
  columns.forEach((col, i) => (ws.getColumn(i + 1).width = col.width));
  ws.getRow(1).height = 34;
  let first = 1;
  const match = brand.logo?.match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (match) {
    const image = workbook.addImage({
      base64: match[2]!,
      extension: match[1] === 'png' ? 'png' : 'jpeg',
    });
    ws.addImage(image, {
      tl: { col: 0, row: 0 },
      ext: { width: 120, height: 42 },
      editAs: 'oneCell',
    });
    first = 3;
  }
  const name = ws.getCell(1, first);
  name.value = brand.name;
  name.font = { bold: true, size: 14, color: { argb: argb(c.primaryText) } };
  name.alignment = { vertical: 'middle' };
  ws.getCell(2, 1).value = title;
  ws.getCell(2, 1).font = { bold: true, size: 12 };
  ws.getCell(3, 1).value = subtitle;
  ws.getCell(3, 1).font = { color: { argb: 'FF5B6573' } };
  const row = ws.getRow(4);
  columns.forEach((col, i) => {
    const cell = row.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: argb(c.primaryInk) } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(c.primary) } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  // Bilingual headers ("عربي / English") wrap onto two lines.
  row.height = columns.some((col) => col.header.includes(' / ')) ? 30 : 20;
}

export async function finish(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function manifestXlsx(
  m: LegManifest,
  brand: DocumentBrand,
  locale: DocLocale,
  withPassports: boolean,
): Promise<Buffer> {
  const t = textTranslator(locale);
  const workbook = new ExcelJS.Workbook();
  const title = withPassports ? t('manifest') : t('rooming_list');
  const ws = sheet(workbook, title, locale);
  const from = locText({ ar: m.leg.from.nameAr, en: m.leg.from.nameEn }, locale);
  header(workbook, ws, brand, title, `${m.leg.vessel} · ${m.leg.departDate} · ${from}`, [
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
  ]);
  for (const p of m.parties) {
    const category = locText({ ar: p.category.nameAr, en: p.category.nameEn }, locale);
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

export function vacancyXlsx(
  v: VacancyData,
  brand: DocumentBrand,
  locale: DocLocale,
): Promise<Buffer> {
  const t = textTranslator(locale);
  const workbook = new ExcelJS.Workbook();
  const ws = sheet(workbook, t('vacancy_sheet'), locale);
  header(workbook, ws, brand, t('vacancy_sheet'), `${v.vessel} · ${v.from} – ${v.to}`, [
    { header: t('embark'), width: 12 },
    { header: t('cruise'), width: 30 },
    { header: t('nights'), width: 8 },
    ...v.categories.map((c) => ({ header: c.code, width: 8 })),
  ]);
  for (const s of v.sailings) {
    ws.addRow([
      s.embarkDate,
      t('sailFrom', { from: locText(s.embark, locale), to: locText(s.disembark, locale) }),
      s.nights,
      ...v.categories.map((c) => s.free[c.id] ?? 0),
    ]);
  }
  return finish(workbook);
}

/**
 * The check-in file: one row per guest boarding, the police list's columns first, then what the
 * reception and kitchen need. Passport and visa numbers included (permission `manifests`).
 */
export function checkinXlsx(
  d: DepartureCheckin,
  brand: DocumentBrand,
  locale: DocLocale,
): Promise<Buffer> {
  const t = textTranslator(locale);
  const workbook = new ExcelJS.Workbook();
  const ws = sheet(workbook, t('checkin_file'), locale);
  const from = locText({ ar: d.leg.from.nameAr, en: d.leg.from.nameEn }, locale);
  const columns = [
    ...checkinColumns(locale),
    {
      header: t('emergencyContact'),
      width: 22,
      value: (_: unknown, g: DepartureCheckin['parties'][number]['guests'][number]) =>
        [g.emergencyName, g.emergencyPhone].filter(Boolean).join(' · '),
    },
    {
      header: t('dietaryTitle'),
      width: 18,
      value: (_: unknown, g: DepartureCheckin['parties'][number]['guests'][number]) =>
        g.dietary.map((x) => t(x)).join(', '),
    },
    {
      header: t('allergies'),
      width: 18,
      value: (_: unknown, g: DepartureCheckin['parties'][number]['guests'][number]) =>
        g.allergies ?? '',
    },
    {
      header: t('medical'),
      width: 22,
      value: (_: unknown, g: DepartureCheckin['parties'][number]['guests'][number]) =>
        g.medicalNotes ?? '',
    },
    {
      header: t('occasion'),
      width: 14,
      value: (_: unknown, g: DepartureCheckin['parties'][number]['guests'][number]) =>
        g.occasion
          ? `${t(g.occasion === 'other' ? 'otherOccasion' : g.occasion)}${g.occasionDate ? ` ${g.occasionDate}` : ''}`
          : '',
    },
  ];
  header(
    workbook,
    ws,
    brand,
    t('checkin_file'),
    `${d.leg.vessel} · ${d.leg.departDate} · ${from}`,
    columns,
  );
  for (const party of d.parties) {
    for (const g of party.guests) {
      ws.addRow(columns.map((c) => c.value(party as never, g)));
    }
  }
  return finish(workbook);
}
