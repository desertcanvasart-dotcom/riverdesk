import { useTranslations } from 'next-intl';
import { Link } from '../i18n/routing';
import { site } from '../lib/site';
import { Logo } from './logo';

export function Footer() {
  const t = useTranslations('footer');
  const n = useTranslations('nav');
  return (
    <footer className="mt-20 border-t border-line bg-surface">
      <div className="container-site grid gap-8 py-10 sm:grid-cols-[2fr_1fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-3 max-w-sm text-sm text-muted">{t('tagline')}</p>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <span className="font-semibold">{t('product')}</span>
          <Link href="/features" className="text-muted hover:text-ink">
            {n('features')}
          </Link>
          <Link href="/channels" className="text-muted hover:text-ink">
            {n('channels')}
          </Link>
          <Link href="/security" className="text-muted hover:text-ink">
            {n('security')}
          </Link>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <span className="font-semibold">{n('docs')}</span>
          <Link href="/docs/getting-started/overview" className="text-muted hover:text-ink">
            {t('gettingStarted')}
          </Link>
          <Link href="/docs/staff-guide/today" className="text-muted hover:text-ink">
            {t('staffGuide')}
          </Link>
          <Link href="/docs/channel-api/overview" className="text-muted hover:text-ink">
            {t('apiGuide')}
          </Link>
          <Link href="/docs/concepts/glossary" className="text-muted hover:text-ink">
            {t('glossary')}
          </Link>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <span className="font-semibold">{t('app')}</span>
          <a href={site.appUrl} className="text-muted hover:text-ink">
            {n('signIn')}
          </a>
          <a href={site.apiDocsUrl} className="text-muted hover:text-ink">
            {t('apiReference')}
          </a>
        </div>
      </div>
      <div className="container-site border-t border-line py-4 text-xs text-muted">
        © {new Date().getFullYear()} Riverdesk · {t('rights')}
      </div>
    </footer>
  );
}
