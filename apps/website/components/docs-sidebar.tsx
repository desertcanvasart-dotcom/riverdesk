import { getTranslations } from 'next-intl/server';
import { Link } from '../i18n/routing';
import { listDocs } from '../lib/docs';

/** Every docs page by section. On a phone it folds into a "Contents" disclosure. */
export async function DocsSidebar({ locale, current }: { locale: string; current?: string }) {
  const t = await getTranslations('docs');
  const sections = listDocs(locale);
  const list = (
    <nav className="flex flex-col gap-5 text-sm">
      {sections.map(({ section, pages }) => (
        <div key={section}>
          <p className="mb-1.5 font-semibold">{t(`section.${section}`)}</p>
          <ul className="flex flex-col border-s border-line">
            {pages.map((p) => {
              const id = `${p.section}/${p.slug}`;
              return (
                <li key={id}>
                  <Link
                    href={`/docs/${id}`}
                    aria-current={id === current ? 'page' : undefined}
                    className={`-ms-px block border-s-2 py-1 ps-3 ${
                      id === current
                        ? 'border-brand font-medium text-brand'
                        : 'border-transparent text-muted hover:text-ink'
                    }`}
                  >
                    {p.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
  return (
    <>
      <details className="rounded-xl border border-line bg-surface p-3 lg:hidden">
        <summary className="cursor-pointer text-sm font-medium">{t('contents')}</summary>
        <div className="mt-3">{list}</div>
      </details>
      <aside className="hidden lg:block">
        <div className="sticky top-24 max-h-[calc(100dvh-7rem)] overflow-y-auto pe-2">{list}</div>
      </aside>
    </>
  );
}
