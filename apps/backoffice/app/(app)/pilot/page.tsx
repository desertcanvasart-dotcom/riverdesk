import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { formatNumber } from '../../../lib/format';
import { Alert, Badge, Card, PageHeader, Table, Td } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';

/** Owner only: invariant status, oversells (must be 0), request response times, channels. */
export default async function PilotPage() {
  const caller = await serverCaller();
  const profile = await caller.me.profile();
  if (!profile.permissions.includes('pilot.view')) notFound();
  const d = await caller.pilot.dashboard();
  const t = await getTranslations('pilot');
  const locale = await getLocale();
  const num = (n: number) => formatNumber(n, locale);
  const minutes = (n: number | null) => (n === null ? '—' : t('minutes', { n }));
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('invariants')}>
          {d.invariants.length === 0 ? (
            <Alert tone="ok">{t('invariantsOk')}</Alert>
          ) : (
            d.invariants.map((i) => (
              <Alert key={i.invariant} tone="bad">
                {t('invariant', { n: i.invariant, count: i.n })}
              </Alert>
            ))
          )}
        </Card>
        <Card title={t('oversells')}>
          {d.oversells.oversold === 0 ? (
            <Alert tone="ok">{t('oversellsOk')}</Alert>
          ) : (
            <Alert tone="bad">{t('oversold', { n: d.oversells.oversold })}</Alert>
          )}
          {d.oversells.covered > 0 && (
            <p className="mt-2 text-sm text-muted">{t('covered', { n: d.oversells.covered })}</p>
          )}
        </Card>
        <Card title={t('requests')}>
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-muted">{t('received')}</dt>
            <dd className="text-end tabular-nums">{num(d.requests.received)}</dd>
            <dt className="text-muted">{t('answered')}</dt>
            <dd className="text-end tabular-nums">{num(d.requests.answered)}</dd>
            <dt className="text-muted">{t('pending')}</dt>
            <dd className="text-end tabular-nums">{num(d.requests.pending)}</dd>
            <dt className="text-muted">{t('expiredReq')}</dt>
            <dd className="text-end tabular-nums">{num(d.requests.expired)}</dd>
            <dt className="text-muted">{t('median')}</dt>
            <dd className="text-end">{minutes(d.requests.p50_minutes)}</dd>
            <dt className="text-muted">{t('p90')}</dt>
            <dd className="text-end">{minutes(d.requests.p90_minutes)}</dd>
          </dl>
        </Card>
        <Card title={t('exceptions')}>
          {d.openExceptions.length === 0 ? (
            <p className="text-sm text-muted">{t('none')}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {d.openExceptions.map((e) => (
                <Badge key={e.kind} tone="warn">
                  {e.kind.replace(/_/g, ' ')} · {num(e.n)}
                </Badge>
              ))}
            </div>
          )}
        </Card>
        <Card title={t('channels')} className="lg:col-span-2">
          <Table head={['', t('bookings'), t('confirmed'), t('cancelled'), t('openRequests')]}>
            {d.channels.map((c) => (
              <tr key={c.channel}>
                <Td>{c.channel}</Td>
                <Td className="tabular-nums">{num(c.bookings)}</Td>
                <Td className="tabular-nums">{num(c.confirmed)}</Td>
                <Td className="tabular-nums">{num(c.cancelled)}</Td>
                <Td className="tabular-nums">{num(c.requests)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
