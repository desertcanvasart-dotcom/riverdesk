'use client';

import { useQuery } from '@tanstack/react-query';
import {
  BookOpen,
  CalendarDays,
  CalendarPlus,
  ChevronDown,
  ClipboardList,
  Gauge,
  House,
  Inbox,
  LayoutGrid,
  LogOut,
  Menu,
  Settings,
  Share2,
  Ship,
  ShieldCheck,
  Tags,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';
import { signOut } from '../app/actions';
import { useTRPC } from '../lib/trpc';
import { LocaleSwitch } from './locale-switch';
import { cx } from './ui';

type Key =
  | 'home'
  | 'book'
  | 'bookings'
  | 'requests'
  | 'payments'
  | 'inventory'
  | 'guests'
  | 'vacancy'
  | 'fleet'
  | 'schedule'
  | 'rates'
  | 'channels'
  | 'settings'
  | 'pilot';

interface Item {
  key: Key;
  href: string;
  icon: LucideIcon;
}

/**
 * The menu, grouped by what people do: take reservations, run departures, set the company up.
 * Today stands alone at the top. Sections fold; opening a page unfolds its section.
 */
const SECTIONS: { key: string | null; items: Item[] }[] = [
  { key: null, items: [{ key: 'home', href: '/', icon: House }] },
  {
    key: 'reservations',
    items: [
      { key: 'book', href: '/book', icon: CalendarPlus },
      { key: 'bookings', href: '/bookings', icon: BookOpen },
      { key: 'requests', href: '/requests', icon: Inbox },
      { key: 'payments', href: '/payments', icon: Wallet },
    ],
  },
  {
    key: 'operations',
    items: [
      { key: 'inventory', href: '/inventory', icon: LayoutGrid },
      { key: 'guests', href: '/guests', icon: Users },
      { key: 'vacancy', href: '/vacancy', icon: ClipboardList },
    ],
  },
  {
    key: 'setup',
    items: [
      { key: 'fleet', href: '/fleet', icon: Ship },
      { key: 'schedule', href: '/schedule', icon: CalendarDays },
      { key: 'rates', href: '/rates', icon: Tags },
      { key: 'channels', href: '/channels', icon: Share2 },
    ],
  },
  {
    key: 'company',
    items: [
      { key: 'settings', href: '/settings', icon: Settings },
      { key: 'pilot', href: '/pilot', icon: Gauge },
    ],
  },
];

const FOLDED = 'vs.nav.folded';

function readFolded(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FOLDED) ?? '[]') as string[];
  } catch {
    return [];
  }
}

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
  const rtl = useLocale().startsWith('ar');
  const path = usePathname();
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [folded, setFolded] = useState<string[]>([]);
  useEffect(() => setFolded(readFolded()), []);
  useEffect(() => setOpen(false), [path]);
  // Waiting requests are the one count worth seeing from every page.
  const actions = useQuery({ ...trpc.home.actionList.queryOptions(), staleTime: 60_000 });
  const counts: Partial<Record<Key, number>> = { requests: actions.data?.requests.length ?? 0 };

  const isActive = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  const sections = SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter((i) => i.key !== 'pilot' || showPilot),
  }));
  const current = sections
    .flatMap((s) => s.items.map((i) => ({ ...i, section: s.key })))
    .find((i) => isActive(i.href));
  const save = (next: string[]) => {
    setFolded(next);
    try {
      localStorage.setItem(FOLDED, JSON.stringify(next));
    } catch {
      // Private windows: folding still works for this page.
    }
  };
  const toggle = (key: string) =>
    save(folded.includes(key) ? folded.filter((k) => k !== key) : [...folded, key]);
  // Opening a page unfolds its section once; after that it folds like any other.
  const currentSection = current?.section;
  useEffect(() => {
    if (!currentSection) return;
    setFolded((f) => {
      if (!f.includes(currentSection)) return f;
      const next = f.filter((k) => k !== currentSection);
      try {
        localStorage.setItem(FOLDED, JSON.stringify(next));
      } catch {
        // As above.
      }
      return next;
    });
  }, [path, currentSection]);

  const nav = (
    <nav className="flex flex-col gap-4 px-3 py-2" aria-label={t('app.menu')}>
      {sections.map((section) => {
        const shut = section.key !== null && folded.includes(section.key);
        return (
          <div key={section.key ?? 'top'}>
            {section.key && (
              <button
                type="button"
                onClick={() => toggle(section.key!)}
                aria-expanded={!shut}
                className="mb-1 flex w-full items-center justify-between rounded-md px-2 py-1 text-[11px] font-semibold tracking-wider text-muted uppercase hover:text-ink"
              >
                {t(`nav.sections.${section.key}`)}
                <ChevronDown
                  aria-hidden
                  className={cx(
                    'size-3.5 transition-transform',
                    // Folded: points the way the text reads.
                    shut && (rtl ? 'rotate-90' : '-rotate-90'),
                  )}
                />
              </button>
            )}
            {!shut && (
              <ul className="flex flex-col gap-0.5">
                {section.items.map(({ key, href, icon: Icon }) => {
                  const on = isActive(href);
                  const count = counts[key] ?? 0;
                  return (
                    <li key={key}>
                      <Link
                        href={href}
                        aria-current={on ? 'page' : undefined}
                        className={cx(
                          'flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm',
                          on ? 'bg-brand text-brand-ink' : 'text-ink hover:bg-line/40',
                        )}
                      >
                        <Icon aria-hidden className={cx('size-4 shrink-0', !on && 'text-muted')} />
                        <span className="min-w-0 flex-1 truncate">{t(`nav.${key}`)}</span>
                        {count > 0 && (
                          <span
                            className={cx(
                              'rounded-full px-1.5 text-xs font-semibold tabular-nums',
                              on ? 'bg-brand-ink/20' : 'bg-warn-bg text-warn',
                            )}
                          >
                            {count}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
      {showPlatform && (
        <Link
          href="/platform"
          className="flex items-center gap-3 rounded-lg border border-dashed border-line px-2.5 py-2 text-sm text-brand hover:bg-line/40"
        >
          <ShieldCheck aria-hidden className="size-4" />
          {t('nav.platform')}
        </Link>
      )}
    </nav>
  );

  const brand = (
    <div className="flex items-center gap-3 px-5 pt-5 pb-3">
      {/* The Riverdesk mark, as on the website. */}
      <svg width="36" height="36" viewBox="0 0 32 32" aria-hidden className="shrink-0">
        <rect width="32" height="32" rx="8" fill="var(--color-brand)" />
        <path
          d="M7 11h18"
          stroke="var(--color-brand-ink)"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path
          d="M6 20c3-3 6-3 9 0s7 3 11-1"
          stroke="var(--color-brand-ink)"
          strokeWidth="2.4"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{operator}</span>
        <span className="block text-xs text-muted" dir="ltr">
          Riverdesk
        </span>
      </span>
    </div>
  );

  const account = (
    <div className="mt-auto flex items-center gap-3 border-t border-line px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-line/60 text-xs font-semibold">
        {initials(user)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{user}</span>
        <span className="block truncate text-xs text-muted">{role}</span>
      </span>
      <form action={signOut}>
        <button
          type="submit"
          title={t('app.signOut')}
          aria-label={t('app.signOut')}
          className="rounded-lg p-2 text-muted hover:bg-line/40 hover:text-ink"
        >
          <LogOut aria-hidden className="size-4 rtl:-scale-x-100" />
        </button>
      </form>
    </div>
  );

  return (
    <div className="min-h-dvh md:flex">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col overflow-y-auto border-e border-line bg-surface md:flex">
        {brand}
        {nav}
        {account}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <aside
            className="absolute inset-y-0 start-0 flex w-72 flex-col overflow-y-auto bg-surface shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              {brand}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('app.close')}
                className="m-3 rounded-lg p-2 text-muted hover:bg-line/40"
              >
                <X aria-hidden className="size-5" />
              </button>
            </div>
            {nav}
            {account}
          </aside>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-line bg-surface/95 px-4 py-2 backdrop-blur">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="rounded-lg p-2 md:hidden"
              aria-label={t('app.menu')}
            >
              <Menu aria-hidden className="size-5" />
            </button>
            {current && (
              <p className="truncate text-sm">
                {current.section && (
                  <span className="text-muted">{t(`nav.sections.${current.section}`)} › </span>
                )}
                <span className="font-medium">{t(`nav.${current.key}`)}</span>
              </p>
            )}
          </div>
          <LocaleSwitch />
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 py-5">{children}</main>
      </div>
    </div>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}
