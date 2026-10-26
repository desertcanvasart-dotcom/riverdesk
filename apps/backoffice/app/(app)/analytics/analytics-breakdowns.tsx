'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';
import type { AnalyticsExportInput } from '@vs/engine';
import { ShareBars } from '../../../components/charts';
import { Alert, Button, Card, Empty, Table, Td, cx } from '../../../components/ui';
import { useErrorText } from '../../../lib/errors';
import { formatMoney, formatNumber } from '../../../lib/format';
import { useMarkets } from '../../../lib/markets';
import { useTRPC } from '../../../lib/trpc';

/** The filter the Channels and Booking behaviour tabs share (and their Excel exports). */
export interface BreakdownFilter {
  from: string;
  to: string;
  basis: 'booked' | 'sailing';
  vesselId: string | null;
  channelId: string | null;
  market: string | null;
  categoryId: string | null;
}

const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);

function usePercent() {
  const locale = useLocale();
  return (value: number | null) =>
    value === null
      ? '—'
      : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value);
}

function MoneyList({ items }: { items: { currency: string; amount: bigint }[] }) {
  const locale = useLocale();
  if (!items.length) return <>—</>;
  return (
    <>
      {items.map((m) => (
        <div key={m.currency}>{formatMoney(m.amount, m.currency, locale)}</div>
      ))}
    </>
  );
}

