import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { LocaleSwitch } from '../../components/locale-switch';
import { signOut } from '../actions';
import { requirePlatformAdmin } from './guard';

export const dynamic = 'force-dynamic';

/** The platform owner's area: separate from every company's screens. */
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const session = await requirePlatformAdmin();
  const t = await getTranslations('platform');
  const a = await getTranslations('app');
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface/95 px-4 py-2 backdrop-blur">
        <div className="text-sm">
          <span className="font-semibold">{t('area')}</span>
          <span className="ms-2 text-muted" dir="ltr">
            {session.email}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {session.staff && (
            <Link href="/" className="rounded-lg px-3 py-2 text-sm text-brand hover:bg-line/40">
              {t('toCompany')}
            </Link>
          )}
          <LocaleSwitch />
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-line/40"
            >
              {a('signOut')}
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-5">{children}</main>
    </div>
  );
}
