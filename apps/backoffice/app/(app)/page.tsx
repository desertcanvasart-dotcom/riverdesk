import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { SetupChecklist } from '../../components/setup-checklist';
import { Badge, Card, PageHeader } from '../../components/ui';
import { formatDate, formatDateTime, formatMoney, hoursLeft } from '../../lib/format';
import { serverCaller } from '../../server/caller';

export default async function HomePage() {
  const caller = await serverCaller();
  // An on-board login has one screen.
  if ((await caller.me.profile()).role === 'onboard') redirect('/checkin');
  const [list, profile] = await Promise.all([caller.home.actionList(), caller.me.profile()]);
  // Owners see what is left to set up until the company can sell.
  const setup = profile.permissions.includes('fleet.write') ? await caller.home.setup() : null;
  const t = await getTranslations('home');
  const locale = await getLocale();
  const sections = [
    {
      key: 'exceptions',
      items: list.exceptions.map((e) => ({
        id: e.id,
        href:
          e.kind === 'paid_unavailable' ||
          e.kind === 'guest_age_mismatch' ||
          e.kind === 'late_payment'
            ? '/bookings'
            : '/inventory',
        text: e.summary,
        badge: (
          <Badge tone={e.severity === 'critical' ? 'bad' : 'warn'}>
            {e.kind.replace(/_/g, ' ')}
          </Badge>
        ),
      })),
    },
    {
      key: 'paidUnavailable',
      items: list.paidUnavailable.map((b) => ({
        id: b.bookingId,
        href: `/bookings/${b.ref}`,
        text: b.ref,
        badge: <Badge tone="bad">{formatMoney(b.paid, b.currency, locale)}</Badge>,
      })),
    },
    {
      key: 'requests',
      items: list.requests.map((r) => ({
        id: r.bookingId,
        href: `/requests`,
        text: r.ref,
        badge: (
          <Badge tone={r.hoursLeft < 2 ? 'bad' : 'warn'}>
            {t('hoursLeft', { h: hoursLeft(r.expiresAt) })}
          </Badge>
        ),
      })),
    },
    {
      key: 'holds',
      items: list.holdsExpiringToday.map((h) => ({
        id: h.holdId,
        href: h.bookingRef ? `/bookings/${h.bookingRef}` : '/bookings',
        text: `${h.bookingRef ?? h.kind}`,
        badge: <Badge tone="warn">{formatDateTime(h.expiresAt, locale)}</Badge>,
      })),
    },
    {
      key: 'deposits',
      items: list.depositsDue.map((d) => ({
        id: d.bookingId,
        href: `/bookings/${d.ref}`,
        text: d.ref,
        badge: (
          <Badge tone={d.overdue ? 'bad' : 'warn'}>{formatMoney(d.due, d.currency, locale)}</Badge>
        ),
      })),
    },
    {
      key: 'balances',
      items: list.balancesDue.map((d) => ({
        id: d.bookingId,
        href: `/bookings/${d.ref}`,
        text: `${d.ref} · ${formatMoney(d.due, d.currency, locale)}`,
        badge: (
          <Badge tone={d.overdue ? 'bad' : 'warn'}>
            {d.overdue ? t('overdue') : t('due', { date: formatDate(d.dueDate, locale) })}
          </Badge>
        ),
      })),
    },
    {
      key: 'invoicesDue',
      items: list.invoicesDue.map((i) => ({
        id: i.invoiceId,
        href: `/invoices/${i.invoiceId}`,
        text: `${i.number} · ${i.party} · ${formatMoney(i.due, i.currency, locale)}`,
        badge: (
          <Badge tone={i.overdue ? 'bad' : 'warn'}>
            {i.overdue ? t('overdue') : t('due', { date: formatDate(i.dueDate, locale) })}
          </Badge>
        ),
      })),
    },
    {
      key: 'unallocatedReceipts',
      // The receipt pages are finance only.
      items: profile.permissions.includes('finance')
        ? list.unallocatedReceipts.map((r) => ({
            id: r.receiptId,
            href: `/payments/receipts/${r.receiptId}`,
            text: `${r.party} · ${formatDate(r.receivedOn, locale)}`,
            badge: <Badge tone="warn">{formatMoney(r.left, r.currency, locale)}</Badge>,
          }))
        : [],
    },
    {
      key: 'openFolios',
      items: list.openFolios.map((f) => ({
        id: f.bookingId + (f.cabin ?? ''),
        href: '/checkin',
        text: `${f.vessel} · ${f.cabin ?? f.ref} · ${formatMoney(f.total, f.currency, locale)}`,
        badge: <Badge tone="warn">{formatDate(f.disembarkDate, locale)}</Badge>,
      })),
    },
    {
      key: 'uninvoicedSailed',
      items: list.uninvoicedSailed.map((b) => ({
        id: b.bookingId,
        href: `/bookings/${b.ref}`,
        text: b.ref,
        badge: <Badge tone="warn">{formatDate(b.embarkDate, locale)}</Badge>,
      })),
    },
    {
      key: 'missingGuests',
      items: list.missingGuests.map((g) => ({
        id: g.bookingId,
        href: `/bookings/${g.ref}`,
        text: `${g.ref} · ${formatDate(g.embarkDate, locale)}`,
        badge: <Badge tone="warn">{g.missing}</Badge>,
      })),
    },
    {
      key: 'unassigned',
      items: list.unassignedDepartures.map((d) => ({
        id: d.legId,
        href: `/guests?leg=${d.legId}`,
        text: `${formatDate(d.departDate, locale)} · ${d.from} – ${d.to}`,
        badge: <Badge tone="warn">{d.unassigned}</Badge>,
      })),
    },
  ].filter((s) => s.items.length > 0);

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {setup && (
        <div className="mb-4">
          <SetupChecklist setup={setup} />
        </div>
      )}
      {sections.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-muted">{t('allClear')}</p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {sections.map((section) => (
            <Card key={section.key} title={`${t(section.key)} (${section.items.length})`}>
              <ul className="divide-y divide-line">
                {section.items.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      className="flex items-center justify-between gap-3 py-2 text-sm hover:text-brand"
                    >
                      <span className="min-w-0 truncate">{item.text}</span>
                      {item.badge}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
