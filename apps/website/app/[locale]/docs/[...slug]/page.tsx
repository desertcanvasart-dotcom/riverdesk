import { ArrowLeft, ArrowRight, Clock, Timer, UserRound } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { pageMetadata } from '../../../../lib/metadata';
import { SECTION_ICON } from '../../../../components/doc-icons';
import { DocToc } from '../../../../components/doc-toc';
import { DocsSidebar } from '../../../../components/docs-sidebar';
import { Link, routing } from '../../../../i18n/routing';
import { getDoc, listDocs, SECTIONS, type Section } from '../../../../lib/docs';
import { searchEntries } from '../../../../lib/search-entries';

export function generateStaticParams() {
  return routing.locales.flatMap((locale) =>
    listDocs(locale).flatMap(({ section, pages }) =>
      pages.map((p) => ({ locale, slug: [section, p.slug] })),
    ),
  );
}

type Params = Promise<{ locale: string; slug: string[] }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { locale, slug } = await params;
  const doc = SECTIONS.includes(slug[0] as Section)
    ? getDoc(locale, slug[0] as Section, slug[1] ?? '')
    : null;
  return doc
    ? pageMetadata({
        locale,
        path: `/docs/${slug[0]}/${slug[1]}`,
        title: doc.title,
        description: doc.summary,
      })
    : {};
}

export default async function DocPage({ params }: { params: Params }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  if (slug.length !== 2 || !SECTIONS.includes(slug[0] as Section)) notFound();
  const doc = getDoc(locale, slug[0] as Section, slug[1]!);
  if (!doc) notFound();
  const t = await getTranslations('docs');
  const all = listDocs(locale).flatMap((s) => s.pages);
  const index = all.findIndex((p) => p.section === doc.section && p.slug === doc.slug);
  const prev = all[index - 1];
  const next = all[index + 1];
  const Icon = SECTION_ICON[doc.section];
  const Back = locale === 'ar' ? ArrowRight : ArrowLeft;
  const Forward = locale === 'ar' ? ArrowLeft : ArrowRight;
  const chip =
    'inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted';
  return (
    <div className="container-site grid gap-10 py-8 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)_14rem]">
      <DocsSidebar
        locale={locale}
        current={`${doc.section}/${doc.slug}`}
        search={await searchEntries(locale)}
      />
      <article className="min-w-0 max-w-3xl">
        <nav aria-label="breadcrumb" className="flex items-center gap-2 text-sm text-muted">
          <Link href="/docs" className="hover:text-ink">
            {t('home')}
          </Link>
          <span aria-hidden>/</span>
          <span className="inline-flex items-center gap-1.5 text-brand">
            <Icon aria-hidden className="size-4" />
            {t(`section.${doc.section}`)}
          </span>
        </nav>
        <header className="mt-4 border-b border-line pb-7">
          <h1 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">
            {doc.title}
          </h1>
          {doc.summary && (
            <p className="mt-3 text-lg leading-relaxed text-pretty text-muted">{doc.summary}</p>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            {doc.who && (
              <span className={chip}>
                <UserRound aria-hidden className="size-3.5" />
                {t('who')}: <span className="font-medium text-ink">{doc.who}</span>
              </span>
            )}
            {doc.time && (
              <span className={chip}>
                <Timer aria-hidden className="size-3.5" />
                {t('time')}: <span className="font-medium text-ink">{doc.time}</span>
              </span>
            )}
            <span className={chip}>
              <Clock aria-hidden className="size-3.5" />
              {t('minRead', { n: doc.minutes })}
            </span>
          </div>
        </header>
        {doc.fallback && (
          <p className="mt-6 rounded-xl bg-warn-bg px-4 py-3 text-sm text-warn">{t('fallback')}</p>
        )}
        <div
          className="prose-doc mt-8"
          dir={doc.fallback ? 'ltr' : undefined}
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />
        <nav className="mt-16 grid gap-4 sm:grid-cols-2">
          {prev ? (
            <Link
              href={`/docs/${prev.section}/${prev.slug}`}
              className="group rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] transition hover:-translate-y-0.5 hover:border-brand"
            >
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <Back
                  aria-hidden
                  className="size-3.5 transition group-hover:-translate-x-0.5 rtl:group-hover:translate-x-0.5"
                />
                {t('previous')}
              </span>
              <span className="mt-1 block font-semibold">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link
              href={`/docs/${next.section}/${next.slug}`}
              className="group rounded-2xl border border-line bg-surface p-5 text-end shadow-[var(--shadow-card)] transition hover:-translate-y-0.5 hover:border-brand"
            >
              <span className="flex items-center justify-end gap-1.5 text-xs text-muted">
                {t('next')}
                <Forward aria-hidden className="size-3.5" />
              </span>
              <span className="mt-1 block font-semibold">{next.title}</span>
              {next.section !== doc.section && (
                <span className="block text-xs text-muted">{t(`section.${next.section}`)}</span>
              )}
            </Link>
          )}
        </nav>
      </article>
      {doc.headings.length > 1 && (
        <aside className="hidden xl:block">
          <div className="sticky top-24">
            <DocToc title={t('onThisPage')} headings={doc.headings} />
          </div>
        </aside>
      )}
    </div>
  );
}
