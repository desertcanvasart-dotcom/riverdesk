'use client';

import { ArrowUpRight, Languages, Menu, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
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
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => setOpen(false), [path]);
  const other = locale === 'ar' ? 'en' : 'ar';
  const active = (href: string) => path === href || path.startsWith(`${href}/`);
  return (
    <header
      className={`sticky top-0 z-40 border-b backdrop-blur-md transition-colors ${
        scrolled || open ? 'border-line bg-surface/85' : 'border-transparent bg-bg/70'
      }`}
    >
      <div className="container-site flex h-16 items-center justify-between gap-4">
        <Link href="/" aria-label="Riverdesk" className="shrink-0">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-0.5 md:flex">
          {NAV.map(([key, href]) => (
            <Link
              key={key}
              href={href}
              aria-current={active(href) ? 'page' : undefined}
              className={`relative rounded-full px-3.5 py-2 text-sm font-medium transition-colors ${
                active(href) ? 'bg-brand-soft text-brand' : 'text-muted hover:text-ink'
              }`}
            >
              {t(key)}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-1.5">
          <Link
            href={path}
            locale={other}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-muted hover:text-ink"
          >
            <Languages aria-hidden className="size-4" />
            {other === 'ar' ? 'العربية' : 'English'}
          </Link>
          <a
            href={site.appUrl}
            className="hidden items-center gap-1 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-bg shadow-sm hover:opacity-90 sm:inline-flex"
          >
            {t('signIn')}
            <ArrowUpRight aria-hidden className="size-4 rtl:-scale-x-100" />
          </a>
          <button
            type="button"
            className="rounded-full p-2 md:hidden"
            aria-expanded={open}
            aria-label={t('menu')}
            onClick={() => setOpen(!open)}
          >
            {open ? <X aria-hidden className="size-5" /> : <Menu aria-hidden className="size-5" />}
          </button>
        </div>
      </div>
      {open && (
        <nav className="border-t border-line md:hidden">
          <div className="container-site flex flex-col py-2">
            {NAV.map(([key, href]) => (
              <Link
                key={key}
                href={href}
                className={`rounded-lg px-2 py-3 text-base ${active(href) ? 'font-semibold text-brand' : ''}`}
              >
                {t(key)}
              </Link>
            ))}
            <a
              href={site.appUrl}
              className="rounded-lg px-2 py-3 text-base font-semibold text-brand"
            >
              {t('signIn')}
            </a>
          </div>
        </nav>
      )}
    </header>
  );
}
