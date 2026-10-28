'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useErrorText } from '../lib/errors';
import { useTRPC } from '../lib/trpc';
import { Alert, Card, Empty, Input } from './ui';

type Kind =
  | 'receivables'
  | 'cash'
  | 'bank'
  | 'commission'
  | 'tax_payable'
  | 'revenue_vessel'
  | 'revenue_channel';

/**
 * Invoicing F5: the codes of the company's chart of accounts the journal export uses. One per
 * kind, and per vessel, agency channel or tax; a blank code leaves the default for its kind.
 */
export function AccountCodesCard() {
  const t = useTranslations('financeReports');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const data = useQuery(trpc.financeReports.accountCodes.queryOptions());
  const save = useMutation(
    trpc.financeReports.saveAccountCode.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.financeReports.accountCodes.queryKey() }),
    }),
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (data.isLoading)
    return (
      <Card title={t('codesTitle')}>
        <Empty>{tc('loading')}</Empty>
      </Card>
    );
  if (!data.data) return <Alert tone="bad">{errorText(data.error)}</Alert>;
  const { codes, vessels, channels, taxes } = data.data;
  const codeOf = (kind: Kind, ref: string | null) =>
    codes.find((c) => c.kind === kind && c.ref_id === ref)?.code ?? '';
  const row = (kind: Kind, ref: string | null, label: string) => {
    const key = `${kind}|${ref ?? ''}`;
    const value = drafts[key] ?? codeOf(kind, ref);
    return (
      <div key={key} className="grid grid-cols-[1fr_9rem] items-center gap-2 py-1 text-sm">
        <span>{label}</span>
        <Input
          dir="ltr"
          maxLength={30}
          aria-label={label}
          value={value}
          onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
          onBlur={() => {
            if (value.trim() !== codeOf(kind, ref))
              save.mutate({ kind, refId: ref, code: value.trim() || null });
          }}
        />
      </div>
    );
  };
  return (
    <Card title={t('codesTitle')}>
      <p className="mb-3 text-sm text-muted">{t('codesHint')}</p>
      {save.isError && <Alert tone="bad">{errorText(save.error)}</Alert>}
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          {(['receivables', 'cash', 'bank', 'commission'] as const).map((k) =>
            row(k, null, t(`account_${k}`)),
          )}
          {row('tax_payable', null, `${t('account_tax_payable')} · ${t('default')}`)}
          {taxes.map((x) => row('tax_payable', x.id, `${t('account_tax_payable')} · ${x.name}`))}
        </div>
        <div>
          {row('revenue_vessel', null, `${t('account_revenue_vessel')} · ${t('default')}`)}
          {vessels.map((v) =>
            row('revenue_vessel', v.id, `${t('account_revenue_vessel')} · ${v.name}`),
          )}
          {channels
            .filter((c) => c.type !== 'back_office')
            .map((c) =>
              row('revenue_channel', c.id, `${t('account_revenue_channel')} · ${c.name}`),
            )}
        </div>
      </div>
    </Card>
  );
}
