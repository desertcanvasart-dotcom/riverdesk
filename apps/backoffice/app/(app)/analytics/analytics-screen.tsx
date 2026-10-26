'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, Info } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { HeatMap, LineChart, ShareBars } from '../../../components/charts';
import { Card, Empty, Field, Input, Select, Table, Td, cx } from '../../../components/ui';
import { formatDate, formatMoney, formatNumber } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';

type Tab = 'overview' | 'occupancy';
type Money = { currency: string; total: bigint; net: bigint }[];

const share = (booked: number, sale: number) => (sale > 0 ? booked / sale : null);

/**
 * Analytics (A1.2): how the company is doing, then occupancy and pace sailing by sailing. One
 * filter row scopes everything below it. Money only for owners and finance.
 */
export function AnalyticsScreen({
  vessels,
  canMoney,
}: {
  vessels: { id: string; name: string }[];
  canMoney: boolean;
}) {
  const t = useTranslations('analytics');
  const [tab, setTab] = useState<Tab>('overview');
  const [vesselId, setVesselId] = useState<string>('');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1 rounded-full bg-line/40 p-1 text-sm" role="tablist">
          {(['overview', 'occupancy'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cx(
                'rounded-full px-4 py-1.5',
                tab === k ? 'bg-surface font-medium shadow-sm' : 'text-muted hover:text-ink',
              )}
            >
              {t(`tab_${k}`)}
            </button>
          ))}
        </div>
        {vessels.length > 1 && (
          <Field label={t('vessel')}>
            <Select value={vesselId} onChange={(e) => setVesselId(e.target.value)}>
              <option value="">{t('allVessels')}</option>
              {vessels.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      {tab === 'overview' ? (
        <Overview vesselId={vesselId || null} canMoney={canMoney} />
      ) : (
        <Occupancy vesselId={vesselId || null} canMoney={canMoney} />
      )}
    </div>
  );
}

function usePercent() {
  const locale = useLocale();
  return (value: number | null) =>
    value === null
      ? '—'
      : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value);
}

function Tile({
  label,
  value,
  sub,
  delta,
  help,
  children,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  delta?: { text: string; up: boolean | null };
  help: string;
  children?: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm text-muted">{label}</h3>
        <span title={help} aria-label={help} className="text-muted">
          <Info aria-hidden className="size-4" />
        </span>
      </div>
      <div className="text-2xl font-semibold">{value}</div>
      {delta && (
        <div
          className={cx(
            'flex items-center gap-1 text-xs font-medium',
            delta.up === null ? 'text-muted' : delta.up ? 'text-ok' : 'text-bad',
          )}
        >
          {delta.up !== null &&
            (delta.up ? (
              <ArrowUpRight aria-hidden className="size-3.5 rtl:-scale-x-100" />
            ) : (
              <ArrowDownRight aria-hidden className="size-3.5 rtl:-scale-x-100" />
            ))}
          {delta.text}
        </div>
      )}
      {sub && <div className="text-xs text-muted">{sub}</div>}
      {children}
    </section>
  );
}

