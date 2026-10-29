import {
  ArrowRight,
  BellRing,
  CalendarCheck2,
  ChartColumn,
  ChevronDown,
  ClipboardCheck,
  CircleAlert,
  Compass,
  Copy,
  FileStack,
  FileText,
  Handshake,
  KeyRound,
  Languages,
  LockKeyhole,
  Network,
  PhoneCall,
  Receipt,
  ShieldCheck,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DemoButtons, Kicker, primaryButton, secondaryButton } from '../../components/cta';
import { FoundingPoints } from '../../components/founding';
import { Screen } from '../../components/screen';
import { Link } from '../../i18n/routing';
import { pageMetadata } from '../../lib/metadata';
import { site } from '../../lib/site';

type Item = { title: string; text: string };
type Stat = { value: string; label: string };
type Question = { q: string; a: string };

const PROBLEM_ICONS: LucideIcon[] = [Copy, CircleAlert, FileStack];
const PILLAR_ICONS: LucideIcon[] = [
  ShieldCheck,
  PhoneCall,
  Network,
  Languages,
  FileText,
  BellRing,
  Receipt,
  ClipboardCheck,
  ChartColumn,
];
const CHARTER_ICONS: LucideIcon[] = [KeyRound, LockKeyhole, SlidersHorizontal, Handshake];

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta' });
  return pageMetadata({
    locale,
    path: '',
    title: t('title'),
    description: t('description'),
    absoluteTitle: true,
  });
}

