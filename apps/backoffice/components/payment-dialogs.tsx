'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { cairoTodayIso } from '../lib/dates';
import { useErrorText } from '../lib/errors';
import { formatMoney, minorToInput, parseMoney } from '../lib/format';
import { newRequestKey, useTRPC } from '../lib/trpc';
import { Dialog } from './dialog';
import { Alert, Button, Field, Input, Select } from './ui';

export const METHODS = [
  'bank_transfer',
  'cash',
  'card_office',
  'agent_remittance',
  'channel',
  'gateway',
] as const;
import { CURRENCIES } from '@vs/shared/money';
import { ChoiceField } from './choice-field';
import { useReasons } from '../lib/choices';
import { AttachmentField, fileToAttachment } from './receipt-dialogs';

/** Finds a booking by reference when the dialog was not opened from one. */
function useBookingByRef(initialRef: string) {
  const trpc = useTRPC();
  const [ref, setRef] = useState(initialRef);
  const [lookup, setLookup] = useState(initialRef);
  const booking = useQuery(
    trpc.bookings.detail.queryOptions(
      { ref: lookup },
      { enabled: lookup.length > 0, retry: false },
    ),
  );
  return { ref, setRef, find: () => setLookup(ref.trim().toUpperCase()), booking };
}

export function RecordPaymentDialog({
  bookingRef = '',
  canAttach = true,
  onClose,
  onDone,
}: {
  bookingRef?: string;
  /** Receipts (and their files) are finance only; the payment itself needs finance too. */
  canAttach?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('payments');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const errorText = useErrorText();
  const { ref, setRef, find, booking } = useBookingByRef(bookingRef);
  const b = booking.data;
  const [form, setForm] = useState({
    kind: 'payment' as 'deposit' | 'balance' | 'payment',
    method: 'bank_transfer' as (typeof METHODS)[number],
    amount: '',
    currency: '',
    fxRate: '',
    reference: '',
    receivedOn: cairoTodayIso(),
  });
  const currency = form.currency || b?.currency || 'USD';
  const amount = parseMoney(form.amount, currency);
  const needsFx = b !== undefined && currency !== b.currency;
  const fxOk = !needsFx || /^\d+(\.\d{1,6})?$/.test(form.fxRate);
  const requestKey = useMemo(() => newRequestKey(), [JSON.stringify(form), b?.id]);
  const [file, setFile] = useState<File | null>(null);
  const attach = useMutation(trpc.receipts.attach.mutationOptions({ onSuccess: onDone }));
  const record = useMutation(
    trpc.payments.record.mutationOptions({
      // The photo or PDF goes on the receipt the payment created.
      onSuccess: async (result) => {
        if (!file) return onDone();
        attach.mutate({ receiptId: result.receiptId, attachment: await fileToAttachment(file) });
      },
    }),
  );
  return (
    <Dialog open onClose={onClose} title={t('record')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!b || amount === null || !fxOk) return;
          record.mutate({
            bookingId: b.id,
            kind: form.kind,
            method: form.method,
            amount,
            currency,
            fxRate: needsFx ? form.fxRate : undefined,
            reference: form.reference.trim(),
            receivedOn: form.receivedOn,
            requestKey,
          });
        }}
      >
        {!bookingRef && (
          <div className="flex items-end gap-2">
            <Field label={t('bookingRef')}>
              <Input
                dir="ltr"
                className="uppercase"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
              />
            </Field>
            <Button type="button" variant="secondary" onClick={find}>
              {t('find')}
            </Button>
          </div>
        )}
        {booking.isError && <Alert tone="bad">{errorText(booking.error)}</Alert>}
        {b && (
          <>
            <p className="text-sm text-muted">
              <span dir="ltr">{b.ref}</span> ·{' '}
              {t('balanceInfo', {
                total: formatMoney(b.total + b.fees, b.currency, locale),
                paid: formatMoney(b.amountPaid, b.currency, locale),
              })}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('kind')}>
                <Select
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}
                >
                  {(['deposit', 'balance', 'payment'] as const).map((k) => (
                    <option key={k} value={k}>
                      {t(`kind_${k}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('method')}>
                <Select
                  value={form.method}
                  onChange={(e) =>
                    setForm({ ...form, method: e.target.value as typeof form.method })
                  }
                >
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`method_${m}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label={t('amount')}
                error={form.amount && amount === null ? tc('error') : undefined}
              >
                <Input
                  required
                  inputMode="decimal"
                  dir="ltr"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </Field>
              <Field label={t('currency')}>
                <Select
                  value={currency}
                  onChange={(e) => setForm({ ...form, currency: e.target.value })}
                >
                  {[...new Set([b.currency, ...CURRENCIES])].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
              {needsFx && (
                <Field label={t('fxRate', { from: currency, to: b.currency })}>
                  <Input
                    required
                    inputMode="decimal"
                    dir="ltr"
                    value={form.fxRate}
                    onChange={(e) => setForm({ ...form, fxRate: e.target.value })}
                  />
                </Field>
              )}
              <Field label={t('receivedOn')}>
                <Input
                  type="date"
                  required
                  value={form.receivedOn}
                  onChange={(e) => setForm({ ...form, receivedOn: e.target.value })}
                />
              </Field>
            </div>
            <Field label={t('reference')}>
              <Input
                required
                dir="ltr"
                maxLength={200}
                value={form.reference}
                onChange={(e) => setForm({ ...form, reference: e.target.value })}
              />
            </Field>
            {canAttach && <AttachmentField file={file} onChange={setFile} />}
          </>
        )}
        {record.isError && <Alert tone="bad">{errorText(record.error)}</Alert>}
        {attach.isError && <Alert tone="bad">{errorText(attach.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button
            type="submit"
            disabled={
              !b ||
              amount === null ||
              !fxOk ||
              !form.reference.trim() ||
              record.isPending ||
              attach.isPending ||
              record.isSuccess
            }
          >
            {t('record')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function RefundDialog({
  bookingRef = '',
  onClose,
  onDone,
}: {
  bookingRef?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('payments');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const errorText = useErrorText();
  const { ref, setRef, find, booking } = useBookingByRef(bookingRef);
  const b = booking.data;
  const due = useQuery(
    trpc.payments.refundDue.queryOptions({ bookingId: b?.id ?? '' }, { enabled: Boolean(b) }),
  );
  const [form, setForm] = useState({
    method: 'bank_transfer' as (typeof METHODS)[number],
    amount: '',
    reference: '',
    refundedOn: cairoTodayIso(),
  });
  const refundCurrency = b?.currency ?? 'USD';
  const amountText =
    form.amount || (due.data ? minorToInput(due.data.refundable, refundCurrency) : '');
  const amount = parseMoney(amountText, refundCurrency);
  const requestKey = useMemo(() => newRequestKey(), [JSON.stringify(form), b?.id]);
  const refund = useMutation(trpc.payments.refund.mutationOptions({ onSuccess: onDone }));
  return (
    <Dialog open onClose={onClose} title={t('refund')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!b || amount === null) return;
          refund.mutate({
            bookingId: b.id,
            method: form.method,
            amount,
            currency: b.currency,
            reference: form.reference.trim(),
            refundedOn: form.refundedOn,
            requestKey,
          });
        }}
      >
        {!bookingRef && (
          <div className="flex items-end gap-2">
            <Field label={t('bookingRef')}>
              <Input
                dir="ltr"
                className="uppercase"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
              />
            </Field>
            <Button type="button" variant="secondary" onClick={find}>
              {t('find')}
            </Button>
          </div>
        )}
        {booking.isError && <Alert tone="bad">{errorText(booking.error)}</Alert>}
        {b && due.data && (
          <>
            <Alert tone={due.data.refundable > 0n ? 'info' : 'warn'}>
              {t('refundable', { amount: formatMoney(due.data.refundable, b.currency, locale) })}
            </Alert>
            <div className="grid grid-cols-2 gap-3">
              <Field label={`${t('amount')} (${b.currency})`}>
                <Input
                  required
                  inputMode="decimal"
                  dir="ltr"
                  value={amountText}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </Field>
              <Field label={t('method')}>
                <Select
                  value={form.method}
                  onChange={(e) =>
                    setForm({ ...form, method: e.target.value as typeof form.method })
                  }
                >
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`method_${m}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('refundedOn')}>
                <Input
                  type="date"
                  required
                  value={form.refundedOn}
                  onChange={(e) => setForm({ ...form, refundedOn: e.target.value })}
                />
              </Field>
              <Field label={t('reference')}>
                <Input
                  required
                  dir="ltr"
                  maxLength={200}
                  value={form.reference}
                  onChange={(e) => setForm({ ...form, reference: e.target.value })}
                />
              </Field>
            </div>
          </>
        )}
        {refund.isError && <Alert tone="bad">{errorText(refund.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button
            type="submit"
            disabled={!b || amount === null || !form.reference.trim() || refund.isPending}
          >
            {t('refund')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ReverseDialog({
  paymentId,
  onClose,
  onDone,
}: {
  paymentId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('payments');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [reason, setReason] = useState('');
  const reasons = useReasons('reversal');
  const reverse = useMutation(trpc.payments.reverse.mutationOptions({ onSuccess: onDone }));
  return (
    <Dialog open onClose={onClose} title={t('reverseTitle')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          reverse.mutate({ paymentId, reason: reason.trim() });
        }}
      >
        <Alert tone="warn">{t('reverseHelp')}</Alert>
        <Field label={tc('reason')}>
          <ChoiceField
            required
            allowEmpty={false}
            maxLength={500}
            choices={reasons}
            value={reason}
            onChange={setReason}
          />
        </Field>
        {reverse.isError && <Alert tone="bad">{errorText(reverse.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button type="submit" variant="danger" disabled={!reason.trim() || reverse.isPending}>
            {t('reverse')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
