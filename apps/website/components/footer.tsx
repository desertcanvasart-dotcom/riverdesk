import { useLocale, useTranslations } from 'next-intl';
import { Link } from '../i18n/routing';
import { site } from '../lib/site';
import { Logo } from './logo';

export function Footer() {
  const t = useTranslations('footer');
  const locale = useLocale();
  // The year in the page's digits: ٢٠٢٦ in Arabic.
  const year = new Date()
    .getFullYear()
    .toLocaleString(locale === 'ar' ? 'ar-EG' : 'en', { useGrouping: false });
  const n = useTranslations('nav');
  const col = 'flex flex-col gap-2.5 text-sm';
  const link = 'text-white/65 transition-colors hover:text-white';
  return (
    <footer className="band-deep mt-24">
      <div className="container-site grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">
        <div>
          <Logo light />
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/65">{t('tagline')}</p>
        </div>
        <div className={col}>
          <span className="mb-1 text-xs font-semibold tracking-wider text-white/45 uppercase">
            {t('product')}
          </span>
          <Link href="/features" className={link}>
            {n('features')}
          </Link>
          <Link href="/channels" className={link}>
            {n('channels')}
          </Link>
          <Link href="/security" className={link}>
            {n('security')}
          </Link>
        </div>
        <div className={col}>
          <span className="mb-1 text-xs font-semibold tracking-wider text-white/45 uppercase">
            {n('docs')}
          </span>
          <Link href="/docs/getting-started/overview" className={link}>
            {t('gettingStarted')}
          </Link>
          <Link href="/docs/guides/set-up-your-company" className={link}>
            {t('guides')}
          </Link>
          <Link href="/docs/staff-guide/today" className={link}>
            {t('staffGuide')}
          </Link>
          <Link href="/docs/channel-api/overview" className={link}>
            {t('apiGuide')}
          </Link>
          <Link href="/docs/concepts/glossary" className={link}>
            {t('glossary')}
          </Link>
        </div>
        <div className={col}>
          <span className="mb-1 text-xs font-semibold tracking-wider text-white/45 uppercase">
            {t('app')}
          </span>
          <a href={site.appUrl} className={link}>
            {t('signIn')}
          </a>
          <a href={site.apiDocsUrl} className={link}>
            {t('apiReference')}
          </a>
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="container-site flex flex-wrap justify-between gap-2 py-5 text-xs text-white/50">
          <span>{t('copyright', { year })}</span>
          <span>{t('madeFor')}</span>
        </div>
      </div>
    </footer>
  );
}
