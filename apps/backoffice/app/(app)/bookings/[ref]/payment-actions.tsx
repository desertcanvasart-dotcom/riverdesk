'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RecordPaymentDialog, RefundDialog } from '../../../../components/payment-dialogs';
import { Button } from '../../../../components/ui';

export function PaymentActions({
  bookingRef,
  canRefund,
}: {
  bookingRef: string;
  canRefund: boolean;
}) {
  const t = useTranslations('payments');
  const router = useRouter();
  const [open, setOpen] = useState<'record' | 'refund' | null>(null);
  const done = () => {
    setOpen(null);
    router.refresh();
  };
  return (
    <div className="flex gap-2">
      <Button variant="secondary" onClick={() => setOpen('record')}>
        {t('record')}
      </Button>
      {canRefund && (
        <Button variant="ghost" onClick={() => setOpen('refund')}>
          {t('refund')}
        </Button>
      )}
      {open === 'record' && (
        <RecordPaymentDialog bookingRef={bookingRef} onClose={() => setOpen(null)} onDone={done} />
      )}
      {open === 'refund' && (
        <RefundDialog bookingRef={bookingRef} onClose={() => setOpen(null)} onDone={done} />
      )}
    </div>
  );
}
