'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { CURRENCIES } from '@vs/shared/money';
import { cairoTodayIso } from '../lib/dates';
import { useErrorText } from '../lib/errors';
import { formatDate, formatMoney, minorToInput, parseMoney } from '../lib/format';
import { newRequestKey, useTRPC } from '../lib/trpc';
import { ChoiceField } from './choice-field';
import { Dialog } from './dialog';
import { Alert, Button, Field, Input, Select } from './ui';
import { useReasons } from '../lib/choices';

export const RECEIPT_METHODS = [
  'bank_transfer',
  'cash',
  'card',
  'agency_remittance',
  'platform',
] as const;
type ReceiptMethod = (typeof RECEIPT_METHODS)[number];

const MAX_BYTES = 5 * 1024 * 1024;

/** A file as base64 for the attach procedures (PNG, JPEG or PDF, at most 5 MB). */
export async function fileToAttachment(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(binary), name: file.name.slice(0, 200) || 'attachment' };
}

export function AttachmentField({
  file,
  onChange,
}: {
  file: File | null;
  onChange: (file: File | null) => void;
}) {
  const t = useTranslations('receipts');
  const tooBig = file !== null && file.size > MAX_BYTES;
  return (
    <Field label={t('attachment')} error={tooBig ? t('attachmentTooBig') : undefined}>
      <Input
        type="file"
        accept="image/png,image/jpeg,application/pdf"
        capture="environment"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
    </Field>
  );
}

