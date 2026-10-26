import ExcelJS from 'exceljs';
import { locText, textTranslator, type DocLocale } from '@vs/documents';
import {
  analyticsOverview,
  behaviourReport,
  channelsReport,
  occupancyReport,
  type AnalyticsExportParams,
  type DocumentBrand,
  type EngineContext,
  type VsDatabase,
} from '@vs/engine';
import { minorToDecimal } from '@vs/shared';
import { finish, header, sheet } from './xlsx';

/**
 * Analytics A1.3: one workbook per Analytics tab, one sheet per table, the same figures as the
 * screen. Money columns only when the request was made by someone who sees money. Amounts are
 * numbers in the currency's units, with the currency in its own column.
 */

type Column = { header: string; width: number };
const ratio = (booked: number, sale: number) =>
  sale > 0 ? Math.round((booked / sale) * 1000) / 1000 : null;
const amount = (minor: bigint, currency: string) => Number(minorToDecimal(minor, currency));

function table(
  workbook: ExcelJS.Workbook,
  brand: DocumentBrand,
  locale: DocLocale,
  title: string,
  subtitle: string,
  columns: Column[],
  rows: (string | number | null)[][],
  percentColumns: number[] = [],
) {
  const ws = sheet(workbook, title, locale);
  header(workbook, ws, brand, title, subtitle, columns);
  for (const row of rows) ws.addRow(row);
  for (const index of percentColumns) ws.getColumn(index + 1).numFmt = '0.0%';
}

