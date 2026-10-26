'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Badge, Button, Card, Empty } from '../../../../components/ui';
import { useErrorText } from '../../../../lib/errors';
import { formatMoney } from '../../../../lib/format';
import { useTRPC } from '../../../../lib/trpc';
import { invoiceTone } from '../../invoices/invoice-status';

/** A booking's proformas, invoices and credit notes, with the buttons to start one. */
export function InvoicesCard({
  bookingId,
  status,
  canDraft,
  canFinance,
}: {
  bookingId: string;
  status: string;
  canDraft: boolean;
  canFinance: boolean;
}) {
  const t = useTranslations('invoices');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const errorText = useErrorText();
  const list = useQuery(trpc.invoices.list.queryOptions({ bookingId }));
  const go = { onSuccess: (r: { invoiceId: string }) => router.push(`/invoices/${r.invoiceId}`) };
  const proforma = useMutation(trpc.invoices.createProforma.mutationOptions(go));
  const invoice = useMutation(trpc.invoices.createDraft.mutationOptions(go));
  const rows = list.data ?? [];
  const canProforma = ['requested', 'held', 'offered', 'confirmed', 'completed'].includes(status);
  const canInvoice = ['confirmed', 'completed', 'cancelled'].includes(status);
  const error = proforma.error ?? invoice.error;
  return (
    <Card
      title={t('title')}
      actions={
        <div className="flex gap-2">
          {canDraft && canProforma && (
            <Button
              variant="secondary"
              disabled={proforma.isPending}
              onClick={() => proforma.mutate({ type: 'proforma', bookingIds: [bookingId] })}
            >
              {t('newProforma')}
            </Button>
          )}
          {canFinance && canInvoice && (
            <Button
              disabled={invoice.isPending}
              onClick={() => invoice.mutate({ type: 'invoice', bookingIds: [bookingId] })}
            >
              {t('newInvoice')}
            </Button>
          )}
        </div>
      }
    >
      {error && (
        <div className="mb-2">
          <Alert tone="bad">{errorText(error)}</Alert>
        </div>
      )}
      {list.isLoading ? (
        <Empty>{tc('loading')}</Empty>
      ) : rows.length === 0 ? (
        <Empty>{t('noneForBooking')}</Empty>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <Link href={`/invoices/${r.id}`} className="text-brand">
                {t(`type_${r.type as 'invoice'}`)} {r.number && <span dir="ltr">{r.number}</span>}
              </Link>
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{formatMoney(r.total, r.currency, locale)}</span>
                <Badge tone={invoiceTone(r.status)}>{t(`status_${r.status as 'draft'}`)}</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