function Overview({ vesselId, canMoney }: { vesselId: string | null; canMoney: boolean }) {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const pct = usePercent();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.analytics.overview.queryOptions({ vesselId }, { placeholderData: (p) => p }),
  );
  if (!q.data) return <Empty>{t('loading')}</Empty>;
  const d = q.data;
  const n = (v: number) => formatNumber(v, locale);
  const versus = (now: number, before: number | null, label: string, since?: string) => {
    if (before === null) return { text: t('noHistory'), up: null };
    // A period before the company's first booking has no data, not zero sales.
    if (since && (!d.historyFrom || d.historyFrom > since))
      return { text: t('noLastYear'), up: null };
    const diff = now - before;
    return {
      text: t('versus', { diff: `${diff > 0 ? '+' : ''}${n(diff)}`, when: label }),
      up: diff === 0 ? null : diff > 0,
    };
  };
  const money = (value: Money | undefined) =>
    canMoney && value?.length ? (
      <ul className="mt-1 text-xs">
        {value.map((m) => (
          <li key={m.currency}>
            {formatMoney(m.total, m.currency, locale)}{' '}
            <span className="text-muted">
              ({t('net')} {formatMoney(m.net, m.currency, locale)})
            </span>
          </li>
        ))}
      </ul>
    ) : null;
  const { sales, occupancy, pace, requests, cancellations } = d;

  return (
    <div className={cx('flex flex-col gap-4', q.isFetching && 'opacity-70')}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(['next30', 'next60', 'next90', 'last30'] as const).map((w) => (
          <Tile
            key={w}
            label={t(`occ_${w}`)}
            value={pct(share(occupancy[w].bookedNights, occupancy[w].saleNights))}
            sub={t('cabinNights', {
              booked: n(occupancy[w].bookedNights),
              sale: n(occupancy[w].saleNights),
            })}
            help={t('help_occupancy')}
          />
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <Tile
          label={t('bookedWeek')}
          value={t('cabinsN', { n: n(sales.week.cabins) })}
          sub={t('bookingsN', { n: n(sales.week.bookings) })}
          delta={versus(
            sales.week.cabins,
            sales.weekLastYear.cabins,
            t('lastYear'),
            sales.weekLastYear.from,
          )}
          help={t('help_booked')}
        >
          {money(sales.week.value)}
        </Tile>
        <Tile
          label={t('bookedMonth')}
          value={t('cabinsN', { n: n(sales.month.cabins) })}
          sub={t('bookingsN', { n: n(sales.month.bookings) })}
          delta={versus(
            sales.month.cabins,
            sales.monthLastYear.cabins,
            t('lastYear'),
            sales.monthLastYear.from,
          )}
          help={t('help_booked')}
        >
          {money(sales.month.value)}
        </Tile>
        <Tile
          label={t('pace')}
          value={t('cabinsN', { n: n(pace.now) })}
          delta={versus(pace.now, pace.sevenNightsAgo, t('sevenNights'))}
          sub={
            pace.twentyEightNightsAgo === null
              ? t('paceStarts')
              : t('versus', {
                  diff: `${pace.now - pace.twentyEightNightsAgo > 0 ? '+' : ''}${n(pace.now - pace.twentyEightNightsAgo)}`,
                  when: t('twentyEightNights'),
                })
          }
          help={t('help_pace')}
        />
        <Tile
          label={t('requests')}
          value={pct(share(requests.answered_in_time, requests.received))}
          sub={t('requestsSub', {
            inTime: n(requests.answered_in_time),
            received: n(requests.received),
            converted: n(requests.converted),
            pending: n(requests.pending),
          })}
          help={t('help_requests')}
        />
        <Tile
          label={t('cancellations')}
          value={pct(share(cancellations.cancelled, cancellations.confirmed))}
          sub={t('cancellationsSub', {
            cancelled: n(cancellations.cancelled),
            confirmed: n(cancellations.confirmed),
          })}
          help={t('help_cancellations')}
        />
      </div>
      <p className="text-xs text-muted">
        {t('asOf', { date: formatDate(d.today, locale) })} · {t('lastYearNote')}
      </p>
    </div>
  );
}

function Occupancy({ vesselId, canMoney }: { vesselId: string | null; canMoney: boolean }) {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const isArabic = locale.startsWith('ar');
  const pct = usePercent();
  const trpc = useTRPC();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
  const [from, setFrom] = useState(today);
  const [days, setDays] = useState(60);
  const [selected, setSelected] = useState<string | null>(null);
  const q = useQuery(
    trpc.analytics.occupancy.queryOptions({ vesselId, from, days }, { placeholderData: (p) => p }),
  );
  const n = (v: number) => formatNumber(v, locale);
  const data = q.data;
  const sailingName = (s: {
    code: string | null;
    nameEn: string | null;
    nameAr: string | null;
    nights: number;
  }) => (isArabic ? s.nameAr : s.nameEn) ?? s.code ?? t('nightsN', { n: n(s.nights) });
  const current = selected ?? data?.sailings[0]?.sailingId ?? null;

  return (
    <div className={cx('flex flex-col gap-4', q.isFetching && 'opacity-70')}>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('from')}>
          <Input
            type="date"
            value={from}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
          />
        </Field>
        <div className="flex gap-1 pb-1">
          {[30, 60, 90].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={cx(
                'rounded-full px-3 py-1 text-sm',
                days === d ? 'bg-brand text-brand-ink' : 'border border-line',
              )}
            >
              {t('daysN', { n: n(d) })}
            </button>
          ))}
        </div>
      </div>

      {!data ? (
        <Empty>{t('loading')}</Empty>
      ) : data.sailings.length === 0 ? (
        <Empty>{t('noSailings')}</Empty>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <Card title={t('byCategory')}>
              <ShareBars
                rows={data.categories.map((c) => ({
                  key: c.categoryId,
                  label: isArabic ? c.nameAr : c.nameEn,
                  share: share(c.bookedNights, c.saleNights) ?? 0,
                  detail: t('cabinNights', { booked: n(c.bookedNights), sale: n(c.saleNights) }),
                }))}
                format={(v) => pct(v)}
              />
            </Card>
            <PaceCard sailingId={current} sailings={data.sailings} name={sailingName} />
          </div>

          <Card title={t('heatTitle')}>
            <p className="mb-3 text-xs text-muted">{t('heatHelp')}</p>
            <HeatMap
              rows={data.sailings.map((s) => ({
                key: s.sailingId,
                label: `${formatDate(s.embarkDate, locale)} · ${sailingName(s)}`,
              }))}
              columns={data.categories.map((c) => ({
                key: c.categoryId,
                label: c.code,
                title: isArabic ? c.nameAr : c.nameEn,
              }))}
              cell={(row, column) => {
                const c = data.cells.find((x) => x.sailingId === row && x.categoryId === column);
                const value = c ? share(c.bookedNights, c.saleNights) : null;
                return {
                  share: value,
                  detail: c
                    ? `${pct(value)} · ${t('cabinNights', { booked: n(c.bookedNights), sale: n(c.saleNights) })}`
                    : '—',
                };
              }}
              format={(v) => pct(v)}
            />
          </Card>

          <Card title={t('sailings')}>
            <Table
              head={[
                t('embark'),
                t('itinerary'),
                t('vessel'),
                t('cabinsBooked'),
                t('held'),
                t('occupancy'),
                ...(canMoney ? [t('value')] : []),
              ]}
            >
              {data.sailings.map((s) => (
                <tr
                  key={s.sailingId}
                  onClick={() => setSelected(s.sailingId)}
                  className={cx(
                    'cursor-pointer hover:bg-line/30',
                    s.sailingId === current && 'bg-line/40',
                  )}
                >
                  <Td>{formatDate(s.embarkDate, locale)}</Td>
                  <Td>{sailingName(s)}</Td>
                  <Td>{s.vessel}</Td>
                  <Td className="tabular-nums">{n(s.cabins)}</Td>
                  <Td className="tabular-nums">{n(s.held)}</Td>
                  <Td className="tabular-nums">{pct(share(s.bookedNights, s.saleNights))}</Td>
                  {canMoney && (
                    <Td className="tabular-nums">
                      {(s.value ?? []).map((m) => (
                        <div key={m.currency}>{formatMoney(m.total, m.currency, locale)}</div>
                      ))}
                    </Td>
                  )}
                </tr>
              ))}
            </Table>
            <p className="mt-2 text-xs text-muted">{t('help_sailingOccupancy')}</p>
          </Card>
        </>
      )}
    </div>
  );
}

