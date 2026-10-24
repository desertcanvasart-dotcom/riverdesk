import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DemoButtons } from '../../../components/cta';
import { Screen } from '../../../components/screen';
import { Link } from '../../../i18n/routing';

type Feature = { key: string; title: string; text: string };

/** Which docs page explains each feature in detail. */
const DOC: Record<string, string> = {
  today: 'today',
  book: 'new-booking',
  booking: 'bookings',
  requests: 'requests',
  inventory: 'inventory',
  fleet: 'ships-and-cabins',
  schedule: 'schedule',
  rates: 'rates',
  channels: 'channels',
  payments: 'payments',
  guests: 'guests-and-manifests',
  vacancy: 'vacancy-sheet',
  settings: 'settings',
};

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'features' });
  return { title: t('title'), description: t('intro') };
}

export default async function Features({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('features');
  const d = await getTranslations('cta');
  return (
    <div className="container-site py-12">
      <h1 className="text-4xl font-bold">{t('title')}</h1>
      <p className="mt-3 max-w-2xl text-lg text-muted">{t('intro')}</p>
      <div className="mt-12 flex flex-col gap-16">
        {(t.raw('items') as Feature[]).map((f, i) => (
          <section key={f.key} className="grid items-center gap-8 lg:grid-cols-2">
            <div className={i % 2 === 1 ? 'lg:order-2' : ''}>
              <h2 className="text-2xl font-bold">{f.title}</h2>
              <p className="mt-3 text-lg leading-relaxed text-muted">{f.text}</p>
              <Link
                href={`/docs/staff-guide/${DOC[f.key]}`}
                className="mt-4 inline-block text-brand hover:underline"
              >
                {d('docs')} →
              </Link>
            </div>
            <Screen src={`/screens/${locale}/desktop-${f.key}.jpg`} alt={f.title} />
          </section>
        ))}
      </div>
      <div className="mt-16 flex justify-center">
        <DemoButtons second="docs" />
      </div>
    </div>
  );
}
