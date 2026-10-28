'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Dialog } from '../../../../../components/dialog';
import {
  AllocateDialog,
  AttachmentField,
  fileToAttachment,
  ReverseReceiptDialog,
} from '../../../../../components/receipt-dialogs';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  PageHeader,
  Table,
  Td,
} from '../../../../../components/ui';
import { useErrorText } from '../../../../../lib/errors';
import { formatDate, formatDateTime, formatMoney } from '../../../../../lib/format';
import { useTRPC } from '../../../../../lib/trpc';

export function ReceiptScreen({ receiptId }: { receiptId: string }) {
  const t = useTranslations('receipts');
  const tp = useTranslations('payments');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const query = useQuery(trpc.receipts.get.queryOptions({ receiptId }));
  const [dialog, setDialog] = useState<
    'allocate' | 'reverse' | 'attach' | { unallocate: string; number: string } | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const done = (message = t('done')) => {
    setDialog(null);
    setNotice(message);
    void queryClient.invalidateQueries({ queryKey: trpc.receipts.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.invoices.pathKey() });
  };

  if (query.isLoading) return <Empty>{tc('loading')}</Empty>;
  if (!query.data) return <Alert tone="bad">{errorText(query.error)}</Alert>;
  const { receipt, party, allocations, reversedBy, allocated, left } = query.data;
  const money = (amount: bigint, currency = receipt.currency) =>
    formatMoney(amount, currency, locale);
  // Net per invoice: what can be taken back off.
  const byInvoice = new Map<string, { number: string; net: bigint; currency: string }>();
  for (const a of allocations) {
    const row = byInvoice.get(a.invoice_id) ?? {
      number: a.invoice_number ?? '',
      net: 0n,
      currency: a.invoice_currency,
    };
    row.net += a.invoice_amount;
    byInvoice.set(a.invoice_id, row);
  }
  const live = receipt.kind === 'receipt' && !reversedBy;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {t(`kind_${receipt.kind as 'receipt'}`)} · {money(receipt.amount)}
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {reversedBy && <Badge tone="neutral">{t('reversed')}</Badge>}
            <span>{party.name}</span>
            <span dir="ltr">{receipt.reference}</span>
          </span>
        }
        actions={
          <>
            {live && left > 0n && (
              <Button onClick={() => setDialog('allocate')}>{t('allocate')}</Button>
            )}
            {receipt.kind !== 'reversal' && !reversedBy && (
              <Button variant="secondary" onClick={() => setDialog('reverse')}>
                {t('reverse')}
              </Button>
            )}
          </>
        }
      />
      {notice && (
        <div className="mb-4">
          <Alert tone="ok">{notice}</Alert>
        </div>
      )}
      {reversedBy && (
        <div className="mb-4">
          <Alert tone="warn">
            {t('reversedOn', {
              date: formatDate(reversedBy.received_on, locale, 'year'),
              reason: reversedBy.note ?? '',
            })}
          </Alert>
        </div>
      )}
      {receipt.booking_ref && (
        <div className="mb-4">
          <Alert tone="info">{t('fromBooking', { ref: receipt.booking_ref })}</Alert>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('allocations')} className="lg:col-span-2">
          {allocations.length === 0 ? (
            <Empty>{t('noAllocations')}</Empty>
          ) : (
            <Table head={[t('date'), t('invoice'), t('booking'), t('kind'), t('amount')]}>
              {allocations.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap">{formatDateTime(a.created_at, locale)}</Td>
                  <Td>
                    <Link href={`/invoices/${a.invoice_id}`} className="text-brand" dir="ltr">
                      {a.invoice_number}
                    </Link>
                  </Td>
                  <Td>
                    {a.booking_ref ? (
                      <span dir="ltr">{a.booking_ref}</span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td>{t(`reason_${a.reason as 'allocated'}`)}</Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {money(a.amount)}
                    {a.invoice_currency !== receipt.currency && (
                      <span className="block text-xs text-muted">
                        = {money(a.invoice_amount, a.invoice_currency)}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {live && [...byInvoice].some(([, r]) => r.net > 0n) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {[...byInvoice]
                .filter(([, r]) => r.net > 0n)
                .map(([id, r]) => (
                  <Button
                    key={id}
                    variant="ghost"
                    onClick={() => setDialog({ unallocate: id, number: r.number })}
                  >
                    {t('unallocate')} <span dir="ltr">{r.number}</span>
                  </Button>
                ))}
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card title={t('details')}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">{tp('receivedOn')}</dt>
              <dd>{formatDate(receipt.received_on, locale, 'year')}</dd>
              <dt className="text-muted">{tp('method')}</dt>
              <dd>{t(`method_${receipt.method as 'cash'}`)}</dd>
              <dt className="text-muted">{t('allocated')}</dt>
              <dd className="tabular-nums">{money(allocated)}</dd>
              <dt className="text-muted">{t('left')}</dt>
              <dd className="tabular-nums">{money(left)}</dd>
              {receipt.booking_ref && (
                <>
                  <dt className="text-muted">{t('booking')}</dt>
                  <dd>
                    <Link
                      href={`/bookings/${receipt.booking_ref}`}
                      className="text-brand"
                      dir="ltr"
                    >
                      {receipt.booking_ref}
                    </Link>
                  </dd>
                </>
              )}
              {receipt.credit_note_number && (
                <>
                  <dt className="text-muted">{t('creditNote')}</dt>
                  <dd>
                    <Link
                      href={`/invoices/${receipt.credit_note_id}`}
                      className="text-brand"
                      dir="ltr"
                    >
                      {receipt.credit_note_number}
                    </Link>
                  </dd>
                </>
              )}
              {receipt.received_by && (
                <>
                  <dt className="text-muted">{t('receivedBy')}</dt>
                  <dd>{receipt.received_by}</dd>
                </>
              )}
            </dl>
            {receipt.note && <p className="mt-2 text-sm text-muted">{receipt.note}</p>}
          </Card>
          <Card
            title={t('attachment')}
            actions={
              <Button variant="ghost" onClick={() => setDialog('attach')}>
                {receipt.hasAttachment ? t('replaceAttachment') : t('attach')}
              </Button>
            }
          >
            {receipt.hasAttachment ? (
              <a
                href={`/api/receipts/${receipt.id}`}
                target="_blank"
                rel="noopener"
                className="text-brand"
              >
                {t('viewAttachment')} · {receipt.attachment_name}
              </a>
            ) : (
              <p className="text-sm text-muted">—</p>
            )}
          </Card>
        </div>
      </div>

      {dialog === 'allocate' && (
        <AllocateDialog
          receiptId={receipt.id}
          partyId={party.id}
          currency={receipt.currency}
          left={left}
          onClose={() => setDialog(null)}
          onDone={() => done()}
        />
      )}
      {dialog === 'reverse' && (
        <ReverseReceiptDialog
          receiptId={receipt.id}
          onClose={() => setDialog(null)}
          onDone={() => done()}
        />
      )}
      {dialog === 'attach' && (
        <AttachDialog
          receiptId={receipt.id}
          onClose={() => setDialog(null)}
          onDone={() => done(t('attached'))}
        />
      )}
      {dialog && typeof dialog === 'object' && (
        <UnallocateDialog
          receiptId={receipt.id}
          invoiceId={dialog.unallocate}
          number={dialog.number}
          onClose={() => setDialog(null)}
          onDone={() => done()}
        />
      )}
    </>
  );
}

function AttachDialog({
  receiptId,
  onClose,
  onDone,
}: {
  receiptId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('receipts');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [file, setFile] = useState<File | null>(null);
  const attach = useMutation(trpc.receipts.attach.mutationOptions({ onSuccess: onDone }));
  return (
    <Dialog open onClose={onClose} title={t('attach')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!file) return;
          attach.mutate({ receiptId, attachment: await fileToAttachment(file) });
        }}
      >
        <AttachmentField file={file} onChange={setFile} />
        {attach.isError && <Alert tone="bad">{errorText(attach.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button type="submit" disabled={!file || attach.isPending}>
            {t('attach')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function UnallocateDialog({
  receiptId,
  invoiceId,
  number,
  onClose,
  onDone,
}: {
  receiptId: string;
  invoiceId: string;
  number: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('receipts');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const unallocate = useMutation(trpc.receipts.unallocate.mutationOptions({ onSuccess: onDone }));
  return (
    <Dialog open onClose={onClose} title={t('unallocate')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm">{t('unallocateConfirm', { number })}</p>
        {unallocate.isError && <Alert tone="bad">{errorText(unallocate.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button
            variant="danger"
            disabled={unallocate.isPending}
            onClick={() => unallocate.mutate({ receiptId, invoiceId })}
          >
            {t('unallocate')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
