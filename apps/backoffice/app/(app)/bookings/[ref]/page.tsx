import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { TRPCError } from '@trpc/server';
import { DocumentButtons } from '../../../../components/documents';
import { Alert, Badge, Card, PageHeader, Table, Td } from '../../../../components/ui';
import { formatDate, formatDateTime, formatMoney } from '../../../../lib/format';
import { statusTone } from '../../../../lib/status';
import { serverCaller } from '../../../../server/caller';
import { AmendPanel } from './amend-panel';
import { CancelPanel } from './cancel-panel';
import { GuestsEditor } from './guests-editor';
import { InvoicesCard } from './invoices-card';
import { PaymentActions } from './payment-actions';

export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ ref: string }>;
  searchParams: Promise<{ credit?: string }>;
}) {
  const { ref } = await params;
  const { credit } = await searchParams;
  const caller = await serverCaller();
  const booking = await caller.bookings
    .detail({ ref: decodeURIComponent(ref) })
    .catch((error: unknown) => {
      if (error instanceof TRPCError && error.code === 'NOT_FOUND') notFound();
      throw error;
    });
  const [profile, vessels] = await Promise.all([caller.me.profile(), caller.book.vessels()]);
  const canWrite = profile.permissions.includes('bookings.write');
  const canPay = profile.permissions.includes('finance');
  const canDocuments = profile.permissions.includes('documents.create');
  const td = await getTranslations('documents');
  const t = await getTranslations('bookings');
  const tc = await getTranslations('common');
  const ts = await getTranslations('status');
  const tp = await getTranslations('payments');
  const locale = await getLocale();
  const money = (amount: bigint) => formatMoney(amount, booking.currency, locale);
  const s = booking.sailing;
  const categories = vessels.find((v) => v.id === s.vesselId)?.categories ?? [];
  const editable = ['requested', 'held', 'offered', 'confirmed'].includes(booking.status);
  // Just booked over a warn-mode credit limit: the agency's exposure now.
  const exposure =
    credit === 'over'
      ? await caller.receivables.creditExposure({ channelId: booking.channel.id })
      : null;

  return (
    <>
      <PageHeader
        title={<span dir="ltr">{booking.ref}</span>}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(booking.status)}>{ts(booking.status)}</Badge>
            <Badge tone={statusTone(booking.paymentStatus)}>{ts(booking.paymentStatus)}</Badge>
            <span>{booking.channel.name}</span>
            {booking.channelRef && <span dir="ltr">· {booking.channelRef}</span>}
          </span>
        }
        actions={
          canWrite && (
            <>
              {booking.status === 'confirmed' && (
                <AmendPanel
                  bookingId={booking.id}
                  revision={booking.revision}
                  channelId={booking.channel.id}
                  vesselId={s.vesselId}
                  categories={categories}
                  cabins={booking.cabins.map((c) => ({
                    categoryId: categories.find((x) => x.code === c.categoryCode)?.id ?? '',
                    adults: c.adults,
                    childAges: c.childAges,
                  }))}
                  embarkDate={s.embarkDate}
                />
              )}
              {(booking.status === 'confirmed' || booking.status === 'held') && (
                <CancelPanel bookingId={booking.id} bookingRef={booking.ref} />
              )}
            </>
          )
        }
      />

      {exposure && exposure.limit !== null && exposure.currency && (
        <div className="mb-4">
          <Alert tone="warn">
            {t('creditOver', {
              exposure: formatMoney(exposure.exposure, exposure.currency, locale),
              limit: formatMoney(exposure.limit, exposure.currency, locale),
            })}
          </Alert>
        </div>
      )}
      {booking.holdExpiresAt && booking.status === 'held' && (
        <div className="mb-4">
          <Alert tone="warn">
            {t('holdExpires', { when: formatDateTime(booking.holdExpiresAt, locale) })}
          </Alert>
        </div>
      )}
      {booking.requestExpiresAt && booking.status === 'requested' && (
        <div className="mb-4">
          <Alert tone="warn">
            {t('requestExpires', { when: formatDateTime(booking.requestExpiresAt, locale) })}
          </Alert>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('sailing')}>
          <p className="font-medium">
            {formatDate(s.embarkDate, locale, 'long')} –{' '}
            {formatDate(s.disembarkDate, locale, 'long')}
          </p>
          <p className="text-sm text-muted">
            {s.patternCode} · {s.embarkPort.code} – {s.disembarkPort.code} ·{' '}
            {tc('nights', { n: s.nights })}
          </p>
          <ul className="mt-3 divide-y divide-line text-sm">
            {booking.cabins.map((c) => {
              const category = categories.find((x) => x.code === c.categoryCode);
              return (
                <li key={c.index} className="flex justify-between gap-2 py-2">
                  <span>
                    {t('cabin')} {c.index + 1} · {c.categoryCode}{' '}
                    {category && (
                      <span className="text-muted">
                        {locale.startsWith('ar') ? category.name_ar : category.name_en}
                      </span>
                    )}
                  </span>
                  <span className="text-muted">
                    {tc('adults')} {c.adults}
                    {c.childAges.length > 0 && ` · ${tc('children')} ${c.childAges.join('، ')}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title={tc('total')}>
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-muted">{tc('total')}</dt>
            <dd className="text-end font-semibold tabular-nums">{money(booking.total)}</dd>
            {booking.fees > 0n && (
              <>
                <dt className="text-muted">{t('fee')}</dt>
                <dd className="text-end tabular-nums">{money(booking.fees)}</dd>
              </>
            )}
            <dt className="text-muted">{t('paid')}</dt>
            <dd className="text-end tabular-nums">{money(booking.amountPaid)}</dd>
            {booking.penalty !== null && booking.penalty > 0n && (
              <>
                <dt className="text-muted">{t('penalty')}</dt>
                <dd className="text-end tabular-nums">{money(booking.penalty)}</dd>
              </>
            )}
          </dl>
          {booking.paymentsDue.length > 0 && (
            <>
              <h3 className="mt-4 mb-1 text-sm font-medium">{t('paymentsDue')}</h3>
              <ul className="text-sm">
                {booking.paymentsDue.map((p) => (
                  <li key={p.kind} className="flex justify-between gap-2 py-1">
                    <span>
                      {p.kind === 'deposit' ? t('deposit') : t('balanceDue')}{' '}
                      <span className="text-muted">
                        {t('dueOn', { date: formatDate(p.dueDate, locale) })}
                      </span>
                    </span>
                    <span className="tabular-nums">{money(p.amount)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card title={t('guests')} className="lg:col-span-2">
          <GuestsEditor
            bookingId={booking.id}
            canEdit={canWrite && editable}
            canPrivacy={profile.permissions.includes('guests.privacy')}
            cabins={booking.cabins.map((c) => c.index)}
            guests={booking.guests}
          />
        </Card>

        <Card
          title={t('payments')}
          actions={
            canPay &&
            booking.status !== 'requested' &&
            booking.status !== 'offered' && (
              <PaymentActions bookingRef={booking.ref} canRefund={booking.amountPaid > 0n} />
            )
          }
        >
          {booking.payments.length === 0 ? (
            <p className="text-sm text-muted">{tc('none')}</p>
          ) : (
            <Table head={[t('received'), t('kind'), t('method'), t('amount'), t('reference')]}>
              {booking.payments.map((p) => (
                <tr key={p.id} className={p.reversed ? 'text-muted line-through' : undefined}>
                  <Td>{formatDate(p.receivedOn, locale)}</Td>
                  <Td>{tp(`kind_${p.kind}` as 'kind_payment')}</Td>
                  <Td>{tp(`method_${p.method}` as 'method_cash')}</Td>
                  <Td className="tabular-nums">{formatMoney(p.amount, p.currency, locale)}</Td>
                  <Td>
                    <span dir="ltr">{p.reference}</span>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {profile.permissions.includes('read') && (
          <div className="lg:col-span-2">
            <InvoicesCard
              bookingId={booking.id}
              status={booking.status}
              canDraft={canWrite}
              canFinance={canPay}
            />
          </div>
        )}
        {canDocuments && ['confirmed', 'held', 'completed'].includes(booking.status) && (
          <Card title={td('title')} className="lg:col-span-2">
            <DocumentButtons
              items={[
                {
                  key: 'voucher',
                  label: td('voucher'),
                  input: { kind: 'voucher', bookingId: booking.id },
                },
                {
                  key: 'voucher-agent',
                  label: td('voucherAgent'),
                  input: { kind: 'voucher', bookingId: booking.id, variant: 'agent' },
                },
                {
                  key: 'itinerary',
                  label: td('itinerary'),
                  input: { kind: 'itinerary', bookingId: booking.id },
                },
                {
                  key: 'payment_schedule',
                  label: td('payment_schedule'),
                  input: { kind: 'payment_schedule', bookingId: booking.id },
                },
                {
                  key: 'cancellation_terms',
                  label: td('cancellation_terms'),
                  input: { kind: 'cancellation_terms', bookingId: booking.id },
                },
              ]}
            />
          </Card>
        )}

        <Card title={t('revisions')}>
          <Table head={[t('revHeader'), t('reasonLabel'), tc('total'), t('by'), t('when')]}>
            {booking.revisions.map((r) => (
              <tr key={r.rev}>
                <Td>{r.rev}</Td>
                <Td>{r.reason}</Td>
                <Td className="tabular-nums">
                  {money(r.total)}
                  {r.fee > 0n && <span className="block text-xs text-muted">+ {money(r.fee)}</span>}
                </Td>
                <Td>{r.actor}</Td>
                <Td>{formatDateTime(r.createdAt, locale)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
