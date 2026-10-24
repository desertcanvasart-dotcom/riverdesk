'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { signOut } from '../app/actions';
import { LocaleSwitch } from './locale-switch';
import { cx } from './ui';

const NAV = [
  ['home', '/'],
  ['book', '/book'],
  ['bookings', '/bookings'],
  ['requests', '/requests'],
  ['inventory', '/inventory'],
  ['schedule', '/schedule'],
  ['rates', '/rates'],
  ['channels', '/channels'],
  ['payments', '/payments'],
  ['guests', '/guests'],
  ['vacancy', '/vacancy'],
  ['settings', '/settings'],
  ['pilot', '/pilot'],
] as const;

export function Shell({
  operator,
  user,
  role,
  showPilot = false,
  showPlatform = false,
  children,
}: {
  operator: string;
  user: string;
  role: string;
  showPilot?: boolean;
  /** Platform admins also get a link to the platform area. */
  showPlatform?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  const nav = (
    <nav className="flex flex-col gap-0.5 p-2">
      {NAV.filter(([key]) => key !== 'pilot' || showPilot).map(([key, href]) => (
        <Link
          key={key}
          href={href}
          onClick={() => setOpen(false)}
          className={cx(
            'rounded-lg px-3 py-2 text-sm',
            active(href) ? 'bg-brand text-brand-ink' : 'hover:bg-line/40',
          )}
        >
          {t(`nav.${key}`)}
        </Link>
      ))}
      {showPlatform && (
        <Link
          href="/platform"
          onClick={() => setOpen(false)}
          className="mt-2 rounded-lg border-t border-line px-3 py-2 text-sm text-brand hover:bg-line/40"
        >
          {t('nav.platform')}
        </Link>
      )}
    </nav>
  );
  return (
    <div className="min-h-dvh md:flex">
      <aside className="hidden w-56 shrink-0 border-e border-line bg-surface md:block">
        <div className="px-5 pt-5 pb-2 text-sm font-semibold">{operator}</div>
        {nav}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <aside
            className="absolute inset-y-0 start-0 w-64 overflow-y-auto bg-surface shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 pt-5 pb-2 text-sm font-semibold">{operator}</div>
            {nav}
          </aside>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-line bg-surface/95 px-4 py-2 backdrop-blur">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-lg px-2 py-2 text-sm md:hidden"
            aria-label={t('app.menu')}
          >
            ☰ <span className="ms-1">{t('app.menu')}</span>
          </button>
          <div className="hidden text-sm text-muted md:block">
            {user} · {role}
          </div>
          <div className="flex items-center gap-1">
            <LocaleSwitch />
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-line/40"
              >
                {t('app.signOut')}
              </button>
            </form>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 py-5">{children}</main>
      </div>
    </div>
  );
}
