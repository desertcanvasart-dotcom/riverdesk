import { getTranslations, setRequestLocale } from 'next-intl/server';
import { PageHero } from '../../../components/page-hero';
import { pageMetadata } from '../../../lib/metadata';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'charter' });
  return pageMetadata({ locale, path: '/charter', title: t('title'), description: t('intro') });
}

export default async function Charter({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('charter');
  const num = (n: number) => n.toLocaleString(locale === 'ar' ? 'ar-EG' : 'en');
  return (
    <>
      <PageHero kicker={t('kicker')} title={t('title')} intro={t('intro')} />
      <div className="container-site py-16 sm:py-20">
        <ol className="mx-auto flex max-w-3xl flex-col gap-4">
          {(t.raw('points') as string[]).map((point, i) => (
            <li
              key={point}
              className="flex gap-5 rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-card)]"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand font-bold text-brand-ink">
                {num(i + 1)}
              </span>
              <p className="self-center text-lg leading-relaxed">{point}</p>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}
