'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { DocumentButtons } from '../../../../components/documents';
import { Badge, Card, Table, Td } from '../../../../components/ui';
import { formatMoney } from '../../../../lib/format';
import { useTRPC } from '../../../../lib/trpc';

/** Extras on board (E3): the booking's folios, their invoices and what is still to pay. */
export function FoliosCard({
  bookingId,
  canInvoices,
  canDocuments,
}: {
  bookingId: string;
  canInvoices: boolean;
  canDocuments: boolean;
}) {
  const t = useTranslations('folios');
  const locale = useLocale();
  const trpc = useTRPC();
  const folios = useQuery(trpc.folios.ofBooking.queryOptions({ bookingId }));
  if (!folios.data?.length) return null;
  return (
    <Card title={t('bookingTitle')}>
      <Table head={[t('cabin'), t('charges'), t('total'), t('invoice'), '']}>
        {folios.data.map((f) => (
          <tr key={f.folioId}>
            <Td className="font-medium tabular-nums">
              <span dir="ltr">{f.cabin ?? '—'}</span>
            </Td>
            <Td className="tabular-nums">{f.charges}</Td>
            <Td className="whitespace-nowrap tabular-nums">
              {formatMoney(f.total, f.currency, locale)}
            </Td>
            <Td>
              {f.invoice ? (
                <span className="flex flex-wrap items-center gap-2">
                  {canInvoices ? (
                    <Link href={`/invoices/${f.invoice.id}`} className="underline" dir="ltr">
                      {f.invoice.number}
                    </Link>
                  ) : (
                    <span dir="ltr">{f.invoice.number}</span>
                  )}
                  {f.billTo === 'agency' && <Badge>{t('agencyPays')}</Badge>}
                  <Badge tone={f.invoice.balance > 0n ? 'warn' : 'ok'}>
                    {f.invoice.balance > 0n
                      ? `${t('toPay')} ${formatMoney(f.invoice.balance, f.currency, locale)}`
                      : t('paid')}
                  </Badge>
                </span>
              ) : (
                <Badge tone={f.status === 'open' ? 'info' : 'neutral'}>
                  {t(f.status === 'open' ? 'statusOpen' : 'statusVoid')}
                </Badge>
              )}
            </Td>
            <Td>
              {canDocuments && (
                <DocumentButtons
                  items={[
                    {
                      key: f.folioId,
                      label: t('print'),
                      input: { kind: 'guest_folio', folioId: f.folioId },
                    },
                  ]}
                />
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
