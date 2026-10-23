'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Dialog } from '../../../../components/dialog';
import { Alert, Button, Field, Input } from '../../../../components/ui';
import { useErrorText } from '../../../../lib/errors';
import { formatMoney } from '../../../../lib/format';
import { newRequestKey, useTRPC } from '../../../../lib/trpc';

/** The penalty is shown before anything is cancelled. */
export function CancelPanel({ bookingId, bookingRef }: { bookingId: string; bookingRef: string }) {
  const t = useTranslations('bookings');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const requestKey = useMemo(() => newRequestKey(), [open]);
  const preview = useQuery(
    trpc.bookings.cancelPreview.queryOptions({ bookingId }, { enabled: open }),
  );
  const cancel = useMutation(
    trpc.bookings.cancel.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        router.refresh();
      },
    }),
  );
  const p = preview.data;
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        {t('cancel')}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('cancelTitle', { ref: `\u2066${bookingRef}\u2069` })}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            cancel.mutate({ bookingId, reason: reason.trim(), requestKey });
          }}
        >
          {preview.isLoading ? (
            <p className="text-sm text-muted">{tc('loading')}</p>
          ) : p ? (
            <Alert tone={p.penalty > 0n ? 'warn' : 'info'}>
              {p.daysBefore === null
                ? t('cancelHeld')
                : t('cancelPreview', {
                    days: p.daysBefore,
                    bps: p.penaltyBps / 100,
                    penalty: formatMoney(p.penalty, p.currency, locale),
                  })}
            </Alert>
          ) : null}
          <Field label={t('cancelReason')}>
            <Input
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
            />
          </Field>
          {cancel.isError && <Alert tone="bad">{errorText(cancel.error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {tc('close')}
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={!p || !reason.trim() || cancel.isPending}
            >
              {t('cancelConfirm')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
