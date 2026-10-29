'use client';

import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Card, Empty, Input, Select, Table, Td, cx } from '../../../components/ui';
import { formatDate, formatMoney, formatNumber } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';
import { ExportButton, FilterField } from './analytics-breakdowns';

const BUCKETS = ['overdue', 'weeks1_4', 'weeks5_8', 'weeks9_12', 'later'] as const;

const cairoToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Analytics A2.1: cash — what came in against what fell due, what is still to be paid and when,
 * and what is held for sailings still to come. Owners and finance only; per currency.
 */
export function CashTab({ vesselId }: { vesselId: string | null }) {
  const t = useTranslations('analytics');
  const tr = useTranslations('receipts');
  const locale = useLocale();
  const trpc = useTRPC();
  const today = cairoToday();
  const [period, setPeriod] = useState({ from: addDays(today, -89), to: today });
  const [grain, setGrain] = useState<'day' | 'week' | 'month'>('week');
  const filter = { ...period, grain, vesselId };
  const report = useQuery(trpc.analytics.cash.queryOptions(filter));
  const m = (amount: bigint, currency: string) =>
    amount === 0n ? '—' : formatMoney(amount, currency, locale);
  const presets = [
    { key: 'last30', from: addDays(today, -29), to: today },
    { key: 'last90', from: addDays(today, -89), to: today },
    { key: 'last365', from: addDays(today, -364), to: today },
  ];
  const d = report.data;
  // Collected against due, per currency, over the period.
  const totals = new Map<string, { net: bigint; due: bigint }>();
  for (const r of d?.cashIn ?? []) {
    const x = totals.get(r.currency) ?? { net: 0n, due: 0n };
    x.net += r.net;
    x.due += r.due;
    totals.set(r.currency, x);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <FilterField label={t('from')}>
          <Input
            type="date"
            value={period.from}
            onChange={(e) => e.target.value && setPeriod({ ...period, from: e.target.value })}
          />
        </FilterField>
        <FilterField label={t('to')}>
          <Input
            type="date"
            value={period.to}
            onChange={(e) => e.target.value && setPeriod({ ...period, to: e.target.value })}
          />
        </FilterField>
        <div className="flex gap-1 pb-1">
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPeriod({ from: p.from, to: p.to })}
              className={cx(
                'rounded-full px-3 py-1 text-sm',
                period.from === p.from && period.to === p.to
                  ? 'bg-brand text-brand-ink'
                  : 'border border-line',
              )}
            >
              {t(`preset_${p.key}`)}
            </button>
          ))}
        </div>
        <FilterField label={t('cash_grain')}>
          <Select value={grain} onChange={(e) => setGrain(e.target.value as typeof grain)}>
            {(['day', 'week', 'month'] as const).map((g) => (
              <option key={g} value={g}>
                {t(`cash_grain_${g}`)}
              </option>
            ))}
          </Select>
        </FilterField>
        <div className="ms-auto">
          <ExportButton
            input={{
              report: 'cash',
              locale: locale.startsWith('ar') ? 'ar' : 'en',
              filter,
            }}
          />
        </div>
      </div>

      {!d ? (
        <Empty>{t('loading')}</Empty>
      ) : (
        <>
          <Card title={t('cash_in')}>
            <p className="mb-3 text-sm text-muted">{t('cash_inHelp')}</p>
            {totals.size > 0 && (
              <div className="mb-4 flex flex-wrap gap-6">
                {[...totals].map(([currency, x]) => (
                  <div key={currency}>
                    <div className="text-xs text-muted">
                      {t('cash_collectedOfDue', { currency })}
                    </div>
                    <div className="text-xl font-semibold tabular-nums">
                      {formatMoney(x.net, currency, locale)}
                      <span className="text-sm font-normal text-muted">
                        {' '}
                        / {formatMoney(x.due, currency, locale)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {d.cashIn.length === 0 ? (
              <Empty>{t('nothing')}</Empty>
            ) : (
              <Table
                head={[
                  t('cash_period'),
                  t('cash_currency'),
                  t('cash_received'),
                  t('cash_refunded'),
                  t('cash_reversed'),
                  t('cash_net'),
                  t('cash_due'),
                ]}
              >
                {d.cashIn.map((r) => (
                  <tr key={`${r.period}-${r.currency}`}>
                    <Td className="whitespace-nowrap">
                      {grain === 'month'
                        ? new Intl.DateTimeFormat(locale.startsWith('ar') ? 'ar-EG' : 'en-GB', {
                            month: 'long',
                            year: 'numeric',
                            timeZone: 'UTC',
                          }).format(new Date(`${r.period}T00:00:00Z`))
                        : formatDate(r.period, locale)}
                    </Td>
                    <Td>{r.currency}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{m(r.received, r.currency)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{m(r.refunded, r.currency)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{m(r.reversed, r.currency)}</Td>
                    <Td className="whitespace-nowrap font-medium tabular-nums">
                      {m(r.net, r.currency)}
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">{m(r.due, r.currency)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title={t('cash_forecast')}>
            <p className="mb-3 text-sm text-muted">{t('cash_forecastHelp')}</p>
            {d.forecast.length === 0 ? (
              <Empty>{t('cash_nothingDue')}</Empty>
            ) : (
              <Table
                head={[
                  t('cash_currency'),
                  ...BUCKETS.map((b) => t(`cash_${b}`)),
                  t('cash_uninvoicedCredit'),
                ]}
              >
                {d.forecast.map((f) => (
                  <tr key={f.currency}>
                    <Td>{f.currency}</Td>
                    {BUCKETS.map((b) => (
                      <Td
                        key={b}
                        className={cx(
                          'whitespace-nowrap tabular-nums',
                          b === 'overdue' && f.buckets[b] > 0n && 'text-bad',
                        )}
                      >
                        {m(f.buckets[b], f.currency)}
                      </Td>
                    ))}
                    <Td className="whitespace-nowrap tabular-nums">
                      {m(f.uninvoicedCredit, f.currency)}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t('cash_byMethod')}>
              {d.byMethod.length === 0 ? (
                <Empty>{t('nothing')}</Empty>
              ) : (
                <Table
                  head={[t('cash_method'), t('cash_currency'), t('cash_receipts'), t('cash_net')]}
                >
                  {d.byMethod.map((x) => (
                    <tr key={`${x.method}-${x.currency}`}>
                      <Td>{tr(`method_${x.method as 'cash'}`)}</Td>
                      <Td>{x.currency}</Td>
                      <Td className="tabular-nums">{x.receipts}</Td>
                      <Td className="whitespace-nowrap tabular-nums">{m(x.net, x.currency)}</Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title={t('cash_held')}>
              <p className="mb-3 text-sm text-muted">{t('cash_heldHelp')}</p>
              {d.held.length === 0 && d.unapplied.length === 0 ? (
                <Empty>{t('nothing')}</Empty>
              ) : (
                <Table
                  head={[
                    t('cash_sailingMonth'),
                    t('cash_currency'),
                    t('cash_bookings'),
                    t('cash_paid'),
                    t('cash_outstanding'),
                  ]}
                >
                  {d.held.map((h) => (
                    <tr key={`${h.month}-${h.currency}`}>
                      <Td className="whitespace-nowrap">
                        {new Intl.DateTimeFormat(locale.startsWith('ar') ? 'ar-EG' : 'en-GB', {
                          month: 'long',
                          year: 'numeric',
                          timeZone: 'UTC',
                        }).format(new Date(`${h.month}-01T00:00:00Z`))}
                      </Td>
                      <Td>{h.currency}</Td>
                      <Td className="tabular-nums">{h.bookings}</Td>
                      <Td className="whitespace-nowrap font-medium tabular-nums">
                        {m(h.paid, h.currency)}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {m(h.outstanding, h.currency)}
                      </Td>
                    </tr>
                  ))}
                  {d.unapplied.map((u) => (
                    <tr key={`unapplied-${u.currency}`} className="text-muted">
                      <Td>{t('cash_unapplied')}</Td>
                      <Td>{u.currency}</Td>
                      <Td />
                      <Td className="whitespace-nowrap tabular-nums">{m(u.amount, u.currency)}</Td>
                      <Td />
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Analytics A2.2: revenue by sailing or booking month, what leaks, currency exposure and the
 * base-currency view. Owners and finance only; per currency, the base view names its rates.
 */
export function RevenueTab({ vesselId }: { vesselId: string | null }) {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const trpc = useTRPC();
  const today = cairoToday();
  const [basis, setBasis] = useState<'sailing' | 'booked'>('sailing');
  const [period, setPeriod] = useState({ from: today, to: addDays(today, 89) });
  const [groupBy, setGroupBy] = useState<'vessel' | 'channel' | 'market'>('channel');
  const filter = { basis, ...period, groupBy, vesselId };
  const report = useQuery(trpc.analytics.revenue.queryOptions(filter));
  const m = (amount: bigint, currency: string) =>
    amount === 0n ? '—' : formatMoney(amount, currency, locale);
  const monthName = (month: string) =>
    new Intl.DateTimeFormat(locale.startsWith('ar') ? 'ar-EG' : 'en-GB', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${month}-01T00:00:00Z`));
  const presets =
    basis === 'booked'
      ? [
          { key: 'last30', from: addDays(today, -29), to: today },
          { key: 'last90', from: addDays(today, -89), to: today },
          { key: 'last365', from: addDays(today, -364), to: today },
        ]
      : [
          { key: 'next30', from: today, to: addDays(today, 29) },
          { key: 'next90', from: today, to: addDays(today, 89) },
          { key: 'last90', from: addDays(today, -89), to: today },
        ];
  const d = report.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <FilterField label={t('basis')}>
          <Select
            value={basis}
            onChange={(e) => {
              const next = e.target.value as 'sailing' | 'booked';
              setBasis(next);
              setPeriod(
                next === 'sailing'
                  ? { from: today, to: addDays(today, 89) }
                  : { from: addDays(today, -89), to: today },
              );
            }}
          >
            <option value="sailing">{t('basis_sailing')}</option>
            <option value="booked">{t('basis_booked')}</option>
          </Select>
        </FilterField>
        <FilterField label={t('from')}>
          <Input
            type="date"
            value={period.from}
            onChange={(e) => e.target.value && setPeriod({ ...period, from: e.target.value })}
          />
        </FilterField>
        <FilterField label={t('to')}>
          <Input
            type="date"
            value={period.to}
            onChange={(e) => e.target.value && setPeriod({ ...period, to: e.target.value })}
          />
        </FilterField>
        <div className="flex gap-1 pb-1">
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPeriod({ from: p.from, to: p.to })}
              className={cx(
                'rounded-full px-3 py-1 text-sm',
                period.from === p.from && period.to === p.to
                  ? 'bg-brand text-brand-ink'
                  : 'border border-line',
              )}
            >
              {t(`preset_${p.key}`)}
            </button>
          ))}
        </div>
        <FilterField label={t('rev_groupBy')}>
          <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}>
            {(['vessel', 'channel', 'market'] as const).map((g) => (
              <option key={g} value={g}>
                {t(`rev_by_${g}`)}
              </option>
            ))}
          </Select>
        </FilterField>
        <div className="ms-auto">
          <ExportButton
            input={{ report: 'revenue', locale: locale.startsWith('ar') ? 'ar' : 'en', filter }}
          />
        </div>
      </div>

      {!d ? (
        <Empty>{t('loading')}</Empty>
      ) : (
        <>
          <Card title={t('rev_title')}>
            <p className="mb-3 text-sm text-muted">{t('rev_help')}</p>
            {d.rows.length === 0 ? (
              <Empty>{t('nothing')}</Empty>
            ) : (
              <Table
                head={[
                  t('rev_month'),
                  t(`rev_by_${groupBy}`),
                  t('cash_currency'),
                  t('cash_bookings'),
                  t('rev_booked'),
                  t('rev_commission'),
                  t('rev_net'),
                  t('rev_invoiced'),
                  t('rev_uninvoiced'),
                ]}
              >
                {d.rows.map((r) => (
                  <tr key={`${r.month}-${r.group}-${r.currency}`}>
                    <Td className="whitespace-nowrap">{monthName(r.month)}</Td>
                    <Td>{r.group}</Td>
                    <Td>{r.currency}</Td>
                    <Td className="tabular-nums">{r.bookings}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{m(r.booked, r.currency)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">
                      {m(r.commission, r.currency)}
                    </Td>
                    <Td className="whitespace-nowrap font-medium tabular-nums">
                      {m(r.net, r.currency)}
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">{m(r.invoiced, r.currency)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">
                      {m(r.uninvoiced, r.currency)}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title={t('rev_base', { currency: d.base.currency })}>
            <p className="mb-3 text-sm text-muted">{t('rev_baseHelp')}</p>
            <div className="mb-3 flex flex-wrap gap-6">
              <div>
                <div className="text-xs text-muted">{t('rev_booked')}</div>
                <div className="text-xl font-semibold tabular-nums">
                  {formatMoney(d.base.booked, d.base.currency, locale)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted">{t('rev_invoiced')}</div>
                <div className="text-xl font-semibold tabular-nums">
                  {formatMoney(d.base.invoiced, d.base.currency, locale)}
                </div>
              </div>
            </div>
            <ul className="text-sm text-muted">
              {d.base.rates.map((r) => (
                <li key={`${r.source}-${r.currency}`} dir="auto">
                  1 {r.currency} = <span dir="ltr">{r.rate}</span> {d.base.currency} ·{' '}
                  {t(`rev_rate_${r.source}`)}
                  {r.date && ` (${formatDate(r.date, locale)})`}
                </li>
              ))}
              {d.base.missing.map((c) => (
                <li key={`missing-${c}`} className="text-bad">
                  {t('rev_noRate', { currency: c })}
                </li>
              ))}
            </ul>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t('rev_leakage')}>
              <p className="mb-3 text-sm text-muted">{t('rev_leakageHelp')}</p>
              {d.leakage.length === 0 ? (
                <Empty>{t('nothing')}</Empty>
              ) : (
                <Table
                  head={[
                    t('cash_currency'),
                    t('rev_commission'),
                    t('rev_refunds'),
                    t('rev_penalties'),
                    t('rev_fees'),
                    t('rev_discounts'),
                  ]}
                >
                  {d.leakage.map((l) => (
                    <tr key={l.currency}>
                      <Td>{l.currency}</Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {m(l.commission, l.currency)}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">{m(l.refunds, l.currency)}</Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {m(l.penaltiesKept, l.currency)}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {m(l.amendmentFees, l.currency)}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {m(l.discounts, l.currency)}
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            <Card title={t('rev_exposure')}>
              <p className="mb-3 text-sm text-muted">{t('rev_exposureHelp')}</p>
              {d.exposure.length === 0 ? (
                <Empty>{t('nothing')}</Empty>
              ) : (
                <Table
                  head={[
                    t('cash_currency'),
                    t('rev_toSail'),
                    t('rev_paid'),
                    t('rev_due'),
                    t('rev_openInvoices'),
                    t('cash_unapplied'),
                  ]}
                >
                  {d.exposure.map((e) => (
                    <tr key={e.currency}>
                      <Td>{e.currency}</Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {m(e.futureBooked, e.currency)}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {m(e.futurePaid, e.currency)}
                      </Td>
                      <Td className="whitespace-nowrap font-medium tabular-nums">
                        {m(e.futureDue, e.currency)}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {m(e.openInvoices, e.currency)}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {m(e.unapplied, e.currency)}
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

const AGING = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;

/**
 * Analytics A2.3: what each agency and guest owes by how late it is, how fast each pays, and
 * credit used against each agency's limit. Owners and finance only.
 */
export function ReceivablesTab() {
  const t = useTranslations('analytics');
  const tr = useTranslations('receivables');
  const locale = useLocale();
  const trpc = useTRPC();
  const [days, setDays] = useState(365);
  const report = useQuery(trpc.analytics.receivables.queryOptions({ days }));
  const m = (amount: bigint, currency: string) =>
    amount === 0n ? '—' : formatMoney(amount, currency, locale);
  const pct = (share: number | null) =>
    share === null
      ? '—'
      : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(share);
  const d = report.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <FilterField label={t('recv_window')}>
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[90, 180, 365, 730].map((n) => (
              <option key={n} value={n}>
                {t('recv_days', { n: formatNumber(n, locale) })}
              </option>
            ))}
          </Select>
        </FilterField>
        <div className="ms-auto">
          <ExportButton
            input={{
              report: 'receivables',
              locale: locale.startsWith('ar') ? 'ar' : 'en',
              filter: { days },
            }}
          />
        </div>
      </div>
      {!d ? (
        <Empty>{t('loading')}</Empty>
      ) : (
        <>
          <Card title={t('recv_title')}>
            <p className="mb-3 text-sm text-muted">{t('recv_help')}</p>
            {d.rows.length === 0 ? (
              <Empty>{t('nothing')}</Empty>
            ) : (
              <Table
                head={[
                  t('recv_party'),
                  t('cash_currency'),
                  ...AGING.map((b) => tr(`bucket_${b}`)),
                  t('recv_unapplied'),
                  t('recv_avgDays'),
                  t('recv_onTime'),
                ]}
              >
                {d.rows.map((r) => (
                  <tr key={`${r.partyId}-${r.currency}`}>
                    <Td>
                      <a href={`/invoices/statements?party=${r.partyId}`} className="text-brand">
                        {r.party}
                      </a>
                    </Td>
                    <Td>{r.currency}</Td>
                    {AGING.map((b) => (
                      <Td
                        key={b}
                        className={cx(
                          'whitespace-nowrap tabular-nums',
                          b !== 'current' && r.buckets[b] > 0n && 'text-bad',
                        )}
                      >
                        {m(r.buckets[b], r.currency)}
                      </Td>
                    ))}
                    <Td className="whitespace-nowrap tabular-nums">{m(r.unapplied, r.currency)}</Td>
                    <Td className="tabular-nums">
                      {r.averageDaysToPay === null
                        ? '—'
                        : t('recv_daysValue', { n: formatNumber(r.averageDaysToPay, locale) })}
                    </Td>
                    <Td className="tabular-nums">{pct(r.paidOnTimeShare)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title={t('recv_credit')}>
            <p className="mb-3 text-sm text-muted">{t('recv_creditHelp')}</p>
            {d.credit.length === 0 ? (
              <Empty>{t('nothing')}</Empty>
            ) : (
              <ul className="flex flex-col gap-3">
                {d.credit.map((c) => {
                  const used = c.usedShare ?? 0;
                  return (
                    <li
                      key={c.channelId}
                      className="grid grid-cols-[minmax(8rem,14rem)_1fr] items-center gap-3 text-sm"
                    >
                      <span className="truncate" title={c.channel}>
                        {c.channel}
                      </span>
                      <span className="flex flex-col gap-1">
                        <span className="h-3 rounded-full bg-line/50">
                          <span
                            className="block h-3 rounded-full"
                            style={{
                              width: `${Math.min(100, Math.max(0, used * 100))}%`,
                              background:
                                used > 1
                                  ? 'var(--color-bad)'
                                  : used > 0.8
                                    ? 'var(--color-warn)'
                                    : 'var(--color-chart-1)',
                            }}
                          />
                        </span>
                        {c.currency && c.limit !== null && (
                          <span className="text-xs text-muted">
                            {t('recv_creditLine', {
                              exposure: formatMoney(c.exposure, c.currency, locale),
                              limit: formatMoney(c.limit, c.currency, locale),
                              used: pct(c.usedShare),
                            })}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
