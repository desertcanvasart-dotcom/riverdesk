import { ArrowRight } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Link } from '../i18n/routing';
import { site } from '../lib/site';

const primary =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-brand px-6 text-sm font-semibold text-brand-ink shadow-sm transition hover:opacity-90';
const secondary =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-line bg-surface px-6 text-sm font-semibold transition hover:border-brand';
const primaryDark =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-white px-6 text-sm font-semibold text-deep shadow-sm transition hover:opacity-90';
const secondaryDark =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/25 px-6 text-sm font-semibold text-white transition hover:bg-white/10';

/** "Request a demo" opens an email when a contact address is configured; otherwise sign in. */
export async function DemoButtons({
  second = 'features',
  dark = false,
}: {
  second?: 'features' | 'docs';
  /** On a dark band. */
  dark?: boolean;
}) {
  const t = await getTranslations('cta');
  const arrow = <ArrowRight aria-hidden className="size-4 rtl:-scale-x-100" />;
  return (
    <div className="flex flex-wrap gap-3">
      {site.contactEmail ? (
        <a
          href={`mailto:${site.contactEmail}?subject=${encodeURIComponent(t('demoSubject'))}`}
          className={dark ? primaryDark : primary}
        >
          {t('demo')}
          {arrow}
        </a>
      ) : (
        <a href={site.appUrl} className={dark ? primaryDark : primary}>
          {t('signIn')}
          {arrow}
        </a>
      )}
      <Link
        href={second === 'features' ? '/features' : '/docs'}
        className={dark ? secondaryDark : secondary}
      >
        {second === 'features' ? t('features') : t('docs')}
      </Link>
    </div>
  );
}

export { primary as primaryButton, secondary as secondaryButton };

/** A small label above a section title. */
export function Kicker({
  children,
  light = false,
}: {
  children: React.ReactNode;
  light?: boolean;
}) {
  return (
    <p
      className={`text-xs font-semibold tracking-[0.14em] uppercase ${light ? 'text-[#7fe0d6]' : 'text-sand'}`}
    >
      {children}
    </p>
  );
}
