'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Select,
  cx,
} from '../../../components/ui';
import { addDaysIso, cairoTodayIso, parseAges } from '../../../lib/dates';
import { useErrorText } from '../../../lib/errors';
import { usePriceLineLabel } from '../../../lib/price-lines';
import { formatDate, formatMoney } from '../../../lib/format';
import { newRequestKey, useTRPC } from '../../../lib/trpc';
import { useMarkets } from '../../../lib/markets';

interface Category {
  id: string;
  code: string;
  name_en: string;
  name_ar: string;
  max_adults: number;
  max_occupancy: number;
}
interface Vessel {
  id: string;
  name: string;
  categories: Category[];
}
interface CabinDraft {
  categoryId: string;
  adults: number;
  ages: string;
}

const WINDOW_DAYS = 21;

export function BookForm({ vessels, canBook }: { vessels: Vessel[]; canBook: boolean }) {
  const t = useTranslations('book');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const errorText = useErrorText();
  const lineLabel = usePriceLineLabel();

  const [vesselId, setVesselId] = useState(vessels[0]?.id ?? '');
  const vessel = vessels.find((v) => v.id === vesselId);
  const [channelId, setChannelId] = useState('');
  const [market, setMarket] = useState('');
  const { markets, name: marketName } = useMarkets();
  const [from, setFrom] = useState(() => cairoTodayIso());
  const [sailingId, setSailingId] = useState('');
  const [pattern, setPattern] = useState('');
  const [cabins, setCabins] = useState<CabinDraft[]>(() => [
    { categoryId: vessels[0]?.categories[0]?.id ?? '', adults: 2, ages: '' },
  ]);
  const [guest, setGuest] = useState({
    firstName: '',
    lastName: '',
    nationality: '',
    channelRef: '',
  });

  const channels = useQuery(
    trpc.book.channels.queryOptions({ vesselId }, { enabled: Boolean(vesselId) }),
  );
  const channel = channels.data?.find((c) => c.id === channelId);
  useEffect(() => {
    const first = channels.data?.[0];
    if (first && !channels.data!.some((c) => c.id === channelId)) setChannelId(first.id);
  }, [channels.data, channelId]);
  useEffect(() => {
    if (channel && !channel.markets.includes(market))
      setMarket(
        channel.markets.includes('international') ? 'international' : (channel.markets[0] ?? ''),
      );
  }, [channel, market]);

  const to = addDaysIso(from, WINDOW_DAYS);
  const availability = useQuery(
    trpc.book.availability.queryOptions(
      { channelId, vesselId, from, to },
      { enabled: Boolean(channelId && vesselId) },
    ),
  );

  const parsedCabins = cabins.map((c) => ({
    categoryId: c.categoryId,
    adults: c.adults,
    childAges: parseAges(c.ages),
  }));
  const cabinsValid = parsedCabins.every((c) => c.childAges !== null && c.categoryId);
  const pricingInput = {
    channelId,
    sailingId,
    market,
    cabins: parsedCabins.map((c) => ({ ...c, childAges: c.childAges ?? [] })),
  };
  const price = useQuery(
    trpc.book.price.queryOptions(pricingInput, {
      enabled: Boolean(channelId && sailingId && market && cabinsValid),
      retry: false,
    }),
  );

  // Needed cabins per category, to grey out sailings that cannot take this party.
  const needed = new Map<string, number>();
  for (const c of cabins) needed.set(c.categoryId, (needed.get(c.categoryId) ?? 0) + 1);

  const guestInput = [
    {
      cabin: 0,
      firstName: guest.firstName,
      lastName: guest.lastName,
      nationality: guest.nationality ? guest.nationality.toUpperCase() : undefined,
      lead: true,
    },
  ];
  const submission = JSON.stringify([pricingInput, guestInput, guest.channelRef]);
  // Same form contents → same key: a double click or a retry returns the same booking.
  const requestKey = useMemo(() => newRequestKey(), [submission]);

  const create = useMutation(
    trpc.book.create.mutationOptions({
      onSuccess: (result) => router.push(`/bookings/${result.ref}`),
    }),
  );
  const selected = availability.data?.sailings.find((s) => s.sailingId === sailingId);
  const onRequest = selected?.categories.some(
    (c) => needed.has(c.categoryId) && c.status === 'on_request',
  );
  const ready =
    canBook &&
    price.isSuccess &&
    guest.firstName.trim() &&
    guest.lastName.trim() &&
    !create.isPending;

  const categoryName = (c: Category) => (locale.startsWith('ar') ? c.name_ar : c.name_en);
  const marketLabel = marketName;
  const needsProof = markets.find((m) => m.code === market)?.needsResidencyProof;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <div className="grid gap-3 sm:grid-cols-3">
            {vessels.length > 1 && (
              <Field label={t('vessel')}>
                <Select value={vesselId} onChange={(e) => setVesselId(e.target.value)}>
                  {vessels.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={t('channel')}>
              <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                {channels.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.type === 'back_office' ? t('direct') : c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('market')}>
              <Select value={market} onChange={(e) => setMarket(e.target.value)}>
                {channel?.markets.map((m) => (
                  <option key={m} value={m}>
                    {marketLabel(m)}
                  </option>
                ))}
              </Select>
              {needsProof && <span className="text-xs text-muted">{t('needsProof')}</span>}
            </Field>
          </div>
        </Card>

        <Card title={t('cabins')}>
          <div className="flex flex-col gap-3">
            {cabins.map((cabin, i) => {
              const category = vessel?.categories.find((c) => c.id === cabin.categoryId);
              const ages = parsedCabins[i]!.childAges;
              return (
                <div
                  key={i}
                  className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2 sm:grid-cols-[minmax(0,2fr)_5rem_minmax(0,1.5fr)_auto] sm:items-end"
                >
                  <Field label={`${t('perCabin', { n: i + 1 })} · ${t('category')}`}>
                    <Select
                      value={cabin.categoryId}
                      onChange={(e) =>
                        setCabins(
                          cabins.map((c, j) =>
                            j === i ? { ...c, categoryId: e.target.value } : c,
                          ),
                        )
                      }
                    >
                      {vessel?.categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} · {categoryName(c)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={tc('adults')}>
                    <Select
                      value={cabin.adults}
                      onChange={(e) =>
                        setCabins(
                          cabins.map((c, j) =>
                            j === i ? { ...c, adults: Number(e.target.value) } : c,
                          ),
                        )
                      }
                    >
                      {Array.from({ length: category?.max_adults ?? 3 }, (_, n) => n + 1).map(
                        (n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ),
                      )}
                    </Select>
                  </Field>
                  <Field label={tc('childAges')} error={ages === null ? t('agesHint') : undefined}>
                    <Input
                      inputMode="numeric"
                      placeholder="4, 8"
                      value={cabin.ages}
                      onChange={(e) =>
                        setCabins(
                          cabins.map((c, j) => (j === i ? { ...c, ages: e.target.value } : c)),
                        )
                      }
                    />
                  </Field>
                  {cabins.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setCabins(cabins.filter((_, j) => j !== i))}
                    >
                      {t('removeCabin')}
                    </Button>
                  )}
                </div>
              );
            })}
            <div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setCabins([...cabins, { ...cabins.at(-1)!, ages: '' }])}
                disabled={cabins.length >= 20}
              >
                + {t('addCabin')}
              </Button>
            </div>
          </div>
        </Card>

        <Card
          title={t('sailings')}
          actions={
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setFrom(addDaysIso(from, -WINDOW_DAYS))}
              >
                {t('earlier')}
              </Button>
              <Input
                type="date"
                value={from}
                onChange={(e) => e.target.value && setFrom(e.target.value)}
                className="w-40"
                aria-label={t('dates')}
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => setFrom(addDaysIso(from, WINDOW_DAYS))}
              >
                {t('later')}
              </Button>
            </div>
          }
        >
          {availability.isLoading ? (
            <Empty>{tc('loading')}</Empty>
          ) : !availability.data?.sailings.length ? (
            <Empty>{t('noSailings')}</Empty>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap gap-1">
                {['', ...new Set(availability.data.sailings.map((s) => s.patternCode ?? ''))].map(
                  (code) => (
                    <button
                      key={code || 'all'}
                      type="button"
                      onClick={() => setPattern(code)}
                      className={cx(
                        'rounded-full px-3 py-1 text-sm',
                        pattern === code ? 'bg-brand text-brand-ink' : 'border border-line',
                      )}
                    >
                      <span dir="ltr">{code || t('allItineraries')}</span>
                    </button>
                  ),
                )}
              </div>
              <ul className="grid gap-2 sm:grid-cols-2">
                {availability.data.sailings
                  .filter((s) => !pattern || s.patternCode === pattern)
                  .map((s) => {
                    const enough = [...needed].every(([categoryId, n]) => {
                      const c = s.categories.find((x) => x.categoryId === categoryId);
                      return c && (c.status === 'on_request' || c.free >= n);
                    });
                    return (
                      <li key={s.sailingId}>
                        <button
                          type="button"
                          disabled={!enough}
                          onClick={() => {
                            setSailingId(s.sailingId);
                            // On a phone the summary sits below the list: bring it into view.
                            if (window.innerWidth < 1024)
                              document
                                .getElementById('book-summary')
                                ?.scrollIntoView({ behavior: 'smooth' });
                          }}
                          className={cx(
                            'w-full rounded-lg border p-3 text-start text-sm transition disabled:opacity-40',
                            s.sailingId === sailingId
                              ? 'border-brand ring-2 ring-brand/20'
                              : 'border-line hover:border-brand',
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">
                              {formatDate(s.embarkDate, locale, 'long')} –{' '}
                              {formatDate(s.disembarkDate, locale)}
                            </span>
                            <span className="text-xs text-muted">
                              {s.patternCode} · {tc('nights', { n: s.nights })}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {s.categories
                              .filter((c) => needed.has(c.categoryId))
                              .map((c) => (
                                <Badge
                                  key={c.categoryId}
                                  tone={
                                    c.status === 'sold_out'
                                      ? 'bad'
                                      : c.status === 'on_request'
                                        ? 'warn'
                                        : 'ok'
                                  }
                                >
                                  {c.code}{' '}
                                  {c.status === 'sold_out'
                                    ? t('soldOut')
                                    : c.status === 'on_request'
                                      ? t('onRequest')
                                      : t('free', { n: c.free })}
                                </Badge>
                              ))}
                          </div>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </>
          )}
        </Card>
      </div>

      <form
        id="book-summary"
        className="flex scroll-mt-16 flex-col gap-4 lg:sticky lg:top-16 lg:self-start"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          create.mutate({
            ...pricingInput,
            guests: guestInput,
            channelRef: guest.channelRef.trim() || undefined,
            requestKey,
          });
        }}
      >
        <Card title={t('guest')}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('firstName')}>
              <Input
                required
                autoComplete="off"
                value={guest.firstName}
                onChange={(e) => setGuest({ ...guest, firstName: e.target.value })}
              />
            </Field>
            <Field label={t('lastName')}>
              <Input
                required
                autoComplete="off"
                value={guest.lastName}
                onChange={(e) => setGuest({ ...guest, lastName: e.target.value })}
              />
            </Field>
            <Field label={t('nationality')}>
              <Input
                maxLength={2}
                dir="ltr"
                className="uppercase"
                value={guest.nationality}
                onChange={(e) =>
                  setGuest({ ...guest, nationality: e.target.value.replace(/[^a-z]/gi, '') })
                }
              />
            </Field>
            {channel?.type !== 'back_office' && (
              <Field label={t('channelRef')}>
                <Input
                  dir="ltr"
                  value={guest.channelRef}
                  onChange={(e) => setGuest({ ...guest, channelRef: e.target.value })}
                />
              </Field>
            )}
          </div>
        </Card>

        <Card>
          {!sailingId ? (
            <p className="text-sm text-muted">{t('pickSailing')}</p>
          ) : price.isLoading ? (
            <p className="text-sm text-muted">{t('pricing')}</p>
          ) : price.isError ? (
            <Alert tone="bad">{errorText(price.error)}</Alert>
          ) : price.data ? (
            <div className="flex flex-col gap-2">
              <ul className="flex flex-col gap-1 text-sm">
                {price.data.lines
                  .filter((l) => l.inTotal)
                  .map((l, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="min-w-0 truncate text-muted">
                        {t('perCabin', { n: l.cabin + 1 })} · {lineLabel(l)}
                        {l.quantity > 1 ? ` × ${l.quantity}` : ''}
                      </span>
                      <span className="tabular-nums">
                        {formatMoney(l.amount, price.data.currency, locale)}
                      </span>
                    </li>
                  ))}
              </ul>
              <div className="flex items-baseline justify-between border-t border-line pt-2">
                <span className="text-sm">
                  {t('totalFor', { cabins: tc('cabins', { n: cabins.length }) })}
                </span>
                <span className="text-lg font-semibold tabular-nums">
                  {formatMoney(price.data.total, price.data.currency, locale)}
                </span>
              </div>
            </div>
          ) : null}
          {create.isError && (
            <div className="mt-3">
              <Alert tone="bad">{errorText(create.error)}</Alert>
            </div>
          )}
          {!canBook && (
            <div className="mt-3">
              <Alert tone="warn">{tc('notAllowed')}</Alert>
            </div>
          )}
          <Button type="submit" className="mt-3 w-full" disabled={!ready}>
            {create.isPending ? t('booking') : onRequest ? t('request') : t('confirm')}
          </Button>
        </Card>
      </form>
    </div>
  );
}