/** Organization, SoftwareApplication and FAQPage structured data, in the page's language. */
async function structuredData(locale: string) {
  const meta = await getTranslations({ locale, namespace: 'meta' });
  const founding = await getTranslations({ locale, namespace: 'founding' });
  const faq = await getTranslations({ locale, namespace: 'faq' });
  const url = `${site.siteUrl}/${locale}`;
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${site.siteUrl}/#organization`,
      name: 'Riverdesk',
      url: site.siteUrl,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'Riverdesk',
      url,
      description: meta('description'),
      inLanguage: locale,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      publisher: { '@id': `${site.siteUrl}/#organization` },
      offers: {
        '@type': 'Offer',
        name: founding('title'),
        description: founding('text'),
        price: '0',
        priceCurrency: 'USD',
        url: `${url}/pilot`,
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      inLanguage: locale,
      mainEntity: (faq.raw('items') as Question[]).map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    },
  ];
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('home');
  const f = await getTranslations('founding');
  const charter = await getTranslations('charter');
  const faq = await getTranslations('faq');
  const num = (n: number) => n.toLocaleString(locale === 'ar' ? 'ar-EG' : 'en');
  return (
    <>
      <script
        type="application/ld+json"
        // JSON.stringify output, with < escaped so no string can close the script tag.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(await structuredData(locale)).replace(/</g, '\\u003c'),
        }}
      />
      <section className="band-deep relative overflow-hidden">
        <div className="band-waves absolute inset-0" aria-hidden />
        <div className="container-site relative grid items-center gap-12 pt-16 pb-28 lg:grid-cols-[1fr_1.15fr] lg:pt-24 lg:pb-36">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-white/80">
              <span className="size-1.5 rounded-full bg-[#7fe0d6]" />
              {t('eyebrow')}
            </span>
            <h1 className="mt-5 text-4xl leading-[1.1] font-bold tracking-tight text-balance text-white sm:text-5xl lg:text-[3.4rem]">
              {t('title')}
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-pretty text-white/70">
              {t('subtitle')}
            </p>
            <div className="mt-9">
              <DemoButtons second="video" dark />
            </div>
          </div>
          <div className="relative">
            <div
              className="absolute -inset-6 rounded-[2rem] bg-[#4fbcbc]/10 blur-2xl"
              aria-hidden
            />
            <Screen dark src={`/screens/${locale}/desktop-book.jpg`} alt={t('pillars.1.title')} />
            <Screen
              phone
              src={`/screens/${locale}/phone-today.jpg`}
              alt={t('pillars.5.title')}
              className="absolute -bottom-14 w-28 sm:w-36 ltr:-right-3 rtl:-left-3 lg:ltr:-right-8 lg:rtl:-left-8"
            />
          </div>
        </div>
      </section>

      <section className="container-site relative -mt-14">
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-lift)]">
          <h2 className="border-b border-line px-6 py-3 text-xs font-semibold tracking-[0.14em] text-sand uppercase">
            {t('statsTitle')}
          </h2>
          <dl className="grid grid-cols-2 lg:grid-cols-4">
            {(t.raw('stats') as Stat[]).map((s, i) => (
              <div
                key={s.label}
                className={`p-6 ${i > 0 ? 'border-line lg:border-s' : ''} ${i % 2 === 1 ? 'border-s' : ''} ${i >= 2 ? 'border-t lg:border-t-0' : ''}`}
              >
                <dt className="sr-only">{s.label}</dt>
                <dd>
                  <span
                    className={`block font-bold tracking-tight text-brand ${
                      s.value.length > 12 ? 'text-xl leading-snug' : 'text-3xl'
                    }`}
                  >
                    {s.value}
                  </span>
                  <span className="mt-1 block text-sm leading-snug text-muted">{s.label}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="container-site py-24">
        <div className="max-w-2xl">
          <Kicker>{t('problemKicker')}</Kicker>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
            {t('problemTitle')}
          </h2>
        </div>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {(t.raw('problems') as Item[]).map((p, i) => {
            const Icon = PROBLEM_ICONS[i]!;
            return (
              <div
                key={p.title}
                className="rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-card)]"
              >
                <span className="flex size-10 items-center justify-center rounded-xl bg-bad-bg text-bad">
                  <Icon aria-hidden className="size-5" />
                </span>
                <p className="mt-4 text-lg font-semibold">{p.title}</p>
                <p className="mt-2 leading-relaxed text-muted">{p.text}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="border-y border-line bg-surface py-24">
        <div className="container-site">
          <div className="max-w-2xl">
            <Kicker>{t('pillarsKicker')}</Kicker>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
              {t('pillarsTitle')}
            </h2>
          </div>
          <div className="mt-12 grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
            {(t.raw('pillars') as Item[]).map((p, i) => {
              const Icon = PILLAR_ICONS[i]!;
              return (
                <div key={p.title}>
                  <span className="flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand ring-1 ring-brand/15">
                    <Icon aria-hidden className="size-6" />
                  </span>
                  <p className="mt-5 text-lg font-semibold">{p.title}</p>
                  <p className="mt-2 leading-relaxed text-muted">{p.text}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="container-site py-24">
        <div className="grid items-start gap-12 lg:grid-cols-[1fr_1.1fr]">
          <div>
            {t('howKicker') && <Kicker>{t('howKicker')}</Kicker>}
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">{t('howTitle')}</h2>
            <ol className="mt-10 flex flex-col">
              {(t.raw('how') as Item[]).map((step, i, all) => (
                <li key={step.title} className="relative flex gap-5 pb-10 last:pb-0">
                  {i < all.length - 1 && (
                    <span
                      className="absolute top-12 bottom-0 w-px bg-line ltr:left-5 rtl:right-5"
                      aria-hidden
                    />
                  )}
                  <span className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-brand font-bold text-brand-ink shadow-sm">
                    {num(i + 1)}
                  </span>
                  <div>
                    <p className="text-lg font-semibold">{step.title}</p>
                    <p className="mt-2 leading-relaxed text-muted">{step.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <Screen
            src={`/screens/${locale}/guide-getting-started.jpg`}
            alt={t('how.0.title')}
            className="lg:mt-16"
          />
        </div>
      </section>

      <section id="founding" className="container-site pb-24">
        <div className="grid gap-10 rounded-3xl border border-line bg-brand-soft/50 p-6 sm:p-10 lg:grid-cols-[1.1fr_1fr] lg:p-12">
          <div>
            <Kicker>{f('kicker')}</Kicker>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
              {f('title')}
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-muted">{f('text')}</p>
            <Link href="/pilot" className={`${primaryButton} mt-8`}>
              {f('cta')}
              <ArrowRight aria-hidden className="size-4 rtl:-scale-x-100" />
            </Link>
          </div>
          <div className="rounded-2xl bg-surface p-6 shadow-[var(--shadow-card)] sm:p-8">
            <FoundingPoints />
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-surface py-24">
        <div className="container-site grid items-center gap-12 lg:grid-cols-2">
          <div className="lg:order-2">
            <Kicker>{t('channelsKicker')}</Kicker>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
              {t('channelsTitle')}
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-muted">{t('channelsText')}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/channels" className={secondaryButton}>
                {t('channelsLink')}
                <ArrowRight aria-hidden className="size-4 rtl:-scale-x-100" />
              </Link>
            </div>
          </div>
          <Screen src={`/screens/${locale}/desktop-channels.jpg`} alt={t('channelsTitle')} />
        </div>
      </section>

      <section className="container-site py-24">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <Kicker>{t('trustKicker')}</Kicker>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              {t('trustTitle')}
            </h2>
            <Link
              href="/security"
              className="mt-6 inline-flex items-center gap-2 font-semibold text-brand hover:underline"
            >
              {t('learnMore')}
              <ArrowRight aria-hidden className="size-4 rtl:-scale-x-100" />
            </Link>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2">
            {(t.raw('trust') as string[]).map((line, i) => (
              <li
                key={line}
                className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow-card)]"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ok-bg text-ok">
                  {i % 2 === 0 ? (
                    <LockKeyhole aria-hidden className="size-4" />
                  ) : (
                    <ShieldCheck aria-hidden className="size-4" />
                  )}
                </span>
                <span className="leading-relaxed">{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-y border-line bg-surface py-24">
        <div className="container-site">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="max-w-2xl">
              <Kicker>{charter('kicker')}</Kicker>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
                {charter('homeTitle')}
              </h2>
            </div>
            <Link
              href="/charter"
              className="inline-flex items-center gap-2 font-semibold text-brand hover:underline"
            >
              {charter('homeLink')}
              <ArrowRight aria-hidden className="size-4 rtl:-scale-x-100" />
            </Link>
          </div>
          <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {(charter.raw('points') as string[]).slice(0, 4).map((point, i) => {
              const Icon = CHARTER_ICONS[i]!;
              return (
                <li
                  key={point}
                  className="rounded-2xl border border-line bg-bg p-6 shadow-[var(--shadow-card)]"
                >
                  <span className="flex size-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
                    <Icon aria-hidden className="size-5" />
                  </span>
                  <p className="mt-4 leading-relaxed">{point}</p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="container-site mt-24">
        <Link
          href="/docs"
          className="group flex flex-col items-start gap-6 rounded-3xl border border-line bg-sand-soft/60 p-8 transition hover:border-sand sm:flex-row sm:items-center sm:p-10"
        >
          <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-surface text-sand shadow-[var(--shadow-card)]">
            <Compass aria-hidden className="size-7" />
          </span>
          <span className="flex-1">
            <span className="block text-xl font-bold">{t('guidesTitle')}</span>
            <span className="mt-1 block leading-relaxed text-muted">{t('guidesText')}</span>
          </span>
          <span className="inline-flex items-center gap-2 font-semibold text-ink">
            {t('guidesCta')}
            <ArrowRight
              aria-hidden
              className="size-4 transition group-hover:translate-x-1 rtl:-scale-x-100 rtl:group-hover:-translate-x-1"
            />
          </span>
        </Link>
      </section>

      <section className="container-site mt-24">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div>
            <Kicker>{faq('kicker')}</Kicker>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">{faq('title')}</h2>
          </div>
          <div className="divide-y divide-line rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]">
            {(faq.raw('items') as Question[]).map((item) => (
              <details key={item.q} className="group px-6 py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-lg font-semibold [&::-webkit-details-marker]:hidden">
                  {item.q}
                  <ChevronDown
                    aria-hidden
                    className="size-5 shrink-0 text-muted transition group-open:rotate-180"
                  />
                </summary>
                <p className="mt-3 leading-relaxed text-muted">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="container-site mt-24">
        <div className="band-deep relative overflow-hidden rounded-3xl px-6 py-16 text-center sm:px-12">
          <div className="band-waves absolute inset-0" aria-hidden />
          <div className="relative">
            <CalendarCheck2 aria-hidden className="mx-auto size-10 text-[#7fe0d6]" />
            <h2 className="mt-5 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              {t('finalTitle')}
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-white/70">{t('finalText')}</p>
            <div className="mt-9 flex justify-center">
              <DemoButtons second="start" dark />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