export function ChannelsTab({ filter, canMoney }: { filter: BreakdownFilter; canMoney: boolean }) {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const pct = usePercent();
  const trpc = useTRPC();
  const { name: marketName } = useMarkets();
  const q = useQuery(trpc.analytics.channels.queryOptions(filter, { placeholderData: (p) => p }));
  const n = (v: number) => formatNumber(v, locale);
  if (!q.data) return <Empty>{t('loading')}</Empty>;
  const d = q.data;
  const totalCabins = d.channels.reduce((s, c) => s + c.cabins, 0);
  const totalGuests = d.nationalities.reduce((s, x) => s + x.guests, 0);
  if (d.channels.length === 0 && d.allotments.length === 0) return <Empty>{t('nothing')}</Empty>;
  return (
    <div className={cx('flex flex-col gap-4', q.isFetching && 'opacity-70')}>
      <Card title={t('byChannel')}>
        <Table
          head={[
            t('channel'),
            t('bookingsCol'),
            t('cabinsCol'),
            t('shareCol'),
            t('cancelRate'),
            t('requestsCol'),
            ...(canMoney ? [t('value'), t('perNight')] : []),
          ]}
        >
          {d.channels.map((c) => (
            <tr key={c.channelId}>
              <Td>
                {c.name} <span className="text-xs text-muted">{t(`type_${c.type}`)}</span>
              </Td>
              <Td className="tabular-nums">{n(c.bookings)}</Td>
              <Td className="tabular-nums">
                {n(c.cabins)} <span className="text-xs text-muted">· {n(c.cabinNights)}</span>
              </Td>
              <Td className="tabular-nums">{pct(share(c.cabins, totalCabins))}</Td>
              <Td className="tabular-nums">{pct(share(c.cancelled, c.bookings))}</Td>
              <Td className="tabular-nums">
                {c.requests
                  ? t('requestsCell', {
                      received: n(c.requests.received),
                      converted: n(c.requests.converted),
                      minutes:
                        c.requests.medianMinutes === null ? '—' : n(c.requests.medianMinutes),
                    })
                  : '—'}
              </Td>
              {canMoney && (
                <>
                  <Td className="tabular-nums">
                    <MoneyList
                      items={(c.value ?? []).map((m) => ({
                        currency: m.currency,
                        amount: m.total,
                      }))}
                    />
                  </Td>
                  <Td className="tabular-nums">
                    <MoneyList
                      items={(c.value ?? [])
                        .filter((m) => m.cabinNights > 0)
                        .map((m) => ({
                          currency: m.currency,
                          amount: m.total / BigInt(m.cabinNights),
                        }))}
                    />
                  </Td>
                </>
              )}
            </tr>
          ))}
        </Table>
        <p className="mt-2 text-xs text-muted">{t('help_channels')}</p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('byMarket')}>
          <Table
            head={[
              t('market'),
              t('bookingsCol'),
              t('cabinsCol'),
              t('groupSize'),
              t('withChildren'),
              ...(canMoney ? [t('value')] : []),
            ]}
          >
            {d.markets.map((m) => (
              <tr key={m.market}>
                <Td>{marketName(m.market)}</Td>
                <Td className="tabular-nums">{n(m.bookings)}</Td>
                <Td className="tabular-nums">{n(m.cabins)}</Td>
                <Td className="tabular-nums">
                  {m.bookings
                    ? formatNumber(Math.round((m.guests / m.bookings) * 10) / 10, locale)
                    : '—'}
                </Td>
                <Td className="tabular-nums">{pct(share(m.withChildren, m.bookings))}</Td>
                {canMoney && (
                  <Td className="tabular-nums">
                    <MoneyList items={m.value ?? []} />
                  </Td>
                )}
              </tr>
            ))}
          </Table>
        </Card>
        <Card title={t('byNationality')}>
          {d.nationalities.length === 0 ? (
            <Empty>{t('nothing')}</Empty>
          ) : (
            <ShareBars
              rows={d.nationalities.slice(0, 10).map((x) => ({
                key: x.nationality ?? 'none',
                label: x.nationality
                  ? (new Intl.DisplayNames([locale], { type: 'region' }).of(x.nationality) ??
                    x.nationality)
                  : t('unknownNationality'),
                share: share(x.guests, totalGuests) ?? 0,
                detail: t('guestsBookings', { guests: n(x.guests), bookings: n(x.bookings) }),
              }))}
              format={(v) => pct(v)}
            />
          )}
        </Card>
      </div>

      <Card title={t('allotments')}>
        {d.allotments.length === 0 ? (
          <Empty>{t('noAllotments')}</Empty>
        ) : (
          <Table
            head={[
              t('agency'),
              t('allotted'),
              t('sold'),
              t('held'),
              t('releasedUnsold'),
              t('openUnsold'),
              t('sellThrough'),
            ]}
          >
            {d.allotments.map((a) => (
              <tr key={a.channelId}>
                <Td>{a.name}</Td>
                <Td className="tabular-nums">{n(a.allotted)}</Td>
                <Td className="tabular-nums">{n(a.sold)}</Td>
                <Td className="tabular-nums">{n(a.held)}</Td>
                <Td className="tabular-nums">{n(a.released)}</Td>
                <Td className="tabular-nums">{n(a.open ?? 0)}</Td>
                <Td className="tabular-nums">{pct(share(a.sold, a.allotted))}</Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-2 text-xs text-muted">{t('help_allotments')}</p>
      </Card>
    </div>
  );
}

export function BehaviourTab({ filter, canMoney }: { filter: BreakdownFilter; canMoney: boolean }) {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const isArabic = locale.startsWith('ar');
  const pct = usePercent();
  const trpc = useTRPC();
  const q = useQuery(trpc.analytics.behaviour.queryOptions(filter, { placeholderData: (p) => p }));
  const n = (v: number) => formatNumber(v, locale);
  if (!q.data) return <Empty>{t('loading')}</Empty>;
  const d = q.data;
  const windowTotal = d.bookingWindow.bands.reduce((s, b) => s + b.bookings, 0);
  const lengthTotal = d.lengths.reduce((s, l) => s + l.bookings, 0);
  const cancelTotal = d.cancellations.bands.reduce((s, b) => s + b.bookings, 0);
  // "0-7" → "0–7" days, "181+" → over 180 days, in the screen's digits.
  const band = (b: string) => {
    if (b.endsWith('+')) return t('bandOver', { n: n(Number(b.slice(0, -1)) - 1) });
    const [lo, hi] = b.split('-').map(Number) as [number, number];
    return t('band', { band: `${n(lo)}–${n(hi)}` });
  };
  if (windowTotal === 0 && d.holds.length === 0) return <Empty>{t('nothing')}</Empty>;
  return (
    <div className={cx('grid gap-4 lg:grid-cols-2', q.isFetching && 'opacity-70')}>
      <Card title={t('bookingWindow')}>
        <ShareBars
          rows={d.bookingWindow.bands.map((b) => ({
            key: b.band,
            label: band(b.band),
            share: share(b.bookings, windowTotal) ?? 0,
            detail: t('bookingsN', { n: n(b.bookings) }),
          }))}
          format={(v) => pct(v)}
        />
        <p className="mt-3 text-xs text-muted">
          {d.bookingWindow.median === null
            ? t('help_window')
            : t('windowStats', {
                median: n(d.bookingWindow.median),
                average: n(d.bookingWindow.average ?? 0),
              })}
        </p>
      </Card>
      <Card title={t('cruiseLength')}>
        <ShareBars
          rows={d.lengths.map((l) => ({
            key: String(l.nights),
            label: t('nightsN', { n: n(l.nights) }),
            share: share(l.bookings, lengthTotal) ?? 0,
            detail: t('bookingsCabins', { bookings: n(l.bookings), cabins: n(l.cabins) }),
          }))}
          format={(v) => pct(v)}
        />
        <h3 className="mt-5 mb-2 text-sm font-medium">{t('topItineraries')}</h3>
        <Table head={[t('itinerary'), t('bookingsCol'), t('cabinsCol')]}>
          {d.itineraries.map((i, k) => (
            <tr key={`${i.code}-${k}`}>
              <Td>
                {(isArabic ? i.nameAr : i.nameEn) ?? i.code ?? t('nightsN', { n: n(i.nights) })}
              </Td>
              <Td className="tabular-nums">{n(i.bookings)}</Td>
              <Td className="tabular-nums">{n(i.cabins)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title={t('holds')}>
        {d.holds.length === 0 ? (
          <Empty>{t('nothing')}</Empty>
        ) : (
          <Table
            head={[
              t('holdKind'),
              t('placed'),
              t('toBooking'),
              t('expired'),
              t('active'),
              t('avgHours'),
            ]}
          >
            {d.holds.map((h) => (
              <tr key={h.kind}>
                <Td>{t(`hold_${h.kind}`)}</Td>
                <Td className="tabular-nums">{n(h.placed)}</Td>
                <Td className="tabular-nums">{pct(share(h.confirmed, h.placed))}</Td>
                <Td className="tabular-nums">{n(h.expired)}</Td>
                <Td className="tabular-nums">{n(h.active)}</Td>
                <Td className="tabular-nums">
                  {h.averageHours === null ? '—' : formatNumber(h.averageHours, locale)}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-2 text-xs text-muted">{t('help_holds')}</p>
      </Card>
      <Card title={t('cancellationTiming')}>
        {cancelTotal === 0 ? (
          <Empty>{t('noCancellations')}</Empty>
        ) : (
          <ShareBars
            rows={d.cancellations.bands.map((b) => ({
              key: b.band,
              label: band(b.band),
              share: share(b.bookings, cancelTotal) ?? 0,
              detail: t('bookingsN', { n: n(b.bookings) }),
            }))}
            format={(v) => pct(v)}
          />
        )}
        {canMoney && d.cancellations.penalties && d.cancellations.penalties.length > 0 && (
          <p className="mt-3 text-sm">
            <span className="text-muted">{t('penaltiesKept')}: </span>
            {d.cancellations.penalties
              .map((p) => formatMoney(p.amount, p.currency, locale))
              .join(' · ')}
          </p>
        )}
      </Card>
      <Card title={t('amendments')} className="lg:col-span-2">
        <p className="text-sm">
          {t('amendmentsSummary', {
            amendments: n(d.amendments.amendments),
            bookings: n(d.amendments.bookings),
          })}
        </p>
        {d.amendments.changes.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-2 text-sm">
            {d.amendments.changes.map((c) => (
              <li key={c.change} className="rounded-full bg-line/40 px-3 py-1">
                {t(`change_${c.change}`)} · {n(c.amendments)}
              </li>
            ))}
          </ul>
        )}
        {canMoney && d.amendments.fees && d.amendments.fees.length > 0 && (
          <p className="mt-2 text-sm">
            <span className="text-muted">{t('feesCharged')}: </span>
            {d.amendments.fees.map((f) => formatMoney(f.amount, f.currency, locale)).join(' · ')}
          </p>
        )}
      </Card>
    </div>
  );
}

/** Asks the worker for the tab as an Excel file, waits for it, then downloads it. */
export function ExportButton({ input }: { input: AnalyticsExportInput }) {
  const t = useTranslations('analytics');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [documentId, setDocumentId] = useState<string | null>(null);
  const request = useMutation(
    trpc.analytics.export.mutationOptions({ onSuccess: (r) => setDocumentId(r.documentId) }),
  );
  const status = useQuery(
    trpc.documents.status.queryOptions(
      { documentId: documentId ?? '' },
      {
        enabled: documentId !== null,
        refetchInterval: (query) => (query.state.data?.status === 'pending' ? 1_000 : false),
      },
    ),
  );
  useEffect(() => {
    if (status.data?.status === 'ready' && documentId) {
      const link = document.createElement('a');
      link.href = `/api/documents/${documentId}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setDocumentId(null);
    }
  }, [status.data?.status, documentId]);
  const busy = request.isPending || (documentId !== null && status.data?.status !== 'failed');
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" disabled={busy} onClick={() => request.mutate(input)}>
        <Download aria-hidden className="size-4" />
        {busy ? t('preparing') : t('exportExcel')}
      </Button>
      {(request.isError || status.data?.status === 'failed') && (
        <Alert tone="bad">
          {request.isError ? errorText(request.error) : (status.data?.error ?? t('exportFailed'))}
        </Alert>
      )}
    </div>
  );
}

export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}
