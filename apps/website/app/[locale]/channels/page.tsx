import { getTranslations, setRequestLocale } from 'next-intl/server';
import { primaryButton, secondaryButton } from '../../../components/cta';
import { Link } from '../../../i18n/routing';
import { site } from '../../../lib/site';

type Item = { title: string; text: string };

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'channels' });
  return { title: t('title'), description: t('intro') };
}

export default async function Channels({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('channels');
  const c = await getTranslations('cta');
  return (
    <div className="container-site py-12">
      <h1 className="text-4xl font-bold">{t('title')}</h1>
      <p className="mt-3 max-w-2xl text-lg text-muted">{t('intro')}</p>

      <h2 className="mt-14 text-2xl font-bold">{t('contractsTitle')}</h2>
      <div className="mt-6 grid gap-5 md:grid-cols-3">
        {(t.raw('contracts') as Item[]).map((x) => (
          <div key={x.title} className="rounded-2xl border border-line bg-surface p-6">
            <p className="text-lg font-semibold">{x.title}</p>
            <p className="mt-2 leading-relaxed text-muted">{x.text}</p>
          </div>
        ))}
      </div>

      <h2 className="mt-14 text-2xl font-bold">{t('paymentTitle')}</h2>
      <ul className="mt-4 flex flex-col gap-2 text-lg">
        {(t.raw('payment') as string[]).map((line) => (
          <li key={line} className="flex gap-2">
            <span className="text-brand">•</span>
            {line}
          </li>
        ))}
      </ul>

      <section className="mt-14 rounded-3xl border border-line bg-surface p-8">
        <h2 className="text-2xl font-bold">{t('apiTitle')}</h2>
        <p className="mt-3 max-w-3xl text-lg leading-relaxed text-muted">{t('apiText')}</p>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(t.raw('apiPoints') as string[]).map((line) => (
            <li key={line} className="flex gap-2">
              <span className="text-ok">✓</span>
              {line}
            </li>
          ))}
        </ul>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/docs/channel-api/overview" className={primaryButton}>
            {c('apiGuide')}
          </Link>
          <a href={site.apiDocsUrl} className={secondaryButton}>
            {c('apiReference')}
          </a>
        </div>
      </section>
    </div>
  );
}
