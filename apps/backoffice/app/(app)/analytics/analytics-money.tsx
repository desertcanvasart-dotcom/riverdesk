'use client';

import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Card, Empty, Input, Select, Table, Td, cx } from '../../../components/ui';
import { formatDate, formatMoney } from '../../../lib/format';
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
