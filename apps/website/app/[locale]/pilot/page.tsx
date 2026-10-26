import { getTranslations, setRequestLocale } from 'next-intl/server';
import { FoundingPoints } from '../../../components/founding';
import { PageHero } from '../../../components/page-hero';
import { PilotForm } from '../../../components/pilot-form';
import { pageMetadata } from '../../../lib/metadata';
import { whatsappLink } from '../../../lib/site';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'founding' });
  return pageMetadata({ locale, path: '/pilot', title: t('title'), description: t('text') });
}

export default async function Pilot({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('pilot');
  const f = await getTranslations('founding');
  const c = await getTranslations('cta');
  return (
    <>
      <PageHero kicker={t('kicker')} title={t('title')} intro={f('text')} />
      <div className="container-site grid items-start gap-10 py-12 sm:py-16 lg:grid-cols-[1fr_1.6fr]">
        <section aria-labelledby="founding-title" className="lg:sticky lg:top-24">
          <h2 id="founding-title" className="text-2xl font-bold tracking-tight">
            {f('title')}
          </h2>
          <div className="mt-6">
            <FoundingPoints />
          </div>
        </section>
        <PilotForm whatsappHref={whatsappLink(c('whatsappMessage'))} />
      </div>
    </>
  );
}
