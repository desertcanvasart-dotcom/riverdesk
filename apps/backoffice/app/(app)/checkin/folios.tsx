'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, Plus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Dialog } from '../../../components/dialog';
import { Alert, Badge, Button, Empty, Field, Input, Select, cx } from '../../../components/ui';
import { useErrorText } from '../../../lib/errors';
import { formatDateTime, formatMoney, formatNumber, parseMoney } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';

/**
 * Folios (E1): every cabin aboard the departure with what it has spent; tap one to add a charge
 * from the price list or void one. Made for a phone at the bar or the reception.
 */
export function Folios({ legId, canWrite }: { legId: string; canWrite: boolean }) {
  const t = useTranslations('folios');
  const locale = useLocale();
  const trpc = useTRPC();
  const data = useQuery(trpc.folios.departure.queryOptions({ legId }, { refetchInterval: 30_000 }));
  const [open, setOpen] = useState<string | null>(null);
  if (data.isLoading) return <Empty>{t('loading')}</Empty>;
  if (!data.data) return null;
  const { enabled, currency, cabins, total } = data.data;
  if (!enabled) return <Empty>{t('off')}</Empty>;
  const cabin = cabins.find((c) => c.bookingCabinId === open);

  return (
    <>
      <p className="text-sm">
        <span className="text-muted">{t('departureTotal')}: </span>
        <span className="font-semibold tabular-nums">{formatMoney(total, currency, locale)}</span>
      </p>
      {cabins.length === 0 ? (
        <Empty>{t('nobody')}</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {cabins.map((c) => (
            <button
              key={c.bookingCabinId}
              type="button"
              onClick={() => setOpen(c.bookingCabinId)}
              className="min-h-20 rounded-xl border border-line bg-surface p-3 text-start hover:bg-line/30"
            >
              <div className="text-xl font-bold tabular-nums" dir="ltr">
                {c.cabin ?? '—'}
              </div>
              <div className="truncate text-xs text-muted">{c.guests.join(', ') || c.ref}</div>
              <div className="mt-1 text-sm tabular-nums">
                {c.folio && c.folio.total !== 0n ? (
                  formatMoney(c.folio.total, currency, locale)
                ) : (
                  <span className="text-muted">{t('nothingYet')}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
      {cabin && (
        <FolioDialog
          legId={legId}
          cabin={cabin}
          currency={currency}
          items={data.data.items}
          canWrite={canWrite}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

type Item = {
  id: string;
  category: string;
  nameAr: string;
  nameEn: string;
  price: bigint;
};

function FolioDialog({
  legId,
  cabin,
  currency,
  items,
  canWrite,
  onClose,
}: {
  legId: string;
  cabin: { bookingCabinId: string; cabin: string | null; ref: string; guests: string[] };
  currency: string;
  items: Item[];
  canWrite: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('folios');
  const locale = useLocale();
  const isArabic = locale.startsWith('ar');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const input = { legId, bookingCabinId: cabin.bookingCabinId };
  const folio = useQuery(trpc.folios.get.queryOptions(input));
  const done = (data: unknown) => {
    queryClient.setQueryData(trpc.folios.get.queryKey(input), data as never);
    void queryClient.invalidateQueries({ queryKey: trpc.folios.departure.queryKey({ legId }) });
  };
  const post = useMutation(
    trpc.folios.post.mutationOptions({
      onSuccess: (data) => {
        done(data);
        setItem(null);
        setQuantity(1);
        setManual({ description: '', amount: '' });
      },
    }),
  );
  const voidIt = useMutation(
    trpc.folios.void.mutationOptions({
      onSuccess: (data) => {
        done(data);
        setVoiding(null);
        setReason('');
      },
    }),
  );
  const categories = [...new Set(items.map((i) => i.category))];
  const [category, setCategory] = useState<string>(categories[0] ?? 'manual');
  const [item, setItem] = useState<Item | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [guest, setGuest] = useState('');
  const [manual, setManual] = useState({ description: '', amount: '' });
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const manualAmount = parseMoney(manual.amount, currency);
  const name = (x: { nameAr: string; nameEn: string }) => (isArabic ? x.nameAr : x.nameEn);
  const error = post.error ?? voidIt.error;

  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={
        <span>
          {t('folioOf')} <span dir="ltr">{cabin.cabin ?? cabin.ref}</span>
        </span>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{cabin.guests.join(', ')}</p>
        {error && <Alert tone="bad">{errorText(error)}</Alert>}

        {canWrite && (
          <section className="flex flex-col gap-3 rounded-xl border border-line p-3">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {[...categories, 'manual'].map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setCategory(c);
                    setItem(null);
                  }}
                  className={cx(
                    'min-h-10 shrink-0 rounded-lg border px-3 text-sm',
                    c === category ? 'border-brand bg-brand/5' : 'border-line',
                  )}
                >
                  {t(c === 'manual' ? 'manual' : `cat_${c}`)}
                </button>
              ))}
            </div>
            {category === 'manual' ? (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <Field label={t('description')}>
                  <Input
                    value={manual.description}
                    onChange={(e) => setManual({ ...manual, description: e.target.value })}
                  />
                </Field>
                <Field label={`${t('price')} (${currency})`}>
                  <Input
                    inputMode="decimal"
                    dir="ltr"
                    value={manual.amount}
                    onChange={(e) => setManual({ ...manual, amount: e.target.value })}
                  />
                </Field>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {items
                  .filter((i) => i.category === category)
                  .map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      onClick={() => setItem(i)}
                      aria-pressed={item?.id === i.id}
                      className={cx(
                        'min-h-14 rounded-lg border p-2 text-start text-sm',
                        item?.id === i.id ? 'border-brand bg-brand/5' : 'border-line',
                      )}
                    >
                      <div className="font-medium">{name(i)}</div>
                      <div className="text-xs text-muted tabular-nums">
                        {formatMoney(i.price, currency, locale)}
                      </div>
                    </button>
                  ))}
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  aria-label={t('less')}
                  disabled={quantity <= 1}
                  onClick={() => setQuantity(quantity - 1)}
                >
                  <Minus aria-hidden className="size-4" />
                </Button>
                <span className="w-8 text-center text-lg font-semibold tabular-nums">
                  {formatNumber(quantity, locale)}
                </span>
                <Button
                  variant="secondary"
                  aria-label={t('more')}
                  disabled={quantity >= 99}
                  onClick={() => setQuantity(quantity + 1)}
                >
                  <Plus aria-hidden className="size-4" />
                </Button>
              </div>
              {cabin.guests.length > 1 && (
                <Field label={t('guest')}>
                  <Select value={guest} onChange={(e) => setGuest(e.target.value)}>
                    <option value="">{t('wholeCabin')}</option>
                    {cabin.guests.map((g) => (
                      <option key={g}>{g}</option>
                    ))}
                  </Select>
                </Field>
              )}
              <Button
                className="min-h-11 flex-1"
                disabled={
                  post.isPending ||
                  (category === 'manual'
                    ? !manual.description.trim() || manualAmount === null
                    : !item)
                }
                onClick={() =>
                  post.mutate({
                    ...input,
                    quantity,
                    ...(guest ? { guestName: guest } : {}),
                    ...(category === 'manual'
                      ? {
                          manual: {
                            category: 'other',
                            description: manual.description.trim(),
                            unitAmount: manualAmount!,
                          },
                        }
                      : { itemId: item!.id }),
                  })
                }
              >
                {t('post')}
                {category !== 'manual' &&
                  item &&
                  ` · ${formatMoney(item.price * BigInt(quantity), currency, locale)}`}
              </Button>
            </div>
          </section>
        )}

        {!folio.data?.charges.length ? (
          <Empty>{t('nothingYet')}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {folio.data.charges.map((c) => (
              <li key={c.id} className="flex flex-col gap-1 py-2 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className={cx(c.voided && 'text-muted line-through')}>
                    <span className="font-medium">
                      {formatNumber(c.quantity, locale)} ×{' '}
                      {isArabic ? c.descriptionAr : c.descriptionEn}
                    </span>
                    {c.guestName && <span className="text-xs text-muted"> · {c.guestName}</span>}
                    <div className="text-xs text-muted">
                      {formatDateTime(c.postedAt, locale)}
                      {c.postedBy && ` · ${c.postedBy}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cx('tabular-nums', c.voided && 'text-muted line-through')}>
                      {formatMoney(c.amount, currency, locale)}
                    </span>
                    {canWrite && !c.voided && (
                      <Button variant="ghost" onClick={() => setVoiding(c.id)}>
                        {t('void')}
                      </Button>
                    )}
                  </div>
                </div>
                {c.voided && (
                  <Badge tone="warn">
                    {t('voided')}: {c.voided.reason}
                  </Badge>
                )}
                {voiding === c.id && (
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label={t('voidReason')}>
                      <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                    </Field>
                    <Button
                      disabled={!reason.trim() || voidIt.isPending}
                      onClick={() => voidIt.mutate({ ...input, chargeId: c.id, reason })}
                    >
                      {t('confirmVoid')}
                    </Button>
                    <Button variant="ghost" onClick={() => setVoiding(null)}>
                      {t('keep')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between border-t border-line pt-3 text-base font-semibold">
          <span>{t('total')}</span>
          <span className="tabular-nums">
            {formatMoney(folio.data?.total ?? 0n, currency, locale)}
          </span>
        </div>
      </div>
    </Dialog>
  );
}
