import { getTranslations } from 'next-intl/server';
import { Link } from '../i18n/routing';
import { site } from '../lib/site';

const primary =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-brand px-5 text-sm font-semibold text-brand-ink hover:opacity-90';
const secondary =
  'inline-flex min-h-11 items-center justify-center rounded-xl border border-line bg-surface px-5 text-sm font-semibold hover:border-brand';

/** "Request a demo" opens an email when a contact address is configured; otherwise the docs. */
export async function DemoButtons({ second = 'features' }: { second?: 'features' | 'docs' }) {
  const t = await getTranslations('cta');
  return (
    <div className="flex flex-wrap gap-3">
      {site.contactEmail ? (
        <a
          href={`mailto:${site.contactEmail}?subject=${encodeURIComponent(t('demoSubject'))}`}
          className={primary}
        >
          {t('demo')}
        </a>
      ) : (
        <a href={site.appUrl} className={primary}>
          {t('signIn')}
        </a>
      )}
      <Link href={second === 'features' ? '/features' : '/docs'} className={secondary}>
        {second === 'features' ? t('features') : t('docs')}
      </Link>
    </div>
  );
}

export { primary as primaryButton, secondary as secondaryButton };
