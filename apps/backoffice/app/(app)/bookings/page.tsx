import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  Badge,
  Button,
  Card,
  Empty,
  Input,
  PageHeader,
  Select,
  Table,
  Td,
} from '../../../components/ui';
import { formatDate, formatMoney } from '../../../lib/format';
import { serverCaller } from '../../../server/caller';
import { statusTone } from '../../../lib/status';

const STATUSES = [
  'confirmed',
  'held',
  'requested',
  'offered',
  'cancelled',
  'completed',
  'declined',
  'expired',
  'paid_unavailable',
];

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const filters = {
    q: params.q || undefined,
    status: STATUSES.includes(params.status ?? '') ? params.status : undefined,
    from: /^\d{4}-\d{2}-\d{2}$/.test(params.from ?? '') ? params.from : undefined,
    to: /^\d{4}-\d{2}-\d{2}$/.test(params.to ?? '') ? params.to : undefined,
  };
  const rows = await (await serverCaller()).bookings.search(filters);
  const t = await getTranslations('bookings');
  const tc = await getTranslations('common');
  const ts = await getTranslations('status');
  const locale = await getLocale();
  return (
    <>
      <PageHeader title={t('title')} />
      <Card>
        <form className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Input
            name="q"
            defaultValue={filters.q}
            placeholder={t('search')}
            aria-label={t('search')}
          />
          <Select name="status" defaultValue={filters.status ?? ''} aria-label={tc('status')}>
            <option value="">{t('anyStatus')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {ts(s)}
              </option>
            ))}
          </Select>
          <Input name="from" type="date" defaultValue={filters.from} aria-label={tc('from')} />
          <Input name="to" type="date" defaultValue={filters.to} aria-label={tc('to')} />
          <Button type="submit">{tc('search')}</Button>
        </form>
        {rows.length === 0 ? (
          <Empty>{t('noResults')}</Empty>
        ) : (
          <>
            <ul className="divide-y divide-line sm:hidden">
              {rows.map((b) => (
                <li key={b.id}>
                  <Link href={`/bookings/${b.ref}`} className="flex flex-col gap-1 py-3">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium text-brand" dir="ltr">
                        {b.ref}
                      </span>
                      <span className="text-sm tabular-nums">
                        {formatMoney(b.total, b.currency, locale)}
                      </span>
                    </span>
                    <span className="text-sm">
                      {b.leadGuest ?? '—'} <span className="text-muted">· {b.channel}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1 text-xs text-muted">
                      {formatDate(b.embarkDate, locale)} · {b.patternCode} ·{' '}
                      {tc('cabins', { n: b.cabins })}
                      <Badge tone={statusTone(b.status)}>{ts(b.status)}</Badge>
                      <Badge tone={statusTone(b.paymentStatus)}>{ts(b.paymentStatus)}</Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="hidden sm:block">
              <Table
                head={[t('ref'), t('guest'), t('channel'), t('embark'), tc('status'), tc('total')]}
              >
                {rows.map((b) => (
                  <tr key={b.id}>
                    <Td>
                      <Link
                        href={`/bookings/${b.ref}`}
                        className="font-medium text-brand"
                        dir="ltr"
                      >
                        {b.ref}
                      </Link>
                    </Td>
                    <Td>{b.leadGuest ?? '—'}</Td>
                    <Td>
                      {b.channel}
                      {b.channelRef && (
                        <span className="block text-xs text-muted" dir="ltr">
                          {b.channelRef}
                        </span>
                      )}
                    </Td>
                    <Td>
                      {formatDate(b.embarkDate, locale)}
                      <span className="block text-xs text-muted">
                        {b.patternCode} · {tc('cabins', { n: b.cabins })}
                      </span>
                    </Td>
                    <Td>
                      <div className="flex flex-col items-start gap-1">
                        <Badge tone={statusTone(b.status)}>{ts(b.status)}</Badge>
                        <Badge tone={statusTone(b.paymentStatus)}>{ts(b.paymentStatus)}</Badge>
                      </div>
                    </Td>
                    <Td className="tabular-nums">{formatMoney(b.total, b.currency, locale)}</Td>
                  </tr>
                ))}
              </Table>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
