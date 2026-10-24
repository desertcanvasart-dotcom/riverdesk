import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '../../../i18n/routing';
import { listDocs } from '../../../lib/docs';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'docs' });
  return { title: t('title'), description: t('intro') };
}

export default async function DocsIndex({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('docs');
  return (
    <div className="container-site py-12">
      <h1 className="text-3xl font-bold">{t('title')}</h1>
      <p className="mt-3 max-w-2xl text-lg text-muted">{t('intro')}</p>
      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {listDocs(locale).map(({ section, pages }) => (
          <section key={section} className="rounded-2xl border border-line bg-surface p-6">
            <h2 className="text-lg font-semibold">{t(`section.${section}`)}</h2>
            <p className="mt-1 text-sm text-muted">{t(`sectionIntro.${section}`)}</p>
            <ul className="mt-4 flex flex-col gap-2">
              {pages.map((p) => (
                <li key={p.slug}>
                  <Link href={`/docs/${section}/${p.slug}`} className="group block">
                    <span className="font-medium text-brand group-hover:underline">{p.title}</span>
                    {p.summary && <span className="block text-sm text-muted">{p.summary}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
