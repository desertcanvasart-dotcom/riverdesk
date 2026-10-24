import { ArrowRight, ArrowUpRight, Code2, Timer, UserRound } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SECTION_ICON } from '../../../components/doc-icons';
import { DocsSearch } from '../../../components/docs-search';
import { Link } from '../../../i18n/routing';
import { listDocs } from '../../../lib/docs';
import { searchEntries } from '../../../lib/search-entries';
import { site } from '../../../lib/site';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'docs' });
  return { title: t('title'), description: t('intro') };
}

/** Where a new company starts reading, in order. */
const START = [
  'getting-started/first-sign-in',
  'guides/set-up-your-company',
  'guides/take-a-phone-booking',
];

export default async function DocsIndex({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('docs');
  const sections = listDocs(locale);
  const pages = sections.flatMap((s) => s.pages);
  const start = START.map((id) => pages.find((p) => `${p.section}/${p.slug}` === id)).filter(
    (p) => p !== undefined,
  );
  const guides = sections.find((s) => s.section === 'guides')?.pages ?? [];
  const topics = sections.filter((s) => s.section !== 'guides');
  return (
    <>
      <section className="band-deep relative">
        <div className="band-waves absolute inset-0" aria-hidden />
        <div className="container-site relative py-16 text-center sm:py-20">
          <p className="text-sm font-semibold tracking-wider text-[#7fe0d6] uppercase">
            Riverdesk · {t('home')}
          </p>
          <h1 className="mx-auto mt-3 max-w-3xl text-4xl font-bold tracking-tight text-balance text-white sm:text-5xl">
            {t('title')}
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-pretty text-white/70">{t('intro')}</p>
          <div className="mx-auto mt-8 max-w-2xl text-start">
            <DocsSearch entries={await searchEntries(locale)} large />
          </div>
        </div>
      </section>

      <div className="container-site">
        <section className="-mt-8 relative grid gap-4 md:grid-cols-3">
          {start.map((p, i) => (
            <Link
              key={p.slug}
              href={`/docs/${p.section}/${p.slug}`}
              className="group flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-lift)] transition hover:-translate-y-0.5 hover:border-brand"
            >
              <span className="flex items-center gap-3">
                <span className="flex size-8 items-center justify-center rounded-full bg-sand-soft text-sm font-bold text-sand">
                  {(i + 1).toLocaleString(locale === 'ar' ? 'ar-EG' : 'en')}
                </span>
                <span className="text-xs font-semibold tracking-wider text-muted uppercase">
                  {t('startHere')}
                </span>
              </span>
              <span className="mt-4 text-lg font-semibold">{p.title}</span>
              <span className="mt-1 flex-1 text-sm leading-relaxed text-muted">{p.summary}</span>
              <ArrowRight
                aria-hidden
                className="mt-4 size-4 text-brand transition group-hover:translate-x-1 rtl:-scale-x-100 rtl:group-hover:-translate-x-1"
              />
            </Link>
          ))}
        </section>

        {guides.length > 0 && (
          <section className="mt-20">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                  {t('guidesTitle')}
                </h2>
                <p className="mt-2 max-w-2xl text-muted">{t('guidesText')}</p>
              </div>
            </div>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {guides.map((g, i) => (
                <Link
                  key={g.slug}
                  href={`/docs/guides/${g.slug}`}
                  className="group flex flex-col rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] transition hover:-translate-y-0.5 hover:border-brand"
                >
                  <span className="text-xs font-semibold text-brand">
                    {t('guide')} {(i + 1).toLocaleString(locale === 'ar' ? 'ar-EG' : 'en')}
                  </span>
                  <span className="mt-2 font-semibold leading-snug">{g.title}</span>
                  <span className="mt-2 flex-1 text-sm leading-relaxed text-muted">
                    {g.summary}
                  </span>
                  <span className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-muted">
                    {g.who && (
                      <span className="inline-flex items-center gap-1">
                        <UserRound aria-hidden className="size-3.5" />
                        {g.who}
                      </span>
                    )}
                    {g.time && (
                      <span className="inline-flex items-center gap-1">
                        <Timer aria-hidden className="size-3.5" />
                        {g.time}
                      </span>
                    )}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="mt-20">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('browse')}</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {topics.map(({ section, pages }) => {
              const Icon = SECTION_ICON[section];
              return (
                <section
                  key={section}
                  className="rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-card)]"
                >
                  <div className="flex items-start gap-4">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                      <Icon aria-hidden className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold">{t(`section.${section}`)}</h3>
                      <p className="mt-0.5 text-sm text-muted">{t(`sectionIntro.${section}`)}</p>
                      <p className="mt-1 text-xs text-muted">
                        {t('pages', { count: pages.length })}
                      </p>
                    </div>
                  </div>
                  <ul className="mt-5 grid gap-x-4 sm:grid-cols-2">
                    {pages.map((p) => (
                      <li key={p.slug}>
                        <Link
                          href={`/docs/${section}/${p.slug}`}
                          className="group flex items-center gap-2 rounded-lg py-1.5 text-sm hover:text-brand"
                        >
                          <span className="size-1.5 shrink-0 rounded-full bg-line group-hover:bg-brand" />
                          <span className="truncate">{p.title}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </section>

        <section className="band-deep relative mt-20 overflow-hidden rounded-3xl">
          <div className="band-waves absolute inset-0" aria-hidden />
          <div className="relative grid items-center gap-8 p-8 sm:p-10 lg:grid-cols-[1.2fr_1fr]">
            <div>
              <span className="flex size-11 items-center justify-center rounded-xl bg-white/10 text-[#7fe0d6]">
                <Code2 aria-hidden className="size-5" />
              </span>
              <h2 className="mt-4 text-2xl font-bold text-white">{t('devTitle')}</h2>
              <p className="mt-2 max-w-xl leading-relaxed text-white/70">{t('devText')}</p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link
                  href="/docs/channel-api/overview"
                  className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-deep hover:opacity-90"
                >
                  {t('devCta')}
                  <ArrowRight aria-hidden className="size-4 rtl:-scale-x-100" />
                </Link>
                <a
                  href={site.apiDocsUrl}
                  className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/20 px-5 text-sm font-semibold text-white hover:bg-white/10"
                >
                  {t('apiRef')}
                  <ArrowUpRight aria-hidden className="size-4 rtl:-scale-x-100" />
                </a>
              </div>
            </div>
            <pre
              dir="ltr"
              className="overflow-x-auto rounded-2xl border border-white/10 bg-black/30 p-5 text-left text-[0.8rem] leading-relaxed text-[#cfe6e3]"
            >
              <code>
                <span className="text-[#7fe0d6]">GET</span>{' '}
                /v1/availability?from=2026-11-01&amp;to=2026-11-30
                {'\n'}
                <span className="text-white/40">Authorization: Bearer …</span>
                {'\n\n'}
                <span className="text-[#f2c88a]">&quot;embark_date&quot;</span>:
                &quot;2026-11-03&quot;,
                {'\n'}
                <span className="text-[#f2c88a]">&quot;nights&quot;</span>: 4,
                {'\n'}
                <span className="text-[#f2c88a]">&quot;categories&quot;</span>: [{'{'}
                {'\n  '}
                <span className="text-[#f2c88a]">&quot;code&quot;</span>: &quot;DLX&quot;,
                {'\n  '}
                <span className="text-[#f2c88a]">&quot;status&quot;</span>: &quot;instant&quot;,
                {'\n  '}
                <span className="text-[#f2c88a]">&quot;free&quot;</span>: 6,
                {'\n  '}
                <span className="text-[#f2c88a]">&quot;from_price&quot;</span>:{' '}
                {'{ "amount": 82000, "currency": "USD" }'}
                {'\n'}
                {'}]'}
              </code>
            </pre>
          </div>
        </section>
      </div>
    </>
  );
}
