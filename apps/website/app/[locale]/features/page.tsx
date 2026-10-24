import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  ClipboardList,
  House,
  Inbox,
  LayoutGrid,
  PhoneCall,
  Settings,
  Share2,
  Ship,
  Tags,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DemoButtons } from '../../../components/cta';
import { PageHero } from '../../../components/page-hero';
import { Screen } from '../../../components/screen';
import { Link } from '../../../i18n/routing';

type Feature = { key: string; title: string; text: string };

/** Which docs page explains each feature in detail, and its icon (as in the app's menu). */
const DOC: Record<string, [string, LucideIcon]> = {
  today: ['today', House],
  book: ['new-booking', PhoneCall],
  booking: ['bookings', BookOpen],
  requests: ['requests', Inbox],
  inventory: ['inventory', LayoutGrid],
  fleet: ['ships-and-cabins', Ship],
  schedule: ['schedule', CalendarDays],
  rates: ['rates', Tags],
  channels: ['channels', Share2],
  payments: ['payments', Wallet],
  guests: ['guests-and-manifests', Users],
  vacancy: ['vacancy-sheet', ClipboardList],
  settings: ['settings', Settings],
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
  const items = t.raw('items') as Feature[];
  return (
    <>
      <PageHero kicker={t('kicker')} title={t('title')} intro={t('intro')}>
        <nav aria-label={t('jump')} className="mt-8 flex flex-wrap gap-2">
          {items.map((f) => {
            const Icon = DOC[f.key]![1];
            return (
              <a
                key={f.key}
                href={`#${f.key}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-white/80 transition hover:bg-white/15 hover:text-white"
              >
                <Icon aria-hidden className="size-3.5" />
                {f.title}
              </a>
            );
          })}
        </nav>
      </PageHero>
      <div className="container-site flex flex-col gap-24 py-20">
        {items.map((f, i) => {
          const [doc, Icon] = DOC[f.key]!;
          return (
            <section
              key={f.key}
              id={f.key}
              className="grid scroll-mt-24 items-center gap-10 lg:grid-cols-[1fr_1.35fr]"
            >
              <div className={i % 2 === 1 ? 'lg:order-2' : ''}>
                <span className="flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand ring-1 ring-brand/15">
                  <Icon aria-hidden className="size-6" />
                </span>
                <h2 className="mt-5 text-2xl font-bold tracking-tight sm:text-3xl">{f.title}</h2>
                {f.text.split('\n\n').map((para) => (
                  <p key={para} className="mt-4 text-lg leading-relaxed text-muted">
                    {para}
                  </p>
                ))}
                <Link
                  href={`/docs/staff-guide/${doc}`}
                  className="mt-6 inline-flex items-center gap-2 font-semibold text-brand hover:underline"
                >
                  {d('docs')}
                  <ArrowRight aria-hidden className="size-4 rtl:-scale-x-100" />
                </Link>
              </div>
              <Screen src={`/screens/${locale}/desktop-${f.key}.jpg`} alt={f.title} />
            </section>
          );
        })}
      </div>
      <div className="flex justify-center">
        <DemoButtons second="docs" />
      </div>
    </>
  );
}
