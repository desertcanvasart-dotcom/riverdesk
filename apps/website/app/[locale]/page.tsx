import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DemoButtons, secondaryButton } from '../../components/cta';
import { Screen } from '../../components/screen';
import { Link } from '../../i18n/routing';

type Item = { title: string; text: string };

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('home');
  const c = await getTranslations('cta');
  return (
    <>
      <section className="container-site grid items-center gap-10 py-14 lg:grid-cols-[1fr_1.1fr] lg:py-20">
        <div>
          <p className="text-sm font-semibold text-brand">{t('eyebrow')}</p>
          <h1 className="mt-3 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            {t('title')}
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-muted">{t('subtitle')}</p>
          <div className="mt-8">
            <DemoButtons />
          </div>
        </div>
        <div className="relative">
          <Screen src={`/screens/${locale}/desktop-book.jpg`} alt={t('pillars.1.title')} />
          <Screen
            phone
            src={`/screens/${locale}/phone-today.jpg`}
            alt={t('pillars.5.title')}
            className="absolute -bottom-8 w-32 sm:w-40 ltr:-left-4 rtl:-right-4"
          />
        </div>
      </section>

      <section className="border-y border-line bg-surface py-14">
        <div className="container-site">
          <h2 className="text-2xl font-bold">{t('problemTitle')}</h2>
          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            {(t.raw('problems') as Item[]).map((p) => (
              <div key={p.title}>
                <p className="font-semibold text-bad">{p.title}</p>
                <p className="mt-1 text-muted">{p.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="container-site py-16">
        <h2 className="text-3xl font-bold">{t('pillarsTitle')}</h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {(t.raw('pillars') as Item[]).map((p) => (
            <div key={p.title} className="rounded-2xl border border-line bg-surface p-6">
              <p className="text-lg font-semibold">{p.title}</p>
              <p className="mt-2 leading-relaxed text-muted">{p.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container-site py-6">
        <h2 className="text-3xl font-bold">{t('howTitle')}</h2>
        <ol className="mt-8 grid gap-6 md:grid-cols-3">
          {(t.raw('how') as Item[]).map((step, i) => (
            <li key={step.title} className="relative rounded-2xl border border-line bg-surface p-6">
              <span className="flex size-9 items-center justify-center rounded-full bg-brand font-bold text-brand-ink">
                {(i + 1).toLocaleString(locale === 'ar' ? 'ar-EG' : 'en')}
              </span>
              <p className="mt-4 text-lg font-semibold">{step.title}</p>
              <p className="mt-2 leading-relaxed text-muted">{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="container-site grid items-center gap-10 py-16 lg:grid-cols-2">
        <div>
          <h2 className="text-3xl font-bold">{t('channelsTitle')}</h2>
          <p className="mt-4 text-lg leading-relaxed text-muted">{t('channelsText')}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/channels" className={secondaryButton}>
              {c('apiGuide')}
            </Link>
          </div>
        </div>
        <Screen src={`/screens/${locale}/desktop-channels.jpg`} alt={t('channelsTitle')} />
      </section>

      <section className="border-y border-line bg-surface py-14">
        <div className="container-site">
          <h2 className="text-2xl font-bold">{t('trustTitle')}</h2>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(t.raw('trust') as string[]).map((line) => (
              <li key={line} className="flex gap-2">
                <span className="text-ok" aria-hidden="true">
                  ✓
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="container-site py-16 text-center">
        <h2 className="text-3xl font-bold">{t('finalTitle')}</h2>
        <p className="mx-auto mt-3 max-w-xl text-lg text-muted">{t('finalText')}</p>
        <div className="mt-8 flex justify-center">
          <DemoButtons second="docs" />
        </div>
      </section>
    </>
  );
}
