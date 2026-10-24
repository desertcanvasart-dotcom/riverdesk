import { ChevronDown } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Link } from '../i18n/routing';
import { listDocs } from '../lib/docs';
import { SECTION_ICON } from './doc-icons';
import { DocsSearch, type SearchEntry } from './docs-search';

/** Every docs page by section, with search on top. On a phone it folds into "Contents". */
export async function DocsSidebar({
  locale,
  current,
  search,
}: {
  locale: string;
  current?: string;
  search: SearchEntry[];
}) {
  const t = await getTranslations('docs');
  const sections = listDocs(locale);
  const list = (
    <nav className="flex flex-col gap-1 text-sm">
      {sections.map(({ section, pages }) => {
        const Icon = SECTION_ICON[section];
        const here = current?.startsWith(`${section}/`);
        return (
          <details key={section} open={here || section !== 'channel-api'} className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-2 py-2 font-semibold select-none hover:bg-line/40 [&::-webkit-details-marker]:hidden">
              <span
                className={`flex size-7 items-center justify-center rounded-lg ${
                  here ? 'bg-brand text-brand-ink' : 'bg-brand-soft text-brand'
                }`}
              >
                <Icon aria-hidden className="size-4" />
              </span>
              <span className="flex-1">{t(`section.${section}`)}</span>
              <ChevronDown
                aria-hidden
                className="size-4 text-muted transition-transform group-open:rotate-180"
              />
            </summary>
            <ul className="ms-[1.35rem] mt-1 mb-3 flex flex-col border-s border-line">
              {pages.map((p) => {
                const id = `${p.section}/${p.slug}`;
                return (
                  <li key={id}>
                    <Link
                      href={`/docs/${id}`}
                      aria-current={id === current ? 'page' : undefined}
                      className={`-ms-px block border-s-2 py-1.5 ps-4 leading-snug transition-colors ${
                        id === current
                          ? 'border-brand font-medium text-brand'
                          : 'border-transparent text-muted hover:border-line hover:text-ink'
                      }`}
                    >
                      {p.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
    </nav>
  );
  return (
    <>
      <div className="flex flex-col gap-3 lg:hidden">
        <DocsSearch entries={search} />
        <details className="rounded-2xl border border-line bg-surface p-3">
          <summary className="cursor-pointer text-sm font-semibold">{t('contents')}</summary>
          <div className="mt-3">{list}</div>
        </details>
      </div>
      <aside className="hidden lg:block">
        <div className="sticky top-20 flex max-h-[calc(100dvh-6rem)] flex-col gap-4">
          <DocsSearch entries={search} />
          <div className="min-h-0 overflow-y-auto pe-2 pb-6">{list}</div>
        </div>
      </aside>
    </>
  );
}
