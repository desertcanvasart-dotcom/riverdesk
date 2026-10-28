'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { RequestDocumentButton } from '../../../../components/documents';
import { Alert, Card, Empty, Field, Input, Table, Td } from '../../../../components/ui';
import { cairoTodayIso } from '../../../../lib/dates';
import { useErrorText } from '../../../../lib/errors';
import { formatMoney } from '../../../../lib/format';
import { useTRPC } from '../../../../lib/trpc';

const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;

/** Open invoice balances by days past due, per party and currency, as of a date. */
export function AgingScreen() {
  const t = useTranslations('receivables');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [asOf, setAsOf] = useState(cairoTodayIso());
  const aging = useQuery(trpc.receivables.aging.queryOptions({ asOf: asOf || undefined }));
  const request = useMutation(trpc.receivables.requestAging.mutationOptions());
  const currencies = aging.data?.totals ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('asOf')}>
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          <RequestDocumentButton
            label={t('excel')}
            pending={request.isPending}
            error={request.error}
            request={() => request.mutateAsync({ asOf: asOf || undefined, locale: 'both' })}
          />
        </div>
      </Card>
      {aging.isLoading ? (
        <Empty>{tc('loading')}</Empty>
      ) : aging.isError ? (
        <Alert tone="bad">{errorText(aging.error)}</Alert>
      ) : currencies.length === 0 ? (
        <Empty>{t('nothingOpen')}</Empty>
      ) : (
        currencies.map((total) => {
          const m = (amount: bigint) =>
            amount === 0n ? '—' : formatMoney(amount, total.currency, locale);
          const rows = aging.data!.rows.filter((r) => r.currency === total.currency);
          return (
            <Card key={total.currency} title={t('inCurrency', { currency: total.currency })}>
              <Table
                head={[
                  t('party'),
                  ...BUCKETS.map((b) => t(`bucket_${b}`)),
                  t('open'),
                  t('unapplied'),
                  t('net'),
                ]}
              >
                {rows.map((r) => (
                  <tr key={r.partyId}>
                    <Td>
                      <Link href={`/invoices/statements?party=${r.partyId}`} className="text-brand">
                        {r.partyName}
                      </Link>
                    </Td>
                    {BUCKETS.map((b) => (
                      <Td key={b} className="whitespace-nowrap tabular-nums">
                        {m(r.buckets[b])}
                      </Td>
                    ))}
                    <Td className="whitespace-nowrap tabular-nums">{m(r.total)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{m(r.unappliedCredit)}</Td>
                    <Td className="whitespace-nowrap font-medium tabular-nums">{m(r.net)}</Td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <Td>{t('allParties')}</Td>
                  {BUCKETS.map((b) => (
                    <Td key={b} className="whitespace-nowrap tabular-nums">
                      {m(total.buckets[b])}
                    </Td>
                  ))}
                  <Td className="whitespace-nowrap tabular-nums">{m(total.total)}</Td>
                  <Td className="whitespace-nowrap tabular-nums">{m(total.unappliedCredit)}</Td>
                  <Td className="whitespace-nowrap tabular-nums">{m(total.net)}</Td>
                </tr>
              </Table>
            </Card>
          );
        })
      )}
    </div>
  );
}