export async function analyticsXlsx(
  db: VsDatabase,
  ctx: EngineContext,
  params: AnalyticsExportParams,
  brand: DocumentBrand,
  locale: DocLocale,
): Promise<{ content: Buffer; base: string }> {
  const t = textTranslator(locale);
  const workbook = new ExcelJS.Workbook();
  const withMoney = params.withMoney;
  const filter = params.filter as Record<string, string | number | null | undefined>;
  const period =
    'to' in filter
      ? `${t('an_period')}: ${filter.from} – ${filter.to} (${t(filter.basis === 'sailing' ? 'an_basis_sailing' : 'an_basis_booked')})`
      : 'from' in filter
        ? `${t('an_period')}: ${filter.from} + ${filter.days}`
        : '';

  if (params.report === 'overview') {
    const d = await analyticsOverview(db, ctx, filter, { withMoney });
    const rows: (string | number | null)[][] = [
      ...(['next30', 'next60', 'next90', 'last30'] as const).map((w) => [
        t(`an_occ_${w}`),
        ratio(d.occupancy[w].bookedNights, d.occupancy[w].saleNights),
      ]),
      [t('an_bookedWeek'), d.sales.week.cabins],
      [t('an_bookedWeekLy'), d.sales.weekLastYear.cabins],
      [t('an_bookedMonth'), d.sales.month.cabins],
      [t('an_bookedMonthLy'), d.sales.monthLastYear.cabins],
      [t('an_pace'), d.pace.now],
      [t('an_pace7'), d.pace.sevenNightsAgo],
      [t('an_pace28'), d.pace.twentyEightNightsAgo],
      [t('an_reqReceived'), d.requests.received],
      [t('an_reqInTime'), d.requests.answered_in_time],
      [t('an_converted'), d.requests.converted],
      [t('an_cancelledMonth'), d.cancellations.cancelled],
      [t('an_confirmedMonth'), d.cancellations.confirmed],
    ];
    const ws = sheet(workbook, t('an_overview'), locale);
    header(workbook, ws, brand, t('an_overview'), d.today, [
      { header: t('an_figure'), width: 36 },
      { header: t('an_value'), width: 14 },
    ]);
    rows.forEach((r, i) => {
      const row = ws.addRow(r);
      if (i < 4) row.getCell(2).numFmt = '0.0%';
    });
    if (withMoney) {
      table(
        workbook,
        brand,
        locale,
        t('an_bookedMonth'),
        d.today,
        [
          { header: t('an_currency'), width: 10 },
          { header: t('an_total'), width: 16 },
          { header: t('an_net'), width: 16 },
        ],
        (d.sales.month.value ?? []).map((m) => [
          m.currency,
          amount(m.total, m.currency),
          amount(m.net, m.currency),
        ]),
      );
    }
    return { content: await finish(workbook), base: `analytics-overview-${d.today}` };
  }

  if (params.report === 'occupancy') {
    const d = await occupancyReport(db, ctx, filter as never, { withMoney });
    const name = (s: {
      nameEn: string | null;
      nameAr: string | null;
      code: string | null;
      nights: number;
    }) => locText({ ar: s.nameAr, en: s.nameEn }, locale) || s.code || String(s.nights);
    table(
      workbook,
      brand,
      locale,
      t('an_sailings'),
      period,
      [
        { header: t('an_embark'), width: 12 },
        { header: t('an_itinerary'), width: 28 },
        { header: t('an_vessel'), width: 18 },
        { header: t('an_bookings'), width: 10 },
        { header: t('an_cabins'), width: 10 },
        { header: t('an_held'), width: 10 },
        { header: t('an_bookedNights'), width: 14 },
        { header: t('an_saleNights'), width: 14 },
        { header: t('an_occ'), width: 11 },
        ...(withMoney
          ? [
              { header: t('an_currency'), width: 10 },
              { header: t('an_total'), width: 16 },
              { header: t('an_net'), width: 16 },
            ]
          : []),
      ],
      d.sailings.flatMap((s) => {
        const base = [
          s.embarkDate,
          name(s),
          s.vessel,
          s.bookings,
          s.cabins,
          s.held,
          s.bookedNights,
          s.saleNights,
          ratio(s.bookedNights, s.saleNights),
        ];
        if (!withMoney) return [base];
        const value = s.value ?? [];
        return value.length
          ? value.map((m) => [
              ...base,
              m.currency,
              amount(m.total, m.currency),
              amount(m.net, m.currency),
            ])
          : [[...base, null, null, null]];
      }),
      [8],
    );
    table(
      workbook,
      brand,
      locale,
      t('an_categories'),
      period,
      [
        { header: t('an_category'), width: 24 },
        { header: t('an_bookedNights'), width: 14 },
        { header: t('an_saleNights'), width: 14 },
        { header: t('an_occ'), width: 11 },
      ],
      d.categories.map((c) => [
        locText({ ar: c.nameAr, en: c.nameEn }, locale),
        c.bookedNights,
        c.saleNights,
        ratio(c.bookedNights, c.saleNights),
      ]),
      [3],
    );
    table(
      workbook,
      brand,
      locale,
      t('an_heat'),
      period,
      [
        { header: t('an_sailings'), width: 34 },
        ...d.categories.map((c) => ({ header: c.code, width: 9 })),
      ],
      d.sailings.map((s) => [
        `${s.embarkDate} ${name(s)}`,
        ...d.categories.map((c) => {
          const cell = d.cells.find(
            (x) => x.sailingId === s.sailingId && x.categoryId === c.categoryId,
          );
          return cell ? ratio(cell.bookedNights, cell.saleNights) : null;
        }),
      ]),
      d.categories.map((_, i) => i + 1),
    );
    return { content: await finish(workbook), base: `analytics-occupancy-${d.from}` };
  }

  if (params.report === 'channels') {
    const d = await channelsReport(db, ctx, filter as never, { withMoney });
    table(
      workbook,
      brand,
      locale,
      t('an_channels'),
      period,
      [
        { header: t('an_channel'), width: 24 },
        { header: t('an_bookings'), width: 10 },
        { header: t('an_cabins'), width: 10 },
        { header: t('an_cabinNights'), width: 12 },
        { header: t('an_cancelled'), width: 10 },
        { header: t('an_requests'), width: 10 },
        { header: t('an_converted'), width: 14 },
        { header: t('an_median'), width: 14 },
        ...(withMoney
          ? [
              { header: t('an_currency'), width: 10 },
              { header: t('an_total'), width: 16 },
              { header: t('an_net'), width: 16 },
              { header: t('an_perNight'), width: 14 },
            ]
          : []),
      ],
      d.channels.flatMap((c) => {
        const base = [
          c.name,
          c.bookings,
          c.cabins,
          c.cabinNights,
          c.cancelled,
          c.requests?.received ?? 0,
          c.requests?.converted ?? 0,
          c.requests?.medianMinutes ?? null,
        ];
        if (!withMoney) return [base];
        const value = c.value ?? [];
        return value.length
          ? value.map((m) => [
              ...base,
              m.currency,
              amount(m.total, m.currency),
              amount(m.net, m.currency),
              m.cabinNights
                ? Math.round((amount(m.total, m.currency) / m.cabinNights) * 100) / 100
                : null,
            ])
          : [[...base, null, null, null, null]];
      }),
    );
    table(
      workbook,
      brand,
      locale,
      t('an_markets'),
      period,
      [
        { header: t('an_market'), width: 22 },
        { header: t('an_bookings'), width: 10 },
        { header: t('an_cabins'), width: 10 },
        { header: t('an_guests'), width: 10 },
        { header: t('an_withChildren'), width: 14 },
        ...(withMoney
          ? [
              { header: t('an_currency'), width: 10 },
              { header: t('an_total'), width: 16 },
            ]
          : []),
      ],
      d.markets.flatMap((m) => {
        const base = [
          locText({ ar: m.nameAr, en: m.nameEn }, locale),
          m.bookings,
          m.cabins,
          m.guests,
          m.withChildren,
        ];
        if (!withMoney) return [base];
        const value = m.value ?? [];
        return value.length
          ? value.map((v) => [...base, v.currency, amount(v.amount, v.currency)])
          : [[...base, null, null]];
      }),
    );
    table(
      workbook,
      brand,
      locale,
      t('an_nationalities'),
      period,
      [
        { header: t('nationality'), width: 14 },
        { header: t('an_guests'), width: 10 },
        { header: t('an_bookings'), width: 10 },
      ],
      d.nationalities.map((n) => [n.nationality ?? '—', n.guests, n.bookings]),
    );
    table(
      workbook,
      brand,
      locale,
      t('an_allotments'),
      period,
      [
        { header: t('an_channel'), width: 24 },
        { header: t('an_allotted'), width: 10 },
        { header: t('an_sold'), width: 10 },
        { header: t('an_held'), width: 10 },
        { header: t('an_released'), width: 14 },
        { header: t('an_open'), width: 14 },
      ],
      d.allotments.map((a) => [a.name, a.allotted, a.sold, a.held, a.released, a.open ?? 0]),
    );
    return { content: await finish(workbook), base: `analytics-channels-${d.filter.from}` };
  }

  const d = await behaviourReport(db, ctx, filter as never, { withMoney });
  table(
    workbook,
    brand,
    locale,
    t('an_window'),
    period,
    [
      { header: t('an_days'), width: 20 },
      { header: t('an_bookings'), width: 10 },
    ],
    d.bookingWindow.bands.map((b) => [b.band, b.bookings]),
  );
  table(
    workbook,
    brand,
    locale,
    t('an_lengths'),
    period,
    [
      { header: t('an_nights'), width: 10 },
      { header: t('an_bookings'), width: 10 },
      { header: t('an_cabins'), width: 10 },
    ],
    d.lengths.map((l) => [l.nights, l.bookings, l.cabins]),
  );
  table(
    workbook,
    brand,
    locale,
    t('an_itineraries'),
    period,
    [
      { header: t('an_itinerary'), width: 30 },
      { header: t('an_nights'), width: 10 },
      { header: t('an_bookings'), width: 10 },
      { header: t('an_cabins'), width: 10 },
    ],
    d.itineraries.map((i) => [
      locText({ ar: i.nameAr, en: i.nameEn }, locale) || i.code || '—',
      i.nights,
      i.bookings,
      i.cabins,
    ]),
  );
  table(
    workbook,
    brand,
    locale,
    t('an_holds'),
    period,
    [
      { header: t('an_kind'), width: 14 },
      { header: t('an_placed'), width: 10 },
      { header: t('an_confirmed'), width: 10 },
      { header: t('an_expired'), width: 10 },
      { header: t('an_releasedHolds'), width: 10 },
      { header: t('an_active'), width: 10 },
      { header: t('an_avgHours'), width: 12 },
    ],
    d.holds.map((h) => [
      h.kind,
      h.placed,
      h.confirmed,
      h.expired,
      h.released,
      h.active,
      h.averageHours,
    ]),
  );
  table(
    workbook,
    brand,
    locale,
    t('an_cancellations'),
    period,
    [
      { header: t('an_days'), width: 20 },
      { header: t('an_bookings'), width: 10 },
    ],
    d.cancellations.bands.map((b) => [b.band, b.bookings]),
  );
  table(
    workbook,
    brand,
    locale,
    t('an_amendments'),
    period,
    [
      { header: t('an_change'), width: 16 },
      { header: t('an_count'), width: 10 },
    ],
    [
      ...d.amendments.changes.map((c) => [c.change, c.amendments]),
      [t('an_amendedBookings'), d.amendments.bookings],
    ],
  );
  if (withMoney) {
    table(
      workbook,
      brand,
      locale,
      t('an_penalties'),
      period,
      [
        { header: t('an_currency'), width: 10 },
        { header: t('an_penalties'), width: 16 },
        { header: t('an_fees'), width: 16 },
      ],
      [
        ...new Set([
          ...(d.cancellations.penalties ?? []).map((p) => p.currency),
          ...(d.amendments.fees ?? []).map((f) => f.currency),
        ]),
      ].map((currency) => {
        const p = d.cancellations.penalties?.find((x) => x.currency === currency);
        const f = d.amendments.fees?.find((x) => x.currency === currency);
        return [currency, p ? amount(p.amount, currency) : 0, f ? amount(f.amount, currency) : 0];
      }),
    );
  }
  return { content: await finish(workbook), base: `analytics-behaviour-${d.filter.from}` };
}
