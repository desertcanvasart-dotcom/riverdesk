'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { Dialog } from '../../../../components/dialog';
import { download, RequestDocumentButton } from '../../../../components/documents';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  PageHeader,
  Select,
  Td,
} from '../../../../components/ui';
import { cairoTodayIso } from '../../../../lib/dates';
import { useErrorText } from '../../../../lib/errors';
import { formatDate, formatMoney, minorToInput, parseMoney } from '../../../../lib/format';
import { useTRPC } from '../../../../lib/trpc';
import { invoiceTone } from '../invoice-status';
import { LinesEditor, type LineDraft } from '../invoices-screen';

type Locale = 'ar' | 'en' | 'both';

export function InvoiceScreen({
  invoiceId,
  canFinance,
  canDraft,
}: {
  invoiceId: string;
  canFinance: boolean;
  canDraft: boolean;
}) {
  const t = useTranslations('invoices');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const errorText = useErrorText();
  const [dialog, setDialog] = useState<'issue' | 'credit' | 'edit' | 'party' | 'delete' | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery(trpc.invoices.get.queryOptions({ invoiceId }));
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.invoices.pathKey() });
  const remove = useMutation(
    trpc.invoices.deleteDraft.mutationOptions({ onSuccess: () => router.push('/invoices') }),
  );

  if (query.isLoading) return <Empty>{tc('loading')}</Empty>;
  if (!query.data) return <Alert tone="bad">{errorText(query.error)}</Alert>;
  const { invoice, lines, party, creditNotes } = query.data;
  const type = invoice.type as 'proforma' | 'invoice' | 'credit_note';
  const money = (amount: bigint) => formatMoney(amount, invoice.currency, locale);
  const draft = invoice.status === 'draft';
  const mayEditDraft = draft && (type === 'proforma' ? canDraft || canFinance : canFinance);
  const remaining = invoice.total - invoice.amount_credited;
  const due = invoice.total - invoice.amount_credited - invoice.amount_paid;
  const overdue =
    (invoice.status === 'issued' || invoice.status === 'partially_paid') &&
    invoice.due_date !== null &&
    invoice.due_date < cairoTodayIso();
  const taxes = new Map<string, { label: string; amount: bigint }>();
  for (const l of lines) {
    if (l.tax_bps === null) continue;
    const label = `${(locale.startsWith('ar') ? l.tax_name_ar : l.tax_name_en) ?? ''} ${l.tax_bps / 100}%`;
    const row = taxes.get(label) ?? { label, amount: 0n };
    row.amount += l.tax_amount;
    taxes.set(label, row);
  }
  const refs = [...new Set(lines.map((l) => l.booking_ref).filter((r): r is string => !!r))];

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {t(`type_${type}`)}
            {invoice.number && <span dir="ltr">{invoice.number}</span>}
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={invoiceTone(invoice.status)}>
              {t(`status_${invoice.status as 'draft'}`)}
            </Badge>
            {overdue && <Badge tone="bad">{t('overdue')}</Badge>}
            <span>{party.name}</span>
          </span>
        }
        actions={
          <>
            {mayEditDraft && (
              <>
                <Button variant="secondary" onClick={() => setDialog('edit')}>
                  {t('edit')}
                </Button>
                <Button variant="secondary" onClick={() => setDialog('delete')}>
                  {t('delete')}
                </Button>
              </>
            )}
            {draft && type !== 'credit_note' && canFinance && (
              <Button onClick={() => setDialog('issue')}>
                {type === 'proforma' ? t('issueFromProforma') : t('issue')}
              </Button>
            )}
            {type === 'invoice' && !draft && remaining > 0n && canFinance && (
              <Button variant="secondary" onClick={() => setDialog('credit')}>
                {t('creditNote')}
              </Button>
            )}
          </>
        }
      />
      {notice && (
        <div className="mb-4">
          <Alert tone="ok">{notice}</Alert>
        </div>
      )}
      {type === 'proforma' && (
        <div className="mb-4">
          <Alert tone="info">{t('proformaHint')}</Alert>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('details')} className="lg:col-span-2">
          <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            <dt className="text-muted">{t('issueDate')}</dt>
            <dd>{invoice.issue_date ? formatDate(invoice.issue_date, locale, 'year') : '—'}</dd>
            <dt className="text-muted">{t('dueDate')}</dt>
            <dd>{invoice.due_date ? formatDate(invoice.due_date, locale, 'year') : '—'}</dd>
            <dt className="text-muted">{t('currency')}</dt>
            <dd>{invoice.currency}</dd>
            <dt className="text-muted">{t('bookings')}</dt>
            <dd className="flex flex-wrap gap-1">
              {refs.length
                ? refs.map((r) => (
                    <Link key={r} href={`/bookings/${r}`} className="text-brand" dir="ltr">
                      {r}
                    </Link>
                  ))
                : '—'}
            </dd>
            {invoice.fx_rate && (
              <>
                <dt className="text-muted">{t('fxRate')}</dt>
                <dd className="col-span-3" dir="ltr">
                  1 {invoice.currency} = {invoice.fx_rate} {invoice.base_currency}
                  {invoice.fx_source && ` · ${invoice.fx_source}`}
                  {invoice.fx_date && ` · ${invoice.fx_date}`}
                </dd>
              </>
            )}
            {invoice.credit_reason && (
              <>
                <dt className="text-muted">{t('reason')}</dt>
                <dd className="col-span-3">{invoice.credit_reason}</dd>
              </>
            )}
          </dl>
          {/* A plain table: descriptions wrap instead of scrolling sideways. */}
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th className="px-2 py-2 text-start font-medium">#</th>
                <th className="px-2 py-2 text-start font-medium">{t('description')}</th>
                <th className="px-2 py-2 text-start font-medium">{t('tax')}</th>
                <th className="px-2 py-2 text-end font-medium">{t('amount')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.id}>
                  <Td className="tabular-nums">{i + 1}</Td>
                  <Td>
                    {locale.startsWith('ar') ? l.description_ar : l.description_en}
                    {l.quantity !== 1 && (
                      <span className="block text-xs text-muted">
                        {l.quantity} × {money(l.unit_amount)}
                      </span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {l.tax_bps !== null ? `${l.tax_bps / 100}%` : '—'}
                  </Td>
                  <Td className="whitespace-nowrap text-end tabular-nums">{money(l.amount)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="ms-auto mt-3 grid max-w-xs grid-cols-2 gap-y-1 text-sm">
            {taxes.size > 0 && (
              <>
                <dt className="text-muted">{t('subtotal')}</dt>
                <dd className="text-end tabular-nums">{money(invoice.subtotal)}</dd>
                {[...taxes.values()].map((x) => (
                  <div key={x.label} className="contents">
                    <dt className="text-muted">{x.label}</dt>
                    <dd className="text-end tabular-nums">{money(x.amount)}</dd>
                  </div>
                ))}
              </>
            )}
            <dt className="font-semibold">{t('total')}</dt>
            <dd className="text-end font-semibold tabular-nums">{money(invoice.total)}</dd>
            {type === 'invoice' && invoice.amount_credited > 0n && (
              <>
                <dt className="text-muted">{t('credited')}</dt>
                <dd className="text-end tabular-nums">{money(-invoice.amount_credited)}</dd>
              </>
            )}
            {type === 'invoice' && !draft && (
              <>
                <dt className="text-muted">{t('paid')}</dt>
                <dd className="text-end tabular-nums">{money(invoice.amount_paid)}</dd>
                <dt className="font-semibold">{t('due')}</dt>
                <dd className="text-end font-semibold tabular-nums">
                  {money(due > 0n ? due : 0n)}
                </dd>
              </>
            )}
          </dl>
          {invoice.notes && <p className="mt-3 text-sm text-muted">{invoice.notes}</p>}
        </Card>

        <div className="flex flex-col gap-4">
          <Card
            title={t('billTo')}
            actions={
              canFinance && (
                <Button variant="ghost" onClick={() => setDialog('party')}>
                  {t('edit')}
                </Button>
              )
            }
          >
            <p className="font-medium">
              {party.legal_name_en || party.legal_name_ar || party.name}
            </p>
            <p className="text-sm text-muted">{t(`party_${party.kind as 'agency'}`)}</p>
            {party.tax_registration_no && (
              <p className="text-sm">
                {t('taxNo')}: <span dir="ltr">{party.tax_registration_no}</span>
              </p>
            )}
            {party.email && (
              <p className="text-sm" dir="ltr">
                {party.email}
              </p>
            )}
            {!draft && <p className="mt-2 text-xs text-muted">{t('snapshotHint')}</p>}
          </Card>
          <ShareCard invoiceId={invoice.id} number={invoice.number ?? refs[0] ?? ''} type={type} />
          {(creditNotes.length > 0 || invoice.credits_invoice_id) && (
            <Card title={type === 'credit_note' ? t('creditsInvoice') : t('creditNotes')}>
              {invoice.credits_invoice_id && (
                <Link href={`/invoices/${invoice.credits_invoice_id}`} className="text-brand">
                  {t('openInvoice')}
                </Link>
              )}
              <ul className="divide-y divide-line text-sm">
                {creditNotes.map((n) => (
                  <li key={n.id} className="flex justify-between gap-2 py-2">
                    <Link href={`/invoices/${n.id}`} className="text-brand" dir="ltr">
                      {n.number}
                    </Link>
                    <span className="tabular-nums">{money(n.total)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {dialog === 'issue' && (
        <IssueDialog
          invoiceId={invoice.id}
          currency={invoice.currency}
          baseCurrency={invoice.base_currency}
          onClose={() => setDialog(null)}
          onDone={(id, number) => {
            setDialog(null);
            void refresh();
            setNotice(t('issued', { number }));
            if (id !== invoice.id) router.push(`/invoices/${id}`);
          }}
        />
      )}
      {dialog === 'credit' && (
        <CreditDialog
          invoiceId={invoice.id}
          currency={invoice.currency}
          remaining={remaining}
          partlyCredited={invoice.amount_credited > 0n}
          lines={lines.filter((l) => l.amount > 0n)}
          onClose={() => setDialog(null)}
          onDone={(id) => {
            setDialog(null);
            void refresh();
            router.push(`/invoices/${id}`);
          }}
        />
      )}
      {dialog === 'edit' && (
        <EditDialog
          invoiceId={invoice.id}
          currency={invoice.currency}
          initial={{
            notes: invoice.notes ?? '',
            locale: invoice.locale as Locale,
            dueDate: invoice.due_date ?? '',
            lines: lines
              .filter((l) => l.kind === 'manual')
              .map((l) => ({
                ar: l.description_ar,
                en: l.description_en,
                amount: minorToInput(l.unit_amount * BigInt(l.quantity), invoice.currency),
                taxRateId: l.tax_rate_id ?? '',
              })),
          }}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void refresh();
          }}
        />
      )}
      {dialog === 'party' && (
        <PartyDialog
          party={party}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void refresh();
          }}
        />
      )}
      {dialog === 'delete' && (
        <Dialog open onClose={() => setDialog(null)} title={t('deleteTitle')}>
          <p className="mb-3 text-sm">{t('deleteConfirm')}</p>
          {remove.isError && <Alert tone="bad">{errorText(remove.error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {tc('cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ invoiceId: invoice.id })}
            >
              {t('delete')}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** PDF in the chosen language: download it, hand it to the phone's share sheet, or copy the link. */
function ShareCard({
  invoiceId,
  number,
  type,
}: {
  invoiceId: string;
  number: string;
  type: 'proforma' | 'invoice' | 'credit_note';
}) {
  const t = useTranslations('invoices');
  const td = useTranslations('documents');
  const uiLocale = useLocale();
  const trpc = useTRPC();
  const [locale, setLocale] = useState<Locale>(uiLocale === 'en' ? 'en' : 'ar');
  const [copied, setCopied] = useState(false);
  const pdf = useMutation(trpc.invoices.requestPdf.mutationOptions());
  const share = useCallback(
    async (documentId: string) => {
      const response = await fetch(`/api/documents/${documentId}`);
      const blob = await response.blob();
      const name =
        /filename="?([^";]+)"?/.exec(response.headers.get('content-disposition') ?? '')?.[1] ??
        `${number}.pdf`;
      const file = new File([blob], name, { type: 'application/pdf' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator
          .share({ files: [file], title: `${t(`type_${type}`)} ${number}` })
          .catch(() => undefined);
      } else {
        download(documentId);
      }
    },
    [number, t, type],
  );
  return (
    <Card title={t('pdf')}>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {(['ar', 'en', 'both'] as const).map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setLocale(l)}
            className={`rounded-full px-3 py-1 ${locale === l ? 'bg-brand text-brand-ink' : 'border border-line'}`}
          >
            {l === 'ar' ? 'العربية' : l === 'en' ? 'English' : td('bothLanguages')}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <RequestDocumentButton
          label={t('downloadPdf')}
          pending={pdf.isPending}
          error={pdf.error}
          request={() => pdf.mutateAsync({ invoiceId, locale })}
        />
        <RequestDocumentButton
          label={t('share')}
          pending={pdf.isPending}
          request={() => pdf.mutateAsync({ invoiceId, locale })}
          onReady={share}
        />
        <Button
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(window.location.href).then(() => setCopied(true));
          }}
        >
          {copied ? t('linkCopied') : t('copyLink')}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">{t('shareHint')}</p>
    </Card>
  );
}

function IssueDialog({
  invoiceId,
  currency,
  baseCurrency,
  onClose,
  onDone,
}: {
  invoiceId: string;
  currency: string;
  baseCurrency: string;
  onClose: () => void;
  onDone: (invoiceId: string, number: string) => void;
}) {
  const t = useTranslations('invoices');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const needsRate = currency !== baseCurrency;
  const [fx, setFx] = useState({ rate: '', source: '', date: cairoTodayIso() });
  const issue = useMutation(
    trpc.invoices.issue.mutationOptions({ onSuccess: (r) => onDone(r.invoiceId, r.number) }),
  );
  const rateOk = !needsRate || /^[0-9]+(\.[0-9]{1,6})?$/.test(fx.rate.trim());
  return (
    <Dialog open onClose={onClose} title={t('issueTitle')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm">{t('issueConfirm')}</p>
        {needsRate && (
          <>
            <Field
              label={<bdi dir="ltr">{t('fxRateLabel', { from: currency, to: baseCurrency })}</bdi>}
              hint={t('fxHint')}
            >
              <Input
                inputMode="decimal"
                dir="ltr"
                value={fx.rate}
                onChange={(e) => setFx({ ...fx, rate: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('fxSource')}>
                <Input
                  placeholder={t('fxSourcePlaceholder')}
                  value={fx.source}
                  onChange={(e) => setFx({ ...fx, source: e.target.value })}
                />
              </Field>
              <Field label={t('fxDate')}>
                <Input
                  type="date"
                  value={fx.date}
                  onChange={(e) => setFx({ ...fx, date: e.target.value })}
                />
              </Field>
            </div>
          </>
        )}
        {issue.isError && <Alert tone="bad">{errorText(issue.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button
            disabled={issue.isPending || !rateOk}
            onClick={() =>
              issue.mutate({
                invoiceId,
                ...(needsRate
                  ? {
                      fxRate: fx.rate.trim(),
                      fxSource: fx.source.trim() || undefined,
                      fxDate: fx.date || undefined,
                    }
                  : {}),
              })
            }
          >
            {t('issue')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function CreditDialog({
  invoiceId,
  currency,
  remaining,
  partlyCredited,
  lines,
  onClose,
  onDone,
}: {
  invoiceId: string;
  currency: string;
  remaining: bigint;
  partlyCredited: boolean;
  lines: { id: string; description_ar: string; description_en: string; amount: bigint }[];
  onClose: () => void;
  onDone: (creditNoteId: string) => void;
}) {
  const t = useTranslations('invoices');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [mode, setMode] = useState<'full' | 'lines'>(partlyCredited ? 'lines' : 'full');
  const [reason, setReason] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const credit = useMutation(
    trpc.invoices.creditNote.mutationOptions({ onSuccess: (r) => onDone(r.creditNoteId) }),
  );
  const picked = Object.entries(amounts)
    .map(([lineId, text]) => ({ lineId, amount: text.trim() ? parseMoney(text, currency) : 0n }))
    .filter((x) => x.amount !== 0n);
  const valid =
    reason.trim().length > 0 &&
    (mode === 'full' || (picked.length > 0 && picked.every((x) => x.amount !== null)));
  return (
    <Dialog open onClose={onClose} title={t('creditTitle')} wide>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          {t('creditRemaining', { amount: formatMoney(remaining, currency, locale) })}
        </p>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              disabled={partlyCredited}
              checked={mode === 'full'}
              onChange={() => setMode('full')}
            />
            {t('creditFull')}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'lines'} onChange={() => setMode('lines')} />
            {t('creditLines')}
          </label>
        </div>
        {mode === 'lines' && (
          <div className="flex flex-col gap-2">
            {lines.map((l) => (
              <div key={l.id} className="grid items-center gap-2 sm:grid-cols-3">
                <span className="text-sm sm:col-span-2">
                  {locale.startsWith('ar') ? l.description_ar : l.description_en}
                  <span className="block text-xs text-muted">
                    {formatMoney(l.amount, currency, locale)}
                  </span>
                </span>
                <Input
                  inputMode="decimal"
                  dir="ltr"
                  placeholder="0"
                  value={amounts[l.id] ?? ''}
                  onChange={(e) => setAmounts({ ...amounts, [l.id]: e.target.value })}
                />
              </div>
            ))}
          </div>
        )}
        <Field label={t('reason')}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {credit.isError && <Alert tone="bad">{errorText(credit.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button
            disabled={credit.isPending || !valid}
            onClick={() =>
              credit.mutate({
                invoiceId,
                reason: reason.trim(),
                ...(mode === 'lines'
                  ? { lines: picked.map((x) => ({ lineId: x.lineId, amount: x.amount! })) }
                  : {}),
              })
            }
          >
            {t('issueCredit')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function EditDialog({
  invoiceId,
  currency,
  initial,
  onClose,
  onDone,
}: {
  invoiceId: string;
  currency: string;
  initial: { notes: string; locale: Locale; dueDate: string; lines: LineDraft[] };
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('invoices');
  const tc = useTranslations('common');
  const td = useTranslations('documents');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const taxes = useQuery(trpc.finance.taxes.queryOptions());
  const [form, setForm] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const update = useMutation(trpc.invoices.updateDraft.mutationOptions({ onSuccess: onDone }));
  const submit = () => {
    const parsed = form.lines.map((l) => ({ ...l, minor: parseMoney(l.amount, currency) }));
    if (parsed.some((l) => !l.ar.trim() || !l.en.trim() || l.minor === null)) {
      setInvalid(true);
      return;
    }
    update.mutate({
      invoiceId,
      notes: form.notes.trim() || null,
      locale: form.locale,
      dueDate: form.dueDate || null,
      manualLines: parsed.map((l) => ({
        descriptionAr: l.ar,
        descriptionEn: l.en,
        unitAmount: l.minor!,
        taxRateId: l.taxRateId || null,
      })),
    });
  };
  return (
    <Dialog open onClose={onClose} title={t('edit')} wide>
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('dueDate')} hint={t('dueDateHint')}>
            <Input
              type="date"
              value={form.dueDate}
              onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
            />
          </Field>
          <Field label={td('language')}>
            <Select
              value={form.locale}
              onChange={(e) => setForm({ ...form, locale: e.target.value as Locale })}
            >
              <option value="ar">العربية</option>
              <option value="en">English</option>
              <option value="both">{td('bothLanguages')}</option>
            </Select>
          </Field>
        </div>
        <Field label={t('notes')}>
          <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        <p className="text-sm font-medium">{t('extraLines')}</p>
        <LinesEditor
          lines={form.lines}
          onChange={(lines) => setForm({ ...form, lines })}
          taxes={taxes.data ?? []}
          currency={currency}
        />
        {invalid && <Alert tone="bad">{t('fillLines')}</Alert>}
        {update.isError && <Alert tone="bad">{errorText(update.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button disabled={update.isPending} onClick={submit}>
            {tc('save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function PartyDialog({
  party,
  onClose,
  onDone,
}: {
  party: {
    id: string;
    name: string;
    legal_name_ar: string | null;
    legal_name_en: string | null;
    address: string | null;
    tax_registration_no: string | null;
    commercial_registration_no: string | null;
    email: string | null;
    phone: string | null;
  };
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('invoices');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [form, setForm] = useState({
    name: party.name,
    legalNameAr: party.legal_name_ar ?? '',
    legalNameEn: party.legal_name_en ?? '',
    address: party.address ?? '',
    taxRegistrationNo: party.tax_registration_no ?? '',
    commercialRegistrationNo: party.commercial_registration_no ?? '',
    email: party.email ?? '',
    phone: party.phone ?? '',
  });
  const update = useMutation(trpc.finance.updateParty.mutationOptions({ onSuccess: onDone }));
  const field = (key: keyof typeof form, label: string, dir?: 'ltr' | 'rtl') => (
    <Field label={label}>
      <Input
        dir={dir}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </Field>
  );
  return (
    <Dialog open onClose={onClose} title={t('editParty')} wide>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t('partyHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {field('name', t('partyName'))}
          {field('email', t('email'), 'ltr')}
          {field('legalNameAr', t('legalNameAr'), 'rtl')}
          {field('legalNameEn', t('legalNameEn'), 'ltr')}
          {field('taxRegistrationNo', t('taxNo'), 'ltr')}
          {field('commercialRegistrationNo', t('crNo'), 'ltr')}
          {field('phone', t('phone'), 'ltr')}
          {field('address', t('address'))}
        </div>
        {update.isError && <Alert tone="bad">{errorText(update.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button
            disabled={update.isPending || !form.name.trim()}
            onClick={() => update.mutate({ id: party.id, ...form })}
          >
            {tc('save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
