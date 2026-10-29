'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { AccountCodesCard } from '../../../../components/account-codes';
import { Dialog } from '../../../../components/dialog';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Table,
  Td,
} from '../../../../components/ui';
import { useErrorText } from '../../../../lib/errors';
import { useTRPC } from '../../../../lib/trpc';
import { ExtrasCard } from './extras-card';

type Form = {
  legalNameAr: string;
  legalNameEn: string;
  addressAr: string;
  addressEn: string;
  taxRegistrationNo: string;
  commercialRegistrationNo: string;
  bankDetailsAr: string;
  bankDetailsEn: string;
  invoiceNoteAr: string;
  invoiceNoteEn: string;
  etaFooter: boolean;
  baseCurrency: string;
  invoiceCurrencies: string;
  invoicePrefix: string;
  creditNotePrefix: string;
  numberDigits: string;
  firstInvoiceNumber: string;
  firstCreditNoteNumber: string;
  defaultTermsDays: string;
};

export function FinanceSettingsScreen() {
  const t = useTranslations('invoices');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const settings = useQuery(trpc.finance.settings.queryOptions());
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const s = settings.data;
    if (!s || form) return;
    setForm({
      legalNameAr: s.legal_name_ar ?? '',
      legalNameEn: s.legal_name_en ?? '',
      addressAr: s.address_ar ?? '',
      addressEn: s.address_en ?? '',
      taxRegistrationNo: s.tax_registration_no ?? '',
      commercialRegistrationNo: s.commercial_registration_no ?? '',
      bankDetailsAr: s.bank_details_ar ?? '',
      bankDetailsEn: s.bank_details_en ?? '',
      invoiceNoteAr: s.invoice_note_ar ?? '',
      invoiceNoteEn: s.invoice_note_en ?? '',
      etaFooter: s.eta_footer,
      baseCurrency: s.base_currency,
      invoiceCurrencies: s.invoice_currencies.join(', '),
      invoicePrefix: s.invoice_prefix,
      creditNotePrefix: s.credit_note_prefix,
      numberDigits: String(s.number_digits),
      firstInvoiceNumber: String(s.first_invoice_number),
      firstCreditNoteNumber: String(s.first_credit_note_number),
      defaultTermsDays: String(s.default_terms_days),
    });
  }, [settings.data, form]);
  const save = useMutation(
    trpc.finance.updateSettings.mutationOptions({
      onSuccess: () => {
        setSaved(true);
        void queryClient.invalidateQueries({ queryKey: trpc.finance.settings.queryKey() });
      },
    }),
  );
  if (!form || !settings.data) return <Empty>{tc('loading')}</Empty>;
  const locked = settings.data.numberingLocked;
  const anyLocked = locked.invoice || locked.credit_note;
  const set = (patch: Partial<Form>) => {
    setSaved(false);
    setForm({ ...form, ...patch });
  };
  const text = (key: keyof Form, label: string, dir?: 'ltr' | 'rtl', disabled = false) => (
    <Field label={label}>
      <Input
        dir={dir}
        disabled={disabled}
        value={String(form[key])}
        onChange={(e) => set({ [key]: e.target.value } as Partial<Form>)}
      />
    </Field>
  );
  const area = (key: keyof Form, label: string, dir: 'ltr' | 'rtl') => (
    <Field label={label}>
      <textarea
        dir={dir}
        rows={3}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base outline-none focus:border-brand sm:text-sm"
        value={String(form[key])}
        onChange={(e) => set({ [key]: e.target.value } as Partial<Form>)}
      />
    </Field>
  );
  const submit = () =>
    save.mutate({
      legalNameAr: form.legalNameAr,
      legalNameEn: form.legalNameEn,
      addressAr: form.addressAr,
      addressEn: form.addressEn,
      taxRegistrationNo: form.taxRegistrationNo,
      commercialRegistrationNo: form.commercialRegistrationNo,
      bankDetailsAr: form.bankDetailsAr,
      bankDetailsEn: form.bankDetailsEn,
      invoiceNoteAr: form.invoiceNoteAr,
      invoiceNoteEn: form.invoiceNoteEn,
      etaFooter: form.etaFooter,
      defaultTermsDays: Number(form.defaultTermsDays),
      invoiceCurrencies: form.invoiceCurrencies
        .split(/[\s,،]+/)
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
      ...(anyLocked ? {} : { baseCurrency: form.baseCurrency.trim().toUpperCase() }),
      ...(locked.invoice
        ? {}
        : {
            invoicePrefix: form.invoicePrefix.trim().toUpperCase(),
            firstInvoiceNumber: Number(form.firstInvoiceNumber),
          }),
      ...(locked.credit_note
        ? {}
        : {
            creditNotePrefix: form.creditNotePrefix.trim().toUpperCase(),
            firstCreditNoteNumber: Number(form.firstCreditNoteNumber),
          }),
      ...(anyLocked ? {} : { numberDigits: Number(form.numberDigits) }),
    });

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('issuer')}>
        <p className="mb-3 text-sm text-muted">{t('issuerHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {text('legalNameAr', t('legalNameAr'), 'rtl')}
          {text('legalNameEn', t('legalNameEn'), 'ltr')}
          {text('addressAr', t('addressAr'), 'rtl')}
          {text('addressEn', t('addressEn'), 'ltr')}
          {text('taxRegistrationNo', t('taxNo'), 'ltr')}
          {text('commercialRegistrationNo', t('crNo'), 'ltr')}
          {area('bankDetailsAr', t('bankAr'), 'rtl')}
          {area('bankDetailsEn', t('bankEn'), 'ltr')}
          {area('invoiceNoteAr', t('noteAr'), 'rtl')}
          {area('invoiceNoteEn', t('noteEn'), 'ltr')}
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.etaFooter}
            onChange={(e) => set({ etaFooter: e.target.checked })}
          />
          {t('etaFooter')}
        </label>
      </Card>

      <Card title={t('numbering')}>
        {anyLocked && (
          <div className="mb-3">
            <Alert tone="info">{t('numberingLocked')}</Alert>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          {text('invoicePrefix', t('invoicePrefix'), 'ltr', locked.invoice)}
          {text('firstInvoiceNumber', t('firstInvoiceNumber'), 'ltr', locked.invoice)}
          {text('numberDigits', t('numberDigits'), 'ltr', anyLocked)}
          {text('creditNotePrefix', t('creditNotePrefix'), 'ltr', locked.credit_note)}
          {text('firstCreditNoteNumber', t('firstCreditNoteNumber'), 'ltr', locked.credit_note)}
          <div className="text-sm text-muted sm:self-end" dir="ltr">
            {form.invoicePrefix}-{new Date().getFullYear()}-
            {String(Number(form.firstInvoiceNumber) || 1).padStart(
              Number(form.numberDigits) || 5,
              '0',
            )}
          </div>
          {text('baseCurrency', t('baseCurrency'), 'ltr', anyLocked)}
          {text('invoiceCurrencies', t('invoiceCurrencies'), 'ltr')}
          {text('defaultTermsDays', t('defaultTermsDays'), 'ltr')}
        </div>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {saved && <Badge tone="ok">{t('saved')}</Badge>}
        {save.isError && <Alert tone="bad">{errorText(save.error)}</Alert>}
        <Button disabled={save.isPending} onClick={submit}>
          {tc('save')}
        </Button>
      </div>

      <TaxesCard />
      <ExtrasCard />
      <AccountCodesCard />
    </div>
  );
}

type Tax = {
  id: string;
  name_ar: string;
  name_en: string;
  rate_bps: number;
  inclusive: boolean;
  is_default: boolean;
  active: boolean;
  sort_order: number;
};

function TaxesCard() {
  const t = useTranslations('invoices');
  const locale = useLocale();
  const trpc = useTRPC();
  const taxes = useQuery(trpc.finance.taxes.queryOptions());
  const [editing, setEditing] = useState<Tax | 'new' | null>(null);
  const rows = (taxes.data ?? []) as Tax[];
  return (
    <Card
      title={t('taxes')}
      actions={<Button onClick={() => setEditing('new')}>{t('addTax')}</Button>}
    >
      <p className="mb-3 text-sm text-muted">{t('taxesHint')}</p>
      {rows.length === 0 ? (
        <Empty>{t('noTaxes')}</Empty>
      ) : (
        <Table head={[t('taxName'), t('rate'), t('taxKind'), '', '']}>
          {rows.map((x) => (
            <tr key={x.id}>
              <Td>{locale.startsWith('ar') ? x.name_ar : x.name_en}</Td>
              <Td className="tabular-nums">{x.rate_bps / 100}%</Td>
              <Td>{x.inclusive ? t('inclusive') : t('exclusive')}</Td>
              <Td>
                <span className="flex gap-1">
                  {x.is_default && <Badge tone="brand">{t('default')}</Badge>}
                  {!x.active && <Badge>{t('inactive')}</Badge>}
                </span>
              </Td>
              <Td>
                <Button variant="ghost" onClick={() => setEditing(x)}>
                  {t('edit')}
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {editing && (
        <TaxDialog tax={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </Card>
  );
}

function TaxDialog({ tax, onClose }: { tax: Tax | null; onClose: () => void }) {
  const t = useTranslations('invoices');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [form, setForm] = useState({
    nameAr: tax?.name_ar ?? '',
    nameEn: tax?.name_en ?? '',
    rate: tax ? String(tax.rate_bps / 100) : '14',
    inclusive: tax?.inclusive ?? true,
    isDefault: tax?.is_default ?? false,
    active: tax?.active ?? true,
  });
  const save = useMutation(
    trpc.finance.saveTax.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.finance.taxes.queryKey() });
        onClose();
      },
    }),
  );
  const bps = Math.round(Number(form.rate) * 100);
  const valid = form.nameAr.trim() && form.nameEn.trim() && bps >= 0 && bps <= 10000;
  return (
    <Dialog open onClose={onClose} title={tax ? t('editTax') : t('addTax')}>
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('taxNameAr')}>
            <Input
              dir="rtl"
              value={form.nameAr}
              onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
            />
          </Field>
          <Field label={t('taxNameEn')}>
            <Input
              dir="ltr"
              value={form.nameEn}
              onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
            />
          </Field>
          <Field label={t('ratePercent')}>
            <Input
              inputMode="decimal"
              dir="ltr"
              value={form.rate}
              onChange={(e) => setForm({ ...form, rate: e.target.value })}
            />
          </Field>
        </div>
        {[
          ['inclusive', t('inclusiveHint')],
          ['isDefault', t('defaultHint')],
          ['active', t('activeLabel')],
        ].map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form[key as 'inclusive']}
              onChange={(e) => setForm({ ...form, [key as string]: e.target.checked })}
            />
            {label}
          </label>
        ))}
        {save.isError && <Alert tone="bad">{errorText(save.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button
            disabled={save.isPending || !valid}
            onClick={() =>
              save.mutate({
                ...(tax ? { id: tax.id } : {}),
                nameAr: form.nameAr.trim(),
                nameEn: form.nameEn.trim(),
                rateBps: bps,
                inclusive: form.inclusive,
                isDefault: form.isDefault && form.active,
                active: form.active,
              })
            }
          >
            {tc('save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
