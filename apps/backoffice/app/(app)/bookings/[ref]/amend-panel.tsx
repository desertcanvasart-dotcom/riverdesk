'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Dialog } from '../../../../components/dialog';
import { Alert, Button, Field, Input, Select } from '../../../../components/ui';
import { addDaysIso, parseAges } from '../../../../lib/dates';
import { useErrorText } from '../../../../lib/errors';
import { formatDate, formatMoney } from '../../../../lib/format';
import { newRequestKey, useTRPC } from '../../../../lib/trpc';

interface Category {
  id: string;
  code: string;
  name_en: string;
  name_ar: string;
  max_adults: number;
}

/** Change the sailing and/or cabins: price the change (with its fee) first, then apply it. */
export function AmendPanel({
  bookingId,
  revision,
  channelId,
  vesselId,
  categories,
  cabins: current,
  embarkDate,
}: {
  bookingId: string;
  revision: number;
  channelId: string;
  vesselId: string;
  categories: Category[];
  cabins: { categoryId: string; adults: number; childAges: number[] }[];
  embarkDate: string;
}) {
  const t = useTranslations('bookings');
  const tb = useTranslations('book');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [sailingId, setSailingId] = useState('');
  const [cabins, setCabins] = useState(() =>
    current.map((c) => ({
      categoryId: c.categoryId,
      adults: c.adults,
      ages: c.childAges.join(', '),
    })),
  );
  const availability = useQuery(
    trpc.book.availability.queryOptions(
      { channelId, vesselId, from: addDaysIso(embarkDate, -28), to: addDaysIso(embarkDate, 56) },
      { enabled: open },
    ),
  );
  const parsed = cabins.map((c) => ({
    categoryId: c.categoryId,
    adults: c.adults,
    childAges: parseAges(c.ages),
  }));
  const valid = parsed.every((c) => c.childAges !== null);
  const changedCabins = JSON.stringify(parsed) !== JSON.stringify(current);
  const input = {
    bookingId,
    sailingId: sailingId || undefined,
    cabins: changedCabins ? parsed.map((c) => ({ ...c, childAges: c.childAges ?? [] })) : undefined,
  };
  const quoteKey = useMemo(() => newRequestKey(), [JSON.stringify(input)]);
  const quote = useMutation(trpc.bookings.quoteAmendment.mutationOptions());
  const apply = useMutation(
    trpc.bookings.applyAmendment.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        quote.reset();
        router.refresh();
      },
    }),
  );
  const applyKey = useMemo(() => newRequestKey(), [quote.data]);
  const q = quote.data;

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('amend')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('amendTitle')}>
        <div className="flex flex-col gap-3">
          <Field label={t('newSailing')}>
            <Select
              value={sailingId}
              onChange={(e) => {
                setSailingId(e.target.value);
                quote.reset();
              }}
            >
              <option value="">{t('keepSailing')}</option>
              {availability.data?.sailings.map((s) => (
                <option key={s.sailingId} value={s.sailingId}>
                  {formatDate(s.embarkDate, locale, 'long')} · {s.patternCode} ·{' '}
                  {tc('nights', { n: s.nights })}
                </option>
              ))}
            </Select>
          </Field>
          {cabins.map((cabin, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_4.5rem_minmax(0,1fr)] gap-2">
              <Field label={tb('perCabin', { n: i + 1 })}>
                <Select
                  value={cabin.categoryId}
                  onChange={(e) => {
                    setCabins(
                      cabins.map((c, j) => (j === i ? { ...c, categoryId: e.target.value } : c)),
                    );
                    quote.reset();
                  }}
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={tc('adults')}>
                <Select
                  value={cabin.adults}
                  onChange={(e) => {
                    setCabins(
                      cabins.map((c, j) =>
                        j === i ? { ...c, adults: Number(e.target.value) } : c,
                      ),
                    );
                    quote.reset();
                  }}
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={tc('childAges')}>
                <Input
                  inputMode="numeric"
                  value={cabin.ages}
                  onChange={(e) => {
                    setCabins(cabins.map((c, j) => (j === i ? { ...c, ages: e.target.value } : c)));
                    quote.reset();
                  }}
                />
              </Field>
            </div>
          ))}
          {q && (
            <dl className="grid grid-cols-2 gap-y-1 rounded-lg bg-line/30 p-3 text-sm">
              <dt>{t('newTotal')}</dt>
              <dd className="text-end font-semibold tabular-nums">
                {formatMoney(q.quote.total, q.quote.currency, locale)}
              </dd>
              <dt>{t('difference')}</dt>
              <dd className="text-end tabular-nums">
                {formatMoney(q.difference, q.quote.currency, locale)}
              </dd>
              <dt>{t('amendFee')}</dt>
              <dd className="text-end tabular-nums">
                {formatMoney(q.fee, q.quote.currency, locale)}
              </dd>
            </dl>
          )}
          {(quote.isError || apply.isError) && (
            <Alert tone="bad">{errorText(quote.error ?? apply.error)}</Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {tc('close')}
            </Button>
            {!q ? (
              <Button
                type="button"
                disabled={!valid || (!sailingId && !changedCabins) || quote.isPending}
                onClick={() => quote.mutate({ ...input, requestKey: quoteKey })}
              >
                {!sailingId && !changedCabins ? t('nothingToChange') : t('priceChange')}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={apply.isPending}
                onClick={() =>
                  apply.mutate({
                    bookingId,
                    revision,
                    amendmentQuoteId: q.quote.id,
                    requestKey: applyKey,
                  })
                }
              >
                {t('applyChange')}
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
