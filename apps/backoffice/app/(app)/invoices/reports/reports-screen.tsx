'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { RequestDocumentButton } from '../../../../components/documents';
import { Alert, Card, Empty, Field, Input, Select, Table, Td, cx } from '../../../../components/ui';
import { cairoTodayIso } from '../../../../lib/dates';
import { useErrorText } from '../../../../lib/errors';
import { formatDate, formatMoney } from '../../../../lib/format';
import { useTRPC } from '../../../../lib/trpc';

const REPORTS = ['revenue', 'production', 'collections', 'outstanding'] as const;
const EXPORTS = ['invoices', 'payments', 'journal'] as const;
type Report = (typeof REPORTS)[number];
type Cell = string | number | bigint | null;

/** One finance table on screen: money in each row's currency, dates in the user's language. */
function FinanceTableView({
  columns,
  rows,
}: {
  columns: { key: string; type: string }[];
  rows: Record<string, Cell>[];
}) {
  const t = useTranslations('financeReports');
  const locale = useLocale();
  const show = (type: string, key: string, row: Record<string, Cell>) => {
    const value = row[key];
    if (value === null || value === undefined || value === '') return '—';
    if (type === 'money')
      return formatMoney(
        value as bigint,
        String(key.startsWith('base_') ? row.base_currency : row.currency),
        locale,
      );
    if (type === 'date') return formatDate(String(value), locale);
    if (key === 'method') return t(`method_${value as 'cash'}`);
    return String(value);
  };
  return (
    <Table head={columns.map((c) => t(`col_${c.key as 'net'}`))}>
      {rows.map((row, i) => (
        <tr key={i}>
          {columns.map((c) => (
            <Td
              key={c.key}
              className={cx(
                (c.type === 'money' || c.type === 'number') && 'whitespace-nowrap tabular-nums',
              )}
            >
              {show(c.type, c.key, row)}
            </Td>
          ))}
        </tr>
      ))}
    </Table>
  );
}

export function ReportsScreen({
  canFinance,
  vessels,
  channels,
}: {
  canFinance: boolean;
  vessels: { id: string; name: string }[];
  channels: { id: string; name: string }[];
}) {
  const t = useTranslations('financeReports');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [report, setReport] = useState<Report>('revenue');
  const [filters, setFilters] = useState(() => ({
    from: `${cairoTodayIso().slice(0, 7)}-01`,
    to: cairoTodayIso(),
    vesselId: '',
    channelId: '',
  }));
  const input = {
    report,
    from: filters.from,
    to: filters.to,
    vesselId: filters.vesselId || undefined,
    channelId: filters.channelId || undefined,
  };
  const valid = Boolean(filters.from && filters.to && filters.from <= filters.to);
  const data = useQuery(trpc.financeReports.report.queryOptions(input, { enabled: valid }));
  const request = useMutation(trpc.financeReports.requestReport.mutationOptions());

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <nav className="mb-3 flex flex-wrap gap-1 border-b border-line">
          {REPORTS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReport(r)}
              aria-current={report === r ? 'page' : undefined}
              className={cx(
                'border-b-2 px-3 py-2 text-sm',
                report === r
                  ? 'border-brand font-medium text-brand'
                  : 'border-transparent text-muted',
              )}
            >
              {t(`report_${r}`)}
            </button>
          ))}
        </nav>
        <p className="mb-3 text-sm text-muted">{t(`hint_${report}`)}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {report !== 'outstanding' && (
            <Field label={tc('from')}>
              <Input
                type="date"
                value={filters.from}
                onChange={(e) => setFilters({ ...filters, from: e.target.value })}
              />
            </Field>
          )}
          <Field label={report === 'outstanding' ? t('asOf') : tc('to')}>
            <Input
              type="date"
              value={filters.to}
              onChange={(e) => setFilters({ ...filters, to: e.target.value })}
            />
          </Field>
          {(report === 'revenue' || report === 'production') && (
            <Field label={t('vessel')}>
              <Select
                value={filters.vesselId}
                onChange={(e) => setFilters({ ...filters, vesselId: e.target.value })}
              >
                <option value="">{t('all')}</option>
                {vessels.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {report !== 'outstanding' && (
            <Field label={t('channel')}>
              <Select
                value={filters.channelId}
                onChange={(e) => setFilters({ ...filters, channelId: e.target.value })}
              >
                <option value="">{t('all')}</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {valid && (
          <div className="mt-3 flex flex-wrap gap-2">
            {(['xlsx', 'csv'] as const).map((format) => (
              <RequestDocumentButton
                key={format}
                label={t(`file_${format}`)}
                pending={request.isPending}
                error={format === 'csv' ? request.error : undefined}
                request={() => request.mutateAsync({ ...input, format, locale: 'both' })}
              />
            ))}
          </div>
        )}
      </Card>
      <Card>
        {!valid ? (
          <Empty>{t('pickPeriod')}</Empty>
        ) : data.isLoading ? (
          <Empty>{tc('loading')}</Empty>
        ) : data.isError ? (
          <Alert tone="bad">{errorText(data.error)}</Alert>
        ) : data.data!.rows.length === 0 ? (
          <Empty>{t('noRows')}</Empty>
        ) : (
          <FinanceTableView columns={data.data!.columns} rows={data.data!.rows} />
        )}
      </Card>
      {canFinance && <AccountantExport />}
    </div>
  );
}

/** The accountant's files: invoices, payments, or the journal with the codes still to set. */
function AccountantExport() {
  const t = useTranslations('financeReports');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const [form, setForm] = useState(() => ({
    content: 'journal' as (typeof EXPORTS)[number],
    from: `${cairoTodayIso().slice(0, 7)}-01`,
    to: cairoTodayIso(),
  }));
  const valid = Boolean(form.from && form.to && form.from <= form.to);
  const preview = useQuery(
    trpc.financeReports.exportPreview.queryOptions(form, {
      enabled: valid && form.content === 'journal',
    }),
  );
  const request = useMutation(trpc.financeReports.requestExport.mutationOptions());
  const unmapped = preview.data?.unmapped ?? [];
  return (
    <Card title={t('exportTitle')}>
      <p className="mb-3 text-sm text-muted">{t('exportHint')}</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label={t('exportContent')}>
          <Select
            value={form.content}
            onChange={(e) =>
              setForm({ ...form, content: e.target.value as (typeof EXPORTS)[number] })
            }
          >
            {EXPORTS.map((c) => (
              <option key={c} value={c}>
                {t(`export_${c}`)}
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
      {form.content === 'journal' && unmapped.length > 0 && (
        <div className="mt-3">
          <Alert tone="warn">
            {t('unmapped', {
              list: unmapped
                .map((u) => `${t(`account_${u.kind as 'cash'}`)}${u.ref ? ` (${u.ref})` : ''}`)
                .join(', '),
            })}{' '}
            <Link href="/invoices/settings" className="underline">
              {t('setCodes')}
            </Link>
          </Alert>
        </div>
      )}
      {valid && (
        <div className="mt-3 flex flex-wrap gap-2">
          {(['xlsx', 'csv'] as const).map((format) => (
            <RequestDocumentButton
              key={format}
              label={t(`file_${format}`)}
              pending={request.isPending}
              error={format === 'csv' ? request.error : undefined}
              request={() => request.mutateAsync({ ...form, format, locale: 'en' })}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
