'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  METHODS,
  RecordPaymentDialog,
  RefundDialog,
  ReverseDialog,
} from '../../../components/payment-dialogs';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Input,
  Select,
  Table,
  Td,
  cx,
} from '../../../components/ui';
import { addDaysIso, cairoTodayIso } from '../../../lib/dates';
import { formatDate, formatMoney } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';

export function PaymentsScreen({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations('payments');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState(() => ({
    from: addDaysIso(cairoTodayIso(), -30),
    to: cairoTodayIso(),
    method: '',
  }));
  const [dialog, setDialog] = useState<'record' | 'refund' | { reverse: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ledger = useQuery(
    trpc.payments.ledger.queryOptions({
      from: filters.from || undefined,
      to: filters.to || undefined,
      method: filters.method || undefined,
    }),
  );
  const done = () => {
    setDialog(null);
    setNotice(t('recorded'));
    void queryClient.invalidateQueries({ queryKey: trpc.payments.ledger.queryKey() });
  };
  const rows = ledger.data?.payments ?? [];

  return (
    <div className="flex flex-col gap-4">
      {notice && <Alert tone="ok">{notice}</Alert>}
      <Card
        actions={
          canWrite && (
            <div className="flex gap-2">
              <Button onClick={() => setDialog('record')}>{t('record')}</Button>
              <Button variant="secondary" onClick={() => setDialog('refund')}>
                {t('refund')}
              </Button>
            </div>
          )
        }
      >
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Input
            type="date"
            aria-label={tc('from')}
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
          <Input
            type="date"
            aria-label={tc('to')}
            value={filters.to}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
          <Select
            className="col-span-2 sm:col-span-1"
            aria-label={t('method')}
            value={filters.method}
            onChange={(e) => setFilters({ ...filters, method: e.target.value })}
          >
            <option value="">{t('anyMethod')}</option>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`method_${m}`)}
              </option>
            ))}
          </Select>
        </div>
        {ledger.data && ledger.data.totals.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <span className="text-muted">{t('totals')}:</span>
            {ledger.data.totals.map((x) => (
              <Badge key={`${x.currency}-${x.kind}`} tone={x.amount < 0n ? 'warn' : 'ok'}>
                {t(`kind_${x.kind}` as 'kind_payment')} {formatMoney(x.amount, x.currency, locale)}
              </Badge>
            ))}
          </div>
        )}
        {ledger.isLoading ? (
          <Empty>{tc('loading')}</Empty>
        ) : rows.length === 0 ? (
          <Empty>{t('noPayments')}</Empty>
        ) : (
          <Table
            head={[
              t('date'),
              t('bookingRef'),
              t('kind'),
              t('method'),
              t('amount'),
              t('reference'),
              t('by'),
              '',
            ]}
          >
            {rows.map((p) => (
              <tr key={p.id} className={cx(p.reversed && 'text-muted')}>
                <Td className="whitespace-nowrap">{formatDate(p.receivedOn, locale)}</Td>
                <Td>
                  <Link href={`/bookings/${p.ref}`} className="text-brand" dir="ltr">
                    {p.ref}
                  </Link>
                </Td>
                <Td>
                  {t(`kind_${p.kind}` as 'kind_payment')}
                  {p.reversed && (
                    <span className="ms-1">
                      <Badge tone="neutral">{t('reversed')}</Badge>
                    </span>
                  )}
                </Td>
                <Td>{t(`method_${p.method}` as 'method_cash')}</Td>
                <Td className="whitespace-nowrap tabular-nums">
                  {formatMoney(p.amount, p.currency, locale)}
                  {p.currency !== p.bookingCurrency && (
                    <span className="block text-xs text-muted">
                      = {formatMoney(p.bookingAmount, p.bookingCurrency, locale)}
                    </span>
                  )}
                </Td>
                <Td>
                  <span dir="ltr">{p.reference}</span>
                </Td>
                <Td>{p.actor}</Td>
                <Td>
                  {canWrite && !p.reversed && p.kind !== 'reversal' && (
                    <Button variant="ghost" onClick={() => setDialog({ reverse: p.id })}>
                      {t('reverse')}
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {dialog === 'record' && <RecordPaymentDialog onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'refund' && <RefundDialog onClose={() => setDialog(null)} onDone={done} />}
      {dialog && typeof dialog === 'object' && (
        <ReverseDialog paymentId={dialog.reverse} onClose={() => setDialog(null)} onDone={done} />
      )}
    </div>
  );
}
