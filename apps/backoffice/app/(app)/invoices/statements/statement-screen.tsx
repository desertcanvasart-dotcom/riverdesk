'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { RequestDocumentButton } from '../../../../components/documents';
import { Alert, Card, Empty, Field, Input, Select, Table, Td } from '../../../../components/ui';
import { cairoTodayIso } from '../../../../lib/dates';
import { useErrorText } from '../../../../lib/errors';
import { formatDate, formatMoney } from '../../../../lib/format';
import { useTRPC } from '../../../../lib/trpc';

/** A party's statement of account for a period, on screen and as PDF or Excel. */
export function StatementScreen({ initialParty }: { initialParty: string }) {
  const t = useTranslations('receivables');
  const ti = useTranslations('invoices');
  const tr = useTranslations('receipts');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(() => ({
    partyId: initialParty,
    from: `${cairoTodayIso().slice(0, 4)}-01-01`,
    to: cairoTodayIso(),
  }));
  const parties = useQuery(
    trpc.finance.parties.queryOptions({ search: search.trim() || undefined, limit: 100 }),
  );
  const valid = Boolean(form.partyId) && form.from <= form.to;
  const statement = useQuery(
    trpc.receivables.statement.queryOptions(
      { billingPartyId: form.partyId, from: form.from, to: form.to },
      { enabled: valid },
    ),
  );
  const request = useMutation(trpc.receivables.requestStatement.mutationOptions());
  const kindLabel = (kind: string) =>
    kind === 'invoice' || kind === 'credit_note'
      ? ti(`type_${kind}`)
      : tr(`kind_${kind as 'receipt'}`);
  const linkOf = (kind: string, id: string) =>
    kind === 'invoice' || kind === 'credit_note' ? `/invoices/${id}` : `/payments/receipts/${id}`;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label={tr('searchParty')}>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <Field label={tr('party')}>
            <Select
              value={form.partyId}
              onChange={(e) => setForm({ ...form, partyId: e.target.value })}
            >
              <option value="">—</option>
              {(parties.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tc('from')}>
            <Input
              type="date"
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
            />
          </Field>
          <Field label={tc('to')}>
            <Input
              type="date"
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value })}
            />
          </Field>
        </div>
        {valid && (
          <div className="mt-3 flex flex-wrap gap-2">
            {(['ar', 'en', 'both'] as const).map((l) => (
              <RequestDocumentButton
                key={l}
                label={t(`pdf_${l}`)}
                pending={request.isPending}
                request={() =>
                  request.mutateAsync({
                    billingPartyId: form.partyId,
                    from: form.from,
                    to: form.to,
                    locale: l,
                    format: 'pdf',
                  })
                }
              />
            ))}
            <RequestDocumentButton
              label={t('excel')}
              pending={request.isPending}
              error={request.error}
              request={() =>
                request.mutateAsync({
                  billingPartyId: form.partyId,
                  from: form.from,
                  to: form.to,
                  locale: 'both',
                  format: 'xlsx',
                })
              }
            />
          </div>
        )}
      </Card>

      {!valid ? (
        <Empty>{t('pickParty')}</Empty>
      ) : statement.isLoading ? (
        <Empty>{tc('loading')}</Empty>
      ) : statement.isError ? (
        <Alert tone="bad">{errorText(statement.error)}</Alert>
      ) : statement.data!.currencies.length === 0 ? (
        <Empty>{t('noMovements')}</Empty>
      ) : (
        statement.data!.currencies.map((c) => {
          const m = (amount: bigint) => formatMoney(amount, c.currency, locale);
          return (
            <Card key={c.currency} title={t('inCurrency', { currency: c.currency })}>
              <Table head={[t('date'), t('document'), t('debit'), t('credit'), t('balance')]}>
                <tr className="text-muted">
                  <Td>{formatDate(form.from, locale)}</Td>
                  <Td>{t('opening')}</Td>
                  <Td />
                  <Td />
                  <Td className="whitespace-nowrap tabular-nums">{m(c.opening)}</Td>
                </tr>
                {c.rows.map((r) => (
                  <tr key={`${r.kind}-${r.id}`}>
                    <Td className="whitespace-nowrap">{formatDate(r.date, locale)}</Td>
                    <Td>
                      {kindLabel(r.kind)}{' '}
                      <Link href={linkOf(r.kind, r.id)} className="text-brand" dir="ltr">
                        {r.reference}
                      </Link>
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">{r.debit ? m(r.debit) : ''}</Td>
                    <Td className="whitespace-nowrap tabular-nums">
                      {r.credit ? m(r.credit) : ''}
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">{m(r.balance)}</Td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <Td>{formatDate(form.to, locale)}</Td>
                  <Td>{t('closing')}</Td>
                  <Td />
                  <Td />
                  <Td className="whitespace-nowrap tabular-nums">{m(c.closing)}</Td>
                </tr>
              </Table>
              <p className="mt-2 text-sm text-muted">
                {t('openNow', { open: m(c.openInvoices), credit: m(c.unappliedCredit) })}
              </p>
            </Card>
          );
        })
      )}
      <p className="text-xs text-muted">{t('signs')}</p>
    </div>
  );
}
