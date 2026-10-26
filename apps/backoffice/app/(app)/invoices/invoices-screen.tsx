'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Dialog } from '../../../components/dialog';
import { RequestDocumentButton } from '../../../components/documents';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Select,
  Table,
  Td,
} from '../../../components/ui';
import { cairoTodayIso } from '../../../lib/dates';
import { useErrorText } from '../../../lib/errors';
import { formatDate, formatMoney, parseMoney } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';
import { invoiceTone } from './invoice-status';

type Type = 'proforma' | 'invoice' | 'credit_note';
type Status = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'cancelled';

export function InvoicesScreen({ canFinance }: { canFinance: boolean }) {
  const t = useTranslations('invoices');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const [filters, setFilters] = useState<{
    type: Type | '';
    status: Status | '';
    overdue: boolean;
  }>({ type: '', status: '', overdue: false });
  const [creating, setCreating] = useState(false);
  const list = useQuery(
    trpc.invoices.list.queryOptions({
      type: filters.type || undefined,
      status: filters.status || undefined,
      overdue: filters.overdue || undefined,
      limit: 200,
    }),
  );
  const rows = list.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card
        actions={canFinance && <Button onClick={() => setCreating(true)}>{t('newManual')}</Button>}
      >
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Select
            aria-label={t('type')}
            value={filters.type}
            onChange={(e) => setFilters({ ...filters, type: e.target.value as Type | '' })}
          >
            <option value="">{t('anyType')}</option>
            {(['invoice', 'credit_note', 'proforma'] as const).map((x) => (
              <option key={x} value={x}>
                {t(`type_${x}`)}
              </option>
            ))}
          </Select>
          <Select
            aria-label={t('status')}
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value as Status | '' })}
          >
            <option value="">{t('anyStatus')}</option>
            {(['draft', 'issued', 'partially_paid', 'paid', 'cancelled'] as const).map((x) => (
              <option key={x} value={x}>
                {t(`status_${x}`)}
              </option>
            ))}
          </Select>
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={filters.overdue}
              onChange={(e) => setFilters({ ...filters, overdue: e.target.checked })}
            />
            {t('overdueOnly')}
          </label>
        </div>
        {list.isLoading ? (
          <Empty>{tc('loading')}</Empty>
        ) : rows.length === 0 ? (
          <Empty>{t('none')}</Empty>
        ) : (
          <Table
            head={[
              t('number'),
              t('type'),
              t('party'),
              t('issueDate'),
              t('dueDate'),
              t('total'),
              t('status'),
            ]}
          >
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link href={`/invoices/${r.id}`} className="text-brand" dir="ltr">
                    {r.number ?? t('noNumber')}
                  </Link>
                </Td>
                <Td>{t(`type_${r.type as Type}`)}</Td>
                <Td>
                  {r.party_name}
                  <span className="block text-xs text-muted">
                    {t(`party_${r.party_kind as 'agency' | 'guest'}`)}
                  </span>
                </Td>
                <Td className="whitespace-nowrap">
                  {r.issue_date ? formatDate(r.issue_date, locale, 'year') : '—'}
                </Td>
                <Td className="whitespace-nowrap">
                  {r.due_date ? formatDate(r.due_date, locale, 'year') : '—'}
                </Td>
                <Td className="whitespace-nowrap tabular-nums">
                  {formatMoney(r.total, r.currency, locale)}
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    <Badge tone={invoiceTone(r.status)}>{t(`status_${r.status as Status}`)}</Badge>
                    {r.overdue && <Badge tone="bad">{t('overdue')}</Badge>}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {canFinance && <RegisterCard />}
      {creating && <ManualInvoiceDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

/** The invoice register for the accountant: a workbook of everything issued in a period. */
function RegisterCard() {
  const t = useTranslations('invoices');
  const trpc = useTRPC();
  const [range, setRange] = useState(() => ({
    from: `${cairoTodayIso().slice(0, 7)}-01`,
    to: cairoTodayIso(),
  }));
  const request = useMutation(trpc.invoices.requestRegister.mutationOptions());
  return (
    <Card title={t('register')}>
      <p className="mb-3 text-sm text-muted">{t('registerHint')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('from')}>
          <Input
            type="date"
            value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
        </Field>
        <Field label={t('to')}>
          <Input
            type="date"
            value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </Field>
        <RequestDocumentButton
          label={t('registerExcel')}
          pending={request.isPending}
          error={request.error}
          request={() => request.mutateAsync({ ...range, locale: 'both' })}
        />
      </div>
    </Card>
  );
}

/** An invoice with no booking: a party, a currency and one or more lines typed by hand. */
function ManualInvoiceDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations('invoices');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const router = useRouter();
  const errorText = useErrorText();
  const parties = useQuery(trpc.finance.parties.queryOptions({}));
  const settings = useQuery(trpc.finance.settings.queryOptions());
  const taxes = useQuery(trpc.finance.taxes.queryOptions());
  const [partyId, setPartyId] = useState('');
  const [currency, setCurrency] = useState('');
  const [lines, setLines] = useState([{ ar: '', en: '', amount: '', taxRateId: '' }]);
  const [invalid, setInvalid] = useState(false);
  const create = useMutation(
    trpc.invoices.createDraft.mutationOptions({
      onSuccess: (r) => router.push(`/invoices/${r.invoiceId}`),
    }),
  );
  const cur = currency || settings.data?.base_currency || 'EGP';
  const submit = () => {
    const parsed = lines.map((l) => ({ ...l, minor: parseMoney(l.amount, cur) }));
    if (!partyId || parsed.some((l) => !l.ar.trim() || !l.en.trim() || l.minor === null)) {
      setInvalid(true);
      return;
    }
    create.mutate({
      type: 'invoice',
      billingPartyId: partyId,
      currency: cur,
      manualLines: parsed.map((l) => ({
        descriptionAr: l.ar,
        descriptionEn: l.en,
        unitAmount: l.minor!,
        taxRateId: l.taxRateId || null,
      })),
    });
  };
  return (
    <Dialog open onClose={onClose} title={t('newManual')} wide>
      <div className="flex flex-col gap-3">
        {(parties.data ?? []).length === 0 && <Alert tone="info">{t('noParties')}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('party')}>
            <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">—</option>
              {(parties.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('currency')}>
            <Select value={cur} onChange={(e) => setCurrency(e.target.value)}>
              {(settings.data?.invoice_currencies ?? [cur]).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <LinesEditor lines={lines} onChange={setLines} taxes={taxes.data ?? []} currency={cur} />
        {invalid && <Alert tone="bad">{t('fillLines')}</Alert>}
        {create.isError && <Alert tone="bad">{errorText(create.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button disabled={create.isPending} onClick={submit}>
            {t('createDraft')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export interface LineDraft {
  ar: string;
  en: string;
  amount: string;
  taxRateId: string;
}

/** Hand-typed lines: Arabic and English description, amount, tax. */
export function LinesEditor({
  lines,
  onChange,
  taxes,
  currency,
}: {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  taxes: { id: string; name_ar: string; name_en: string; rate_bps: number; active: boolean }[];
  currency: string;
}) {
  const t = useTranslations('invoices');
  const locale = useLocale();
  const set = (i: number, patch: Partial<LineDraft>) =>
    onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const active = taxes.filter((x) => x.active);
  return (
    <div className="flex flex-col gap-2">
      {lines.map((l, i) => (
        <div key={i} className="grid gap-2 rounded-lg border border-line p-2 sm:grid-cols-6">
          <Input
            className="sm:col-span-2"
            dir="rtl"
            placeholder={t('descriptionAr')}
            value={l.ar}
            onChange={(e) => set(i, { ar: e.target.value })}
          />
          <Input
            className="sm:col-span-2"
            dir="ltr"
            placeholder={t('descriptionEn')}
            value={l.en}
            onChange={(e) => set(i, { en: e.target.value })}
          />
          <Input
            inputMode="decimal"
            dir="ltr"
            placeholder={`${t('amount')} (${currency})`}
            value={l.amount}
            onChange={(e) => set(i, { amount: e.target.value })}
          />
          <div className="flex gap-1">
            {active.length > 0 && (
              <Select
                aria-label={t('tax')}
                value={l.taxRateId}
                onChange={(e) => set(i, { taxRateId: e.target.value })}
              >
                <option value="">{t('noTax')}</option>
                {active.map((x) => (
                  <option key={x.id} value={x.id}>
                    {locale.startsWith('ar') ? x.name_ar : x.name_en} {x.rate_bps / 100}%
                  </option>
                ))}
              </Select>
            )}
            <Button
              variant="ghost"
              aria-label={t('removeLine')}
              onClick={() => onChange(lines.filter((_, j) => j !== i))}
            >
              ×
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          onClick={() => onChange([...lines, { ar: '', en: '', amount: '', taxRateId: '' }])}
        >
          {t('addLine')}
        </Button>
      </div>
    </div>
  );
}
