'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Paperclip } from 'lucide-react';
import { PartyRefundDialog, RecordReceiptDialog } from '../../../../components/receipt-dialogs';
import { Alert, Badge, Button, Card, Empty, Input, Table, Td, cx } from '../../../../components/ui';
import { addDaysIso, cairoTodayIso } from '../../../../lib/dates';
import { formatDate, formatMoney } from '../../../../lib/format';
import { useTRPC } from '../../../../lib/trpc';

export function ReceiptsScreen() {
  const t = useTranslations('receipts');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState(() => ({
    from: addDaysIso(cairoTodayIso(), -60),
    to: cairoTodayIso(),
    unallocated: false,
  }));
  const [dialog, setDialog] = useState<'record' | 'refund' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useQuery(
    trpc.receipts.list.queryOptions({
      from: filters.unallocated ? undefined : filters.from || undefined,
      to: filters.unallocated ? undefined : filters.to || undefined,
      unallocated: filters.unallocated || undefined,
    }),
  );
  const rows = list.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      {notice && <Alert tone="ok">{notice}</Alert>}
      <Card
        actions={
          <div className="flex gap-2">
            <Button onClick={() => setDialog('record')}>{t('record')}</Button>
            <Button variant="secondary" onClick={() => setDialog('refund')}>
              {t('refundCredit')}
            </Button>
          </div>
        }
      >
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Input
            type="date"
            aria-label={tc('from')}
            disabled={filters.unallocated}
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
          <Input
            type="date"
            aria-label={tc('to')}
            disabled={filters.unallocated}
            value={filters.to}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
          <label className="col-span-2 flex items-center gap-2 text-sm sm:col-span-1">
            <input
              type="checkbox"
              checked={filters.unallocated}
              onChange={(e) => setFilters({ ...filters, unallocated: e.target.checked })}
            />
            {t('unallocatedOnly')}
          </label>
        </div>
        {list.isLoading ? (
          <Empty>{tc('loading')}</Empty>
        ) : rows.length === 0 ? (
          <Empty>{t('noReceipts')}</Empty>
        ) : (
          <Table
            head={[
              t('date'),
              t('party'),
              t('kind'),
              t('amount'),
              t('allocated'),
              t('left'),
              t('booking'),
              '',
            ]}
          >
            {rows.map((r) => (
              <tr key={r.id} className={cx(r.reversed && 'text-muted')}>
                <Td className="whitespace-nowrap">
                  <Link href={`/payments/receipts/${r.id}`} className="text-brand">
                    {formatDate(r.received_on, locale)}
                  </Link>
                </Td>
                <Td>
                  {r.party_name}
                  <span className="block text-xs text-muted" dir="ltr">
                    {r.reference}
                  </span>
                </Td>
                <Td>
                  {t(`kind_${r.kind as 'receipt'}`)}
                  {r.reversed && (
                    <span className="ms-1">
                      <Badge tone="neutral">{t('reversed')}</Badge>
                    </span>
                  )}
                  <span className="block text-xs text-muted">
                    {t(`method_${r.method as 'cash'}`)}
                  </span>
                </Td>
                <Td className="whitespace-nowrap tabular-nums">
                  {formatMoney(r.amount, r.currency, locale)}
                </Td>
                <Td className="whitespace-nowrap tabular-nums">
                  {r.allocated !== 0n ? formatMoney(r.allocated, r.currency, locale) : '—'}
                </Td>
                <Td className="whitespace-nowrap tabular-nums">
                  {r.left > 0n ? (
                    <Badge tone="warn">{formatMoney(r.left, r.currency, locale)}</Badge>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td>
                  {r.booking_ref ? (
                    <Link href={`/bookings/${r.booking_ref}`} className="text-brand" dir="ltr">
                      {r.booking_ref}
                    </Link>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td>
                  {r.hasAttachment && (
                    <Paperclip aria-label={t('attachment')} className="size-4 text-muted" />
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {dialog === 'record' && (
        <RecordReceiptDialog
          onClose={() => setDialog(null)}
          onDone={(id) => router.push(`/payments/receipts/${id}`)}
        />
      )}
      {dialog === 'refund' && (
        <PartyRefundDialog
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setNotice(t('done'));
            void queryClient.invalidateQueries({ queryKey: trpc.receipts.pathKey() });
          }}
        />
      )}
    </div>
  );
}
