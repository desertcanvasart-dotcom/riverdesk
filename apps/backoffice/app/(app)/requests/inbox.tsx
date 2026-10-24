'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '../../../components/dialog';
import { Alert, Badge, Button, Card, Empty, Field, Select } from '../../../components/ui';
import { addDaysIso } from '../../../lib/dates';
import { useErrorText } from '../../../lib/errors';
import { formatDate, formatDateTime, formatMoney } from '../../../lib/format';
import { statusTone } from '../../../lib/status';
import { newRequestKey, useTRPC } from '../../../lib/trpc';
import { ChoiceField } from '../../../components/choice-field';
import { useReasons } from '../../../lib/choices';

/** Ticks every 30 s so the SLA countdowns stay current. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function remaining(ms: number, locale: string) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const fmt = new Intl.NumberFormat(locale.startsWith('ar') ? 'ar-EG' : 'en-GB');
  return h > 0
    ? `${fmt.format(h)}:${fmt.format(m).padStart(2, fmt.format(0))}`
    : `${fmt.format(m)} min`;
}

export function RequestsInbox({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations('requests');
  const tc = useTranslations('common');
  const ts = useTranslations('status');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const now = useNow();
  const list = useQuery(trpc.requests.list.queryOptions(undefined, { refetchInterval: 60_000 }));
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.requests.list.queryKey() });
  const [notice, setNotice] = useState<string | null>(null);
  const accept = useMutation(
    trpc.requests.accept.mutationOptions({
      onSuccess: (r) => {
        setNotice(t('accepted', { ref: r.ref }));
        void refresh();
      },
    }),
  );
  const [declining, setDeclining] = useState<string | null>(null);
  const [offering, setOffering] = useState<(typeof rows)[number] | null>(null);
  const rows = list.data ?? [];

  if (list.isLoading) return <Empty>{tc('loading')}</Empty>;
  return (
    <div className="flex flex-col gap-3">
      {notice && <Alert tone="ok">{notice}</Alert>}
      {accept.isError && <Alert tone="bad">{errorText(accept.error)}</Alert>}
      {rows.length === 0 && (
        <Card>
          <Empty>{t('empty')}</Empty>
        </Card>
      )}
      {rows.map((r) => {
        const left = r.expiresAt ? new Date(r.expiresAt).getTime() - now : null;
        return (
          <Card key={r.bookingId}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={`/bookings/${r.ref}`} className="font-medium text-brand" dir="ltr">
                  {r.ref}
                </Link>
                <span className="ms-2 text-sm text-muted">{r.channel}</span>
                <p className="mt-1 text-sm">
                  {formatDate(r.embarkDate, locale, 'long')} · {r.patternCode} ·{' '}
                  {tc('nights', { n: r.nights })}
                </p>
                <p className="text-sm text-muted">
                  {r.cabins
                    .map(
                      (c) =>
                        `${c.code} ${c.adults}${c.childAges.length ? `+${c.childAges.join('/')}` : ''}`,
                    )
                    .join(' · ')}{' '}
                  · {formatMoney(r.total, r.currency, locale)}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Badge tone={statusTone(r.status)}>{ts(r.status)}</Badge>
                {r.status === 'requested' && left !== null && (
                  <Badge tone={left <= 0 ? 'bad' : left < 2 * 3_600_000 ? 'bad' : 'warn'}>
                    {left <= 0 ? t('overdue') : t('left', { time: remaining(left, locale) })}
                  </Badge>
                )}
              </div>
            </div>
            {r.offer && (
              <p className="mt-2 text-sm text-muted">
                {t('offerOpen', {
                  date: formatDate(r.offer.embarkDate, locale),
                  when: formatDateTime(r.offer.expiresAt, locale),
                })}
              </p>
            )}
            {canWrite && r.status === 'requested' && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  disabled={accept.isPending}
                  onClick={() =>
                    accept.mutate({ bookingId: r.bookingId, requestKey: `accept:${r.bookingId}` })
                  }
                >
                  {t('accept')}
                </Button>
                <Button variant="secondary" onClick={() => setOffering(r)}>
                  {t('offer')}
                </Button>
                <Button variant="ghost" onClick={() => setDeclining(r.bookingId)}>
                  {t('decline')}
                </Button>
              </div>
            )}
          </Card>
        );
      })}
      <DeclineDialog
        bookingId={declining}
        onClose={() => setDeclining(null)}
        onDone={() => {
          setNotice(t('declined'));
          void refresh();
        }}
      />
      <OfferDialog
        request={offering}
        onClose={() => setOffering(null)}
        onDone={() => {
          setNotice(t('offered'));
          void refresh();
        }}
      />
    </div>
  );
}

function DeclineDialog({
  bookingId,
  onClose,
  onDone,
}: {
  bookingId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('requests');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [reason, setReason] = useState('');
  const reasons = useReasons('decline');
  const decline = useMutation(
    trpc.requests.decline.mutationOptions({
      onSuccess: () => {
        setReason('');
        onClose();
        onDone();
      },
    }),
  );
  return (
    <Dialog open={bookingId !== null} onClose={onClose} title={t('decline')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (bookingId) decline.mutate({ bookingId, reason: reason.trim() });
        }}
      >
        <Field label={t('declineReason')}>
          <ChoiceField
            required
            allowEmpty={false}
            maxLength={500}
            choices={reasons}
            value={reason}
            onChange={setReason}
          />
        </Field>
        {decline.isError && <Alert tone="bad">{errorText(decline.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button type="submit" variant="danger" disabled={!reason.trim() || decline.isPending}>
            {t('decline')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface RequestRow {
  bookingId: string;
  ref: string;
  channelId: string;
  sailingId: string;
  vesselId: string;
  embarkDate: string;
  market: string;
  cabins: { categoryId: string; adults: number; childAges: number[] }[];
}

/** Offers the same cabins on another sailing; the agency accepts or lets it lapse. */
function OfferDialog({
  request,
  onClose,
  onDone,
}: {
  request: RequestRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('requests');
  const tb = useTranslations('book');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [sailingId, setSailingId] = useState('');
  const channelId = request?.channelId ?? '';
  const availability = useQuery(
    trpc.book.availability.queryOptions(
      {
        channelId,
        vesselId: request?.vesselId ?? '',
        from: addDaysIso(request?.embarkDate ?? '2000-01-01', -21),
        to: addDaysIso(request?.embarkDate ?? '2000-01-01', 42),
      },
      { enabled: Boolean(request && channelId) },
    ),
  );
  const requestKey = useMemo(() => newRequestKey(), [request, sailingId]);
  const offer = useMutation(
    trpc.requests.offer.mutationOptions({
      onSuccess: () => {
        setSailingId('');
        onClose();
        onDone();
      },
    }),
  );
  const needed = new Map<string, number>();
  for (const c of request?.cabins ?? [])
    needed.set(c.categoryId, (needed.get(c.categoryId) ?? 0) + 1);
  const options =
    availability.data?.sailings.filter(
      (s) =>
        s.sailingId !== request?.sailingId &&
        [...needed].every(([id, n]) => {
          const c = s.categories.find((x) => x.categoryId === id);
          return c && c.status !== 'sold_out' && c.free >= n;
        }),
    ) ?? [];
  return (
    <Dialog open={request !== null} onClose={onClose} title={t('offer')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!request || !sailingId) return;
          offer.mutate({
            bookingId: request.bookingId,
            channelId,
            sailingId,
            market: request.market,
            cabins: request.cabins.map((c) => ({
              categoryId: c.categoryId,
              adults: c.adults,
              childAges: c.childAges,
            })),
            requestKey,
          });
        }}
      >
        <Field label={tb('sailings')}>
          <Select required value={sailingId} onChange={(e) => setSailingId(e.target.value)}>
            <option value="" disabled>
              —
            </option>
            {options.map((s) => (
              <option key={s.sailingId} value={s.sailingId}>
                {formatDate(s.embarkDate, locale, 'long')} · {s.patternCode} ·{' '}
                {tc('nights', { n: s.nights })}
              </option>
            ))}
          </Select>
        </Field>
        {availability.isSuccess && options.length === 0 && (
          <Alert tone="warn">{tb('noSailings')}</Alert>
        )}
        {offer.isError && <Alert tone="bad">{errorText(offer.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button type="submit" disabled={!sailingId || offer.isPending}>
            {t('send')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
