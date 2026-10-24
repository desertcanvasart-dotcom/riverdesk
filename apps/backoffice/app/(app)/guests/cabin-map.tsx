'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Empty, cx } from '../../../components/ui';
import { useErrorText } from '../../../lib/errors';
import { useTRPC } from '../../../lib/trpc';

type State = 'free' | 'occupied' | 'blocked' | 'out_of_service';

const TILE: Record<State, string> = {
  free: 'border-line bg-surface',
  occupied: 'border-brand/40 bg-brand/10',
  blocked: 'border-bad/40 bg-bad-bg',
  out_of_service: 'border-dashed border-line bg-line/30 opacity-60',
};

/**
 * One departure's cabins, deck by deck. Pick a party (a cabin with guests, or one waiting for a
 * cabin), then a highlighted cabin to move it there. Sales stay by category; this only decides
 * who sleeps where.
 */
export function CabinMap({
  legId,
  canAssign,
  onChanged,
}: {
  legId: string;
  canAssign: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('cabinMap');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const map = useQuery(trpc.guests.cabinMap.queryOptions({ legId }));
  const [picked, setPicked] = useState<string | null>(null);
  const options = useQuery(
    trpc.guests.cabinOptions.queryOptions(
      { bookingCabinId: picked ?? '' },
      { enabled: canAssign && picked !== null },
    ),
  );
  const assign = useMutation(
    trpc.guests.assign.mutationOptions({
      onSuccess: () => {
        setPicked(null);
        void map.refetch();
        // Which cabins fit a party changes with every move: never reuse an old answer.
        void queryClient.invalidateQueries({ queryKey: trpc.guests.cabinOptions.queryKey() });
        onChanged();
      },
    }),
  );
  const data = map.data;
  if (map.isLoading || !data) return <Empty>{tc('loading')}</Empty>;
  if (data.cabins.length === 0) return <Empty>{t('noCabins')}</Empty>;

  const allowed = new Set((options.data ?? []).filter((o) => !o.current).map((o) => o.id));
  const pickedParty =
    data.cabins.find((c) => c.party?.bookingCabinId === picked)?.party ??
    data.unassigned.find((p) => p.bookingCabinId === picked) ??
    null;
  // Decks in the order of their cabin numbers (Main 1xx, Upper 2xx, Sun 3xx), not by name.
  const lowest = new Map<string, number>();
  for (const c of data.cabins) {
    const n = Number.parseInt(c.number.replace(/\D/g, ''), 10);
    const deck = c.deck ?? '';
    if (!Number.isNaN(n)) lowest.set(deck, Math.min(lowest.get(deck) ?? n, n));
  }
  const decks = [...new Set(data.cabins.map((c) => c.deck ?? ''))].sort(
    (a, b) => (lowest.get(a) ?? Infinity) - (lowest.get(b) ?? Infinity) || a.localeCompare(b),
  );
  const categoryName = (c: { nameEn: string; nameAr: string }) =>
    locale.startsWith('ar') ? c.nameAr : c.nameEn;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2 text-xs">
        {(['free', 'occupied', 'blocked', 'out_of_service'] as const).map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className={cx('inline-block size-3 rounded border', TILE[s])} />
            {t(`state.${s}`)}
          </span>
        ))}
      </div>
      {data.counts.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {data.counts.map((c) => (
            <li key={c.categoryId}>
              <span className="font-medium text-ink" dir="ltr">
                {c.code}
              </span>{' '}
              {t('count', { free: c.free, held: c.held, booked: c.booked })}
            </li>
          ))}
        </ul>
      )}

      {data.unassigned.length > 0 && (
        <div className="rounded-lg border border-warn/40 bg-warn-bg p-3 text-sm">
          <p className="mb-2 font-medium">{t('waiting', { n: data.unassigned.length })}</p>
          <ul className="flex flex-wrap gap-2">
            {data.unassigned.map((p) => (
              <li key={p.bookingCabinId}>
                <button
                  type="button"
                  disabled={!canAssign}
                  onClick={() => setPicked(picked === p.bookingCabinId ? null : p.bookingCabinId)}
                  className={cx(
                    'rounded-lg border bg-surface px-2 py-1 text-start',
                    picked === p.bookingCabinId
                      ? 'border-brand ring-2 ring-brand/30'
                      : 'border-line',
                  )}
                >
                  <span className="font-medium" dir="ltr">
                    {p.ref}
                  </span>{' '}
                  · {p.category.code} · {p.lead ?? t('noName')} ({p.guests})
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pickedParty && (
        <div className="sticky top-14 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-brand/40 bg-surface p-2 text-sm shadow">
          <span className="min-w-0 flex-1">
            {t('moving', { ref: pickedParty.ref, name: pickedParty.lead ?? t('noName') })}{' '}
            <span className="text-muted">
              {options.isLoading ? tc('loading') : t('choices', { n: allowed.size })}
            </span>
          </span>
          {data.cabins.some((c) => c.party?.bookingCabinId === picked) && (
            <Button
              variant="ghost"
              disabled={assign.isPending}
              onClick={() => assign.mutate({ bookingCabinId: picked!, cabinId: null })}
            >
              {t('unassign')}
            </Button>
          )}
          <Button variant="secondary" onClick={() => setPicked(null)}>
            {tc('close')}
          </Button>
        </div>
      )}
      {assign.isError && <Alert tone="bad">{errorText(assign.error)}</Alert>}

      {decks.map((deck) => (
        <section key={deck}>
          <h3 className="mb-2 text-sm font-semibold">{deck || t('noDeck')}</h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
            {data.cabins
              .filter((c) => (c.deck ?? '') === deck)
              .map((c) => {
                const target = picked !== null && allowed.has(c.id);
                const mine = c.party !== null && c.party.bookingCabinId === picked;
                const clickable =
                  canAssign && (target || (c.state === 'occupied' && picked === null) || mine);
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      disabled={!clickable || assign.isPending}
                      title={
                        c.state === 'blocked'
                          ? (c.blockReason ?? '')
                          : c.category
                            ? categoryName(c.category)
                            : t('state.out_of_service')
                      }
                      onClick={() => {
                        if (target) assign.mutate({ bookingCabinId: picked!, cabinId: c.id });
                        else if (c.party) setPicked(mine ? null : c.party.bookingCabinId);
                      }}
                      className={cx(
                        'flex h-full min-h-20 w-full flex-col items-start rounded-lg border p-2 text-start text-xs',
                        TILE[c.state],
                        target && 'ring-2 ring-ok',
                        mine && 'ring-2 ring-brand',
                        picked !== null && !target && !mine && 'opacity-50',
                        clickable && 'hover:border-brand',
                      )}
                    >
                      <span className="flex w-full items-center justify-between gap-1">
                        <span className="text-base font-semibold" dir="ltr">
                          {c.number}
                        </span>
                        <span className="text-muted">
                          {c.accessible && '♿ '}
                          {c.category?.code ?? '—'}
                        </span>
                      </span>
                      {c.party ? (
                        <>
                          <span className="mt-1 w-full truncate font-medium">
                            {c.party.lead ?? t('noName')}
                          </span>
                          <span className="text-muted">
                            {t('guests', { n: c.party.guests })}
                            {c.party.boardedEarlier && ` · ${t('boardedEarlier')}`}
                            {c.party.staysLonger && ` · ${t('staysLonger')}`}
                          </span>
                        </>
                      ) : c.state === 'blocked' ? (
                        <span className="mt-1 w-full truncate text-bad">{c.blockReason}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}

      {pickedParty && (
        <p className="text-xs text-muted">
          <Link href={`/bookings/${pickedParty.ref}`} className="text-brand">
            {t('openBooking', { ref: pickedParty.ref })}
          </Link>
        </p>
      )}
      {!canAssign && <Badge tone="neutral">{t('readOnly')}</Badge>}
    </div>
  );
}