function PaceCard({
  sailingId,
  sailings,
  name,
}: {
  sailingId: string | null;
  sailings: {
    sailingId: string;
    embarkDate: string;
    code: string | null;
    nameEn: string | null;
    nameAr: string | null;
    nights: number;
  }[];
  name: (s: {
    code: string | null;
    nameEn: string | null;
    nameAr: string | null;
    nights: number;
  }) => string;
}) {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const trpc = useTRPC();
  const q = useQuery(
    trpc.analytics.pace.queryOptions(
      { sailingId: sailingId ?? '' },
      { enabled: sailingId !== null, placeholderData: (p) => p },
    ),
  );
  const sailing = sailings.find((s) => s.sailingId === sailingId);
  const n = (v: number) => formatNumber(v, locale);
  const series = [
    {
      name: t('thisSailing'),
      color: 'var(--color-chart-1)',
      points: (q.data?.current ?? []).map((p) => ({
        x: p.daysBefore,
        y: p.cabins,
        estimated: p.reconstructed,
      })),
    },
    ...(q.data?.lastYear.length
      ? [
          {
            name: t('sameDateLastYear'),
            color: 'var(--color-chart-2)',
            points: q.data.lastYear.map((p) => ({
              x: p.daysBefore,
              y: p.cabins,
              estimated: p.reconstructed,
            })),
          },
        ]
      : []),
  ];
  return (
    <Card
      title={
        sailing ? (
          <span>
            {t('paceTitle')} · {formatDate(sailing.embarkDate, locale)} · {name(sailing)}
          </span>
        ) : (
          t('paceTitle')
        )
      }
    >
      <LineChart
        series={series}
        xLabel={t('daysBefore')}
        format={n}
        formatX={(x) => (x === 0 ? t('departure') : t('daysN', { n: n(x) }))}
        empty={t('paceEmpty')}
      />
      <p className="mt-2 text-xs text-muted">
        {q.data?.lastYearDate
          ? t('paceCompared', { date: formatDate(q.data.lastYearDate, locale) })
          : t('paceNoLastYear')}
        {q.data?.current.some((p) => p.reconstructed) && ` ${t('estimatedNote')}`}
      </p>
    </Card>
  );
}
