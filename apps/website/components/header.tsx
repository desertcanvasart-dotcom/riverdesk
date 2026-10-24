'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link, usePathname } from '../i18n/routing';
import { site } from '../lib/site';
import { Logo } from './logo';

const NAV = [
  ['features', '/features'],
  ['channels', '/channels'],
  ['security', '/security'],
  ['docs', '/docs'],
] as const;

export function Header() {
  const t = useTranslations('nav');
  const locale = useLocale();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const other = locale === 'ar' ? 'en' : 'ar';
  const active = (href: string) => path === href || path.startsWith(`${href}/`);
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur">
      <div className="container-site flex h-16 items-center justify-between gap-4">
        <Link href="/" aria-label="Riverdesk">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map(([key, href]) => (
            <Link
              key={key}
              href={href}
              className={`rounded-lg px-3 py-2 text-sm ${active(href) ? 'text-brand' : 'text-ink hover:bg-line/50'}`}
            >
              {t(key)}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          <Link
            href={path}
            locale={other}
            className="rounded-lg px-3 py-2 text-sm text-brand hover:bg-line/50"
          >
            {other === 'ar' ? 'العربية' : 'English'}
          </Link>
          <a
            href={site.appUrl}
            className="hidden rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink hover:opacity-90 sm:inline-flex"
          >
            {t('signIn')}
          </a>
          <button
            type="button"
            className="rounded-lg px-3 py-2 text-sm md:hidden"
            aria-expanded={open}
            aria-label={t('menu')}
            onClick={() => setOpen(!open)}
          >
            ☰
          </button>
        </div>
      </div>
      {open && (
        <nav className="border-t border-line bg-surface md:hidden">
          <div className="container-site flex flex-col py-2">
            {NAV.map(([key, href]) => (
              <Link
                key={key}
                href={href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-2 py-3 text-base"
              >
                {t(key)}
              </Link>
            ))}
            <a href={site.appUrl} className="rounded-lg px-2 py-3 text-base font-medium text-brand">
              {t('signIn')}
            </a>
          </div>
        </nav>
      )}
    </header>
  );
}
