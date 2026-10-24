import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DocsSidebar } from '../../../../components/docs-sidebar';
import { Link, routing } from '../../../../i18n/routing';
import { getDoc, listDocs, SECTIONS, type Section } from '../../../../lib/docs';

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
  return doc ? { title: doc.title, description: doc.summary } : {};
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
  return (
    <div className="container-site grid gap-8 py-8 lg:grid-cols-[15rem_minmax(0,1fr)_13rem]">
      <DocsSidebar locale={locale} current={`${doc.section}/${doc.slug}`} />
      <article className="min-w-0">
        <p className="mb-2 text-sm text-brand">{t(`section.${doc.section}`)}</p>
        {doc.fallback && (
          <p className="mb-4 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">{t('fallback')}</p>
        )}
        <div
          className="prose-doc"
          dir={doc.fallback ? 'ltr' : undefined}
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />
        <nav className="mt-12 grid gap-3 border-t border-line pt-6 sm:grid-cols-2">
          {prev ? (
            <Link
              href={`/docs/${prev.section}/${prev.slug}`}
              className="rounded-xl border border-line p-4 hover:border-brand"
            >
              <span className="block text-xs text-muted">{t('previous')}</span>
              <span className="font-medium">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link
              href={`/docs/${next.section}/${next.slug}`}
              className="rounded-xl border border-line p-4 text-end hover:border-brand"
            >
              <span className="block text-xs text-muted">{t('next')}</span>
              <span className="font-medium">{next.title}</span>
            </Link>
          )}
        </nav>
      </article>
      {doc.headings.length > 1 && (
        <aside className="hidden lg:block">
          <div className="sticky top-24 text-sm">
            <p className="mb-2 font-semibold">{t('onThisPage')}</p>
            <ul className="flex flex-col gap-1.5">
              {doc.headings.map((h) => (
                <li key={h.id} className={h.depth === 3 ? 'ps-3' : ''}>
                  <a href={`#${h.id}`} className="text-muted hover:text-brand">
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      )}
    </div>
  );
}
