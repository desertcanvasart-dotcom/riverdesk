'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, Plus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Dialog } from '../../../components/dialog';
import { DocumentButtons } from '../../../components/documents';
import { Alert, Badge, Button, Empty, Field, Input, Select, cx } from '../../../components/ui';
import { useErrorText } from '../../../lib/errors';
import {
  formatDateTime,
  formatMoney,
  formatNumber,
  minorToInput,
  parseMoney,
} from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';

const cairoToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());

/**
 * Folios (E1–E2): every cabin aboard the departure with what it has spent; tap one to add a
 * charge from the price list or void one, then close it (its invoice) and take payment at
 * reception. Made for a phone at the bar or the reception.
 */
export function Folios({
  legId,
  canWrite,
  canSettle,
}: {
  legId: string;
  canWrite: boolean;
  canSettle: boolean;
}) {
  const td = useTranslations('documents');
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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm">
          <span className="text-muted">{t('departureTotal')}: </span>
          <span className="font-semibold tabular-nums">{formatMoney(total, currency, locale)}</span>
        </p>
        {canSettle && (
          <DocumentButtons
            items={[
              {
                key: 'shift',
                label: td('folio_shift_report'),
                input: {
                  kind: 'folio_shift_report',
                  vesselId: data.data.vesselId,
                  date: cairoToday(),
                  format: 'pdf',
                },
              },
              {
                key: 'shift-xlsx',
                label: `${td('folio_shift_report')} · Excel`,
                input: {
                  kind: 'folio_shift_report',
                  vesselId: data.data.vesselId,
                  date: cairoToday(),
                  format: 'xlsx',
                },
              },
            ]}
          />
        )}
      </div>
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
              <div className="flex items-start justify-between gap-1">
                <span className="text-xl font-bold tabular-nums" dir="ltr">
                  {c.cabin ?? '—'}
                </span>
                {c.folio?.status === 'closed' ? (
                  <Badge tone={c.folio.balance ? 'warn' : 'ok'}>
                    {c.folio.balance ? t('toPay') : t('paid')}
                  </Badge>
                ) : (
                  c.leaving && <Badge tone="info">{t('leaving')}</Badge>
                )}
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
          canSettle={canSettle}
          baseCurrency={data.data.baseCurrency}
          lastRate={data.data.lastRate}
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
  canSettle,
  baseCurrency,
  lastRate,
  onClose,
}: {
  legId: string;
  cabin: { bookingCabinId: string; cabin: string | null; ref: string; guests: string[] };
  currency: string;
  items: Item[];
  canWrite: boolean;
  canSettle: boolean;
  baseCurrency: string;
  lastRate: string | null;
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
  const open = !folio.data?.folio || folio.data.folio.status === 'open';

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

        {canWrite && open && (
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
                    {canWrite && open && !c.voided && (
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
        {folio.data?.folio && (
          <Settle
            legId={legId}
            bookingCabinId={cabin.bookingCabinId}
            detail={folio.data}
            canSettle={canSettle}
            baseCurrency={baseCurrency}
            lastRate={lastRate}
            onDone={done}
          />
        )}
      </div>
    </Dialog>
  );
}

type Detail = {
  folio: {
    id: string;
    status: 'open' | 'closed' | 'void';
    billTo: 'guest' | 'agency';
    invoice: {
      id: string;
      number: string;
      total: bigint;
      balance: bigint;
      party: string;
    } | null;
  } | null;
  currency: string;
  total: bigint;
  agency: { name: string; allowed: boolean } | null;
};

/**
 * Closing (the folio's invoice, to the guest or the agency) and payment at reception, then the
 * guest's folio to print.
 */
function Settle({
  legId,
  bookingCabinId,
  detail,
  canSettle,
  baseCurrency,
  lastRate,
  onDone,
}: {
  legId: string;
  bookingCabinId: string;
  detail: Detail;
  canSettle: boolean;
  baseCurrency: string;
  lastRate: string | null;
  onDone: (data: unknown) => void;
}) {
  const t = useTranslations('folios');
  const td = useTranslations('documents');
  const locale = useLocale();
  const trpc = useTRPC();
  const errorText = useErrorText();
  const folio = detail.folio!;
  const currency = detail.currency;
  const input = { legId, bookingCabinId };
  const [billTo, setBillTo] = useState<'guest' | 'agency'>('guest');
  const [rate, setRate] = useState(lastRate ?? '');
  const [pay, setPay] = useState({
    amount: folio.invoice ? minorToInput(folio.invoice.balance, currency) : '',
    currency,
    method: 'cash' as 'cash' | 'card',
    rate: lastRate ?? '',
  });
  const close = useMutation(trpc.folios.close.mutationOptions({ onSuccess: onDone }));
  const take = useMutation(
    trpc.folios.pay.mutationOptions({
      onSuccess: (data) => {
        onDone(data);
        const left = (data as Detail).folio?.invoice?.balance ?? 0n;
        setPay((p) => ({ ...p, amount: minorToInput(left, currency), currency }));
      },
    }),
  );
  // Once closed, the payment starts at what is still to pay.
  const balance = folio.invoice?.balance;
  useEffect(() => {
    if (balance !== undefined)
      setPay((p) => ({ ...p, amount: minorToInput(balance, currency), currency }));
  }, [folio.invoice?.id]);
  const needsRate = currency !== baseCurrency;
  const paidAmount = parseMoney(pay.amount, pay.currency);
  const otherCurrency = pay.currency !== currency;
  const error = close.error ?? take.error;
  const invoice = folio.invoice;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line p-3">
      {error && <Alert tone="bad">{errorText(error)}</Alert>}
      {folio.status === 'open' && canSettle && detail.total > 0n && (
        <div className="flex flex-wrap items-end gap-3">
          {detail.agency?.allowed && (
            <Field label={t('billTo')}>
              <Select
                value={billTo}
                onChange={(e) => setBillTo(e.target.value as 'guest' | 'agency')}
              >
                <option value="guest">{t('billGuest')}</option>
                <option value="agency">{detail.agency.name}</option>
              </Select>
            </Field>
          )}
          {needsRate && (
            <Field label={t('invoiceRate', { from: currency, to: baseCurrency })}>
              <Input
                inputMode="decimal"
                dir="ltr"
                value={rate}
                onChange={(e) => setRate(e.target.value.trim())}
                className="w-32"
              />
            </Field>
          )}
          <Button
            className="min-h-11 flex-1"
            disabled={close.isPending || (needsRate && !rate)}
            onClick={() =>
              close.mutate({ ...input, billTo, ...(needsRate ? { fxRate: rate } : {}) })
            }
          >
            {t('close')}
          </Button>
        </div>
      )}
      {folio.status === 'void' && <p className="text-sm text-muted">{t('voidFolio')}</p>}
      {invoice && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            {t('closedInto')} <span dir="ltr">{invoice.number}</span> · {invoice.party}
          </span>
          <Badge tone={invoice.balance > 0n ? 'warn' : 'ok'}>
            {invoice.balance > 0n
              ? `${t('toPay')} ${formatMoney(invoice.balance, currency, locale)}`
              : t('paid')}
          </Badge>
        </p>
      )}
      {invoice && folio.billTo === 'guest' && invoice.balance > 0n && canSettle && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('amount')}>
            <Input
              inputMode="decimal"
              dir="ltr"
              value={pay.amount}
              onChange={(e) => setPay({ ...pay, amount: e.target.value })}
              className="w-32"
            />
          </Field>
          <Field label={t('currency')}>
            <Select
              value={pay.currency}
              onChange={(e) => setPay({ ...pay, currency: e.target.value })}
            >
              {[...new Set([currency, baseCurrency])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          {otherCurrency && (
            <Field label={t('payRate', { from: currency, to: pay.currency })}>
              <Input
                inputMode="decimal"
                dir="ltr"
                value={pay.rate}
                onChange={(e) => setPay({ ...pay, rate: e.target.value.trim() })}
                className="w-28"
              />
            </Field>
          )}
          <Field label={t('method')}>
            <Select
              value={pay.method}
              onChange={(e) => setPay({ ...pay, method: e.target.value as 'cash' | 'card' })}
            >
              <option value="cash">{t('cash')}</option>
              <option value="card">{t('card')}</option>
            </Select>
          </Field>
          <Button
            className="min-h-11 flex-1"
            disabled={take.isPending || paidAmount === null || (otherCurrency && !pay.rate)}
            onClick={() =>
              take.mutate({
                ...input,
                amount: paidAmount!,
                currency: pay.currency,
                method: pay.method,
                ...(otherCurrency ? { fxRate: pay.rate } : {}),
              })
            }
          >
            {t('takePayment')}
          </Button>
        </div>
      )}
      {invoice &&
        invoice.balance > 0n &&
        otherCurrency &&
        paidAmount !== null &&
        Number(pay.rate) > 0 && (
          <p className="text-xs text-muted">
            {t('equals', {
              // A preview only (the folio currencies share two decimals); the engine converts.
              amount: formatMoney(
                BigInt(Math.round(Number(paidAmount) / Number(pay.rate))),
                currency,
                locale,
              ),
            })}
          </p>
        )}
      <DocumentButtons
        items={[
          {
            key: 'folio',
            label: td('guest_folio'),
            input: { kind: 'guest_folio', folioId: folio.id },
          },
        ]}
      />
    </section>
  );
}