/** Picks a billing party by name (agencies and guests). */
function PartyPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const t = useTranslations('receipts');
  const trpc = useTRPC();
  const [search, setSearch] = useState('');
  const parties = useQuery(
    trpc.finance.parties.queryOptions({ search: search.trim() || undefined, limit: 50 }),
  );
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label={t('searchParty')}>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} />
      </Field>
      <Field label={t('party')}>
        <Select required value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(parties.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

/**
 * Money received from a party, with its allocation to the party's open invoices in the same
 * currency (oldest due first, editable). What is not allocated stays as the party's credit.
 */
export function RecordReceiptDialog({
  partyId: fixedParty,
  invoiceId,
  onClose,
  onDone,
}: {
  partyId?: string;
  /** Opened from an invoice: that invoice is filled first. */
  invoiceId?: string;
  onClose: () => void;
  onDone: (receiptId: string) => void;
}) {
  const t = useTranslations('receipts');
  const tp = useTranslations('payments');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [partyId, setPartyId] = useState(fixedParty ?? '');
  const account = useQuery(
    trpc.receipts.account.queryOptions({ billingPartyId: partyId }, { enabled: Boolean(partyId) }),
  );
  const [form, setForm] = useState({
    amount: '',
    currency: '',
    method: 'bank_transfer' as ReceiptMethod,
    reference: '',
    receivedOn: cairoTodayIso(),
    note: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const [shares, setShares] = useState<Record<string, string>>({});
  const invoices = account.data?.openInvoices ?? [];
  const currency =
    form.currency ||
    invoices.find((i) => i.id === invoiceId)?.currency ||
    invoices[0]?.currency ||
    'USD';
  const amount = parseMoney(form.amount, currency);
  const same = useMemo(() => {
    const list = invoices.filter((i) => i.currency === currency);
    // The invoice it was opened from first, then oldest due.
    return [...list].sort((a, b) => Number(b.id === invoiceId) - Number(a.id === invoiceId));
  }, [invoices, currency, invoiceId]);

  // Fill the allocations oldest first whenever the amount or currency changes.
  useEffect(() => {
    if (amount === null) return;
    let left = amount;
    const next: Record<string, string> = {};
    for (const i of same) {
      const take = left < i.open ? left : i.open;
      next[i.id] = take > 0n ? minorToInput(take, currency) : '';
      left -= take > 0n ? take : 0n;
    }
    setShares(next);
  }, [form.amount, currency, same.length]);

  const allocations = same
    .map((i) => ({ invoiceId: i.id, amount: parseMoney(shares[i.id] ?? '', currency) }))
    .filter((a): a is { invoiceId: string; amount: bigint } => a.amount !== null && a.amount > 0n);
  const allocated = allocations.reduce((s, a) => s + a.amount, 0n);
  const overOpen = same.some((i) => (parseMoney(shares[i.id] ?? '', currency) ?? 0n) > i.open);
  const credit = amount !== null ? amount - allocated : null;
  const requestKey = useMemo(
    () => newRequestKey(),
    [JSON.stringify(form), partyId, JSON.stringify(shares)],
  );
  const record = useMutation(
    trpc.receipts.record.mutationOptions({ onSuccess: (r) => onDone(r.receiptId) }),
  );
  const tooBig = file !== null && file.size > MAX_BYTES;
  const valid =
    partyId &&
    amount !== null &&
    amount > 0n &&
    credit !== null &&
    credit >= 0n &&
    !overOpen &&
    form.reference.trim() &&
    !tooBig;

  return (
    <Dialog open onClose={onClose} title={t('record')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid || amount === null) return;
          record.mutate({
            billingPartyId: partyId,
            amount,
            currency,
            method: form.method,
            reference: form.reference.trim(),
            receivedOn: form.receivedOn,
            note: form.note.trim() || undefined,
            attachment: file ? await fileToAttachment(file) : undefined,
            allocations,
            requestKey,
          });
        }}
      >
        {!fixedParty && <PartyPicker value={partyId} onChange={setPartyId} />}
        {account.data && (
          <p className="text-sm text-muted">
            {account.data.party.name}
            {account.data.credit
              .filter((c) => c.credit !== 0n)
              .map((c) => (
                <span key={c.currency} className="ms-2">
                  · {t('creditNow', { amount: formatMoney(c.credit, c.currency, locale) })}
                </span>
              ))}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={tp('amount')}>
            <Input
              required
              inputMode="decimal"
              dir="ltr"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </Field>
          <Field label={tp('currency')}>
            <Select
              value={currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value })}
            >
              {[...new Set([...invoices.map((i) => i.currency), ...CURRENCIES])].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tp('method')}>
            <Select
              value={form.method}
              onChange={(e) => setForm({ ...form, method: e.target.value as ReceiptMethod })}
            >
              {RECEIPT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`method_${m}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tp('receivedOn')}>
            <Input
              type="date"
              required
              value={form.receivedOn}
              onChange={(e) => setForm({ ...form, receivedOn: e.target.value })}
            />
          </Field>
        </div>
        <Field label={tp('reference')}>
          <Input
            required
            dir="ltr"
            maxLength={200}
            value={form.reference}
            onChange={(e) => setForm({ ...form, reference: e.target.value })}
          />
        </Field>
        <Field label={tp('note')}>
          <Input
            maxLength={500}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </Field>
        <AttachmentField file={file} onChange={setFile} />

        {partyId && account.data && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t('allocateTo')}</p>
            {same.length === 0 ? (
              <p className="text-sm text-muted">{t('noOpenInvoices', { currency })}</p>
            ) : (
              same.map((i) => (
                <div key={i.id} className="grid grid-cols-[1fr_8rem] items-center gap-2 text-sm">
                  <span>
                    <span dir="ltr">{i.number}</span>
                    <span className="block text-xs text-muted">
                      {t('openOf', {
                        open: formatMoney(i.open, i.currency, locale),
                        due: i.due_date ? formatDate(i.due_date, locale, 'year') : '—',
                      })}
                    </span>
                  </span>
                  <Input
                    inputMode="decimal"
                    dir="ltr"
                    aria-label={i.number ?? ''}
                    value={shares[i.id] ?? ''}
                    onChange={(e) => setShares({ ...shares, [i.id]: e.target.value })}
                  />
                </div>
              ))
            )}
            {credit !== null && (
              <Alert tone={credit < 0n || overOpen ? 'bad' : 'info'}>
                {credit < 0n
                  ? t('overAllocated')
                  : overOpen
                    ? t('overOpen')
                    : t('remainderCredit', { amount: formatMoney(credit, currency, locale) })}
              </Alert>
            )}
          </div>
        )}
        {record.isError && <Alert tone="bad">{errorText(record.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button type="submit" disabled={!valid || record.isPending}>
            {t('record')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Puts what is left of a receipt on one of the party's open invoices. */
export function AllocateDialog({
  receiptId,
  partyId,
  currency,
  left,
  invoiceId: preset,
  onClose,
  onDone,
}: {
  receiptId: string;
  partyId: string;
  currency: string;
  left: bigint;
  invoiceId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('receipts');
  const tp = useTranslations('payments');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const errorText = useErrorText();
  const account = useQuery(trpc.receipts.account.queryOptions({ billingPartyId: partyId }));
  const invoices = account.data?.openInvoices ?? [];
  const [invoiceId, setInvoiceId] = useState(preset ?? '');
  const invoice = invoices.find((i) => i.id === invoiceId);
  const needsFx = invoice !== undefined && invoice.currency !== currency;
  const [fxRate, setFxRate] = useState('');
  const [amountText, setAmountText] = useState('');
  const suggested =
    invoice && !needsFx ? (invoice.open < left ? invoice.open : left) : left > 0n ? left : 0n;
  const text = amountText || (invoice ? minorToInput(suggested, currency) : '');
  const amount = parseMoney(text, currency);
  const fxOk = !needsFx || /^\d+(\.\d{1,6})?$/.test(fxRate);
  const allocate = useMutation(trpc.receipts.allocate.mutationOptions({ onSuccess: onDone }));
  return (
    <Dialog open onClose={onClose} title={t('allocate')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invoice || amount === null || !fxOk) return;
          allocate.mutate({
            receiptId,
            invoiceId: invoice.id,
            amount,
            fxRate: needsFx ? fxRate : undefined,
          });
        }}
      >
        <p className="text-sm text-muted">
          {t('leftOnReceipt', { amount: formatMoney(left, currency, locale) })}
        </p>
        <Field label={t('invoice')}>
          <Select required value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
            <option value="">—</option>
            {invoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.number} · {formatMoney(i.open, i.currency, locale)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`${tp('amount')} (${currency})`}>
            <Input
              required
              inputMode="decimal"
              dir="ltr"
              value={text}
              onChange={(e) => setAmountText(e.target.value)}
            />
          </Field>
          {needsFx && invoice && (
            <Field label={tp('fxRate', { from: currency, to: invoice.currency })}>
              <Input
                required
                inputMode="decimal"
                dir="ltr"
                value={fxRate}
                onChange={(e) => setFxRate(e.target.value)}
              />
            </Field>
          )}
        </div>
        {allocate.isError && <Alert tone="bad">{errorText(allocate.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button
            type="submit"
            disabled={!invoice || amount === null || amount <= 0n || !fxOk || allocate.isPending}
          >
            {t('allocate')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ReverseReceiptDialog({
  receiptId,
  onClose,
  onDone,
}: {
  receiptId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('receipts');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [reason, setReason] = useState('');
  const reasons = useReasons('reversal');
  const reverse = useMutation(trpc.receipts.reverse.mutationOptions({ onSuccess: onDone }));
  return (
    <Dialog open onClose={onClose} title={t('reverseTitle')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          reverse.mutate({ receiptId, reason: reason.trim() });
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

/** Pays a party's free credit back (a negative receipt), optionally against a credit note. */
export function PartyRefundDialog({
  partyId: fixedParty,
  onClose,
  onDone,
}: {
  partyId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('receipts');
  const tp = useTranslations('payments');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [partyId, setPartyId] = useState(fixedParty ?? '');
  const account = useQuery(
    trpc.receipts.account.queryOptions({ billingPartyId: partyId }, { enabled: Boolean(partyId) }),
  );
  const credits = (account.data?.credit ?? []).filter((c) => c.free > 0n);
  const [form, setForm] = useState({
    currency: '',
    amount: '',
    method: 'bank_transfer' as ReceiptMethod,
    reference: '',
    refundedOn: cairoTodayIso(),
    creditNoteId: '',
  });
  const currency = form.currency || credits[0]?.currency || 'USD';
  const free = credits.find((c) => c.currency === currency)?.free ?? 0n;
  const text = form.amount || (free > 0n ? minorToInput(free, currency) : '');
  const amount = parseMoney(text, currency);
  const requestKey = useMemo(() => newRequestKey(), [JSON.stringify(form), partyId]);
  const refund = useMutation(trpc.receipts.refund.mutationOptions({ onSuccess: onDone }));
  return (
    <Dialog open onClose={onClose} title={t('refundCredit')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!partyId || amount === null) return;
          refund.mutate({
            billingPartyId: partyId,
            amount,
            currency,
            method: form.method,
            reference: form.reference.trim(),
            refundedOn: form.refundedOn,
            creditNoteId: form.creditNoteId || undefined,
            requestKey,
          });
        }}
      >
        {!fixedParty && <PartyPicker value={partyId} onChange={setPartyId} />}
        {account.data && (
          <Alert tone={free > 0n ? 'info' : 'warn'}>
            {t('freeCredit', { amount: formatMoney(free, currency, locale) })}
          </Alert>
        )}
        <p className="text-xs text-muted">{t('refundHint')}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tp('currency')}>
            <Select
              value={currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value, amount: '' })}
            >
              {[...new Set([currency, ...credits.map((c) => c.currency)])].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tp('amount')}>
            <Input
              required
              inputMode="decimal"
              dir="ltr"
              value={text}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </Field>
          <Field label={tp('method')}>
            <Select
              value={form.method}
              onChange={(e) => setForm({ ...form, method: e.target.value as ReceiptMethod })}
            >
              {RECEIPT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`method_${m}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tp('refundedOn')}>
            <Input
              type="date"
              required
              value={form.refundedOn}
              onChange={(e) => setForm({ ...form, refundedOn: e.target.value })}
            />
          </Field>
        </div>
        <Field label={tp('reference')}>
          <Input
            required
            dir="ltr"
            maxLength={200}
            value={form.reference}
            onChange={(e) => setForm({ ...form, reference: e.target.value })}
          />
        </Field>
        {(account.data?.creditNotes.length ?? 0) > 0 && (
          <Field label={t('creditNote')}>
            <Select
              value={form.creditNoteId}
              onChange={(e) => setForm({ ...form, creditNoteId: e.target.value })}
            >
              <option value="">—</option>
              {account.data!.creditNotes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.number} · {formatMoney(n.total, n.currency, locale)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {refund.isError && <Alert tone="bad">{errorText(refund.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button
            type="submit"
            disabled={
              !partyId ||
              amount === null ||
              amount <= 0n ||
              amount > free ||
              !form.reference.trim() ||
              refund.isPending
            }
          >
            {t('refundCredit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
