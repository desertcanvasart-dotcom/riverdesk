import { getTranslations, setRequestLocale } from 'next-intl/server';

type Item = { title: string; text: string };

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'security' });
  return { title: t('title'), description: t('intro') };
}

export default async function Security({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('security');
  return (
    <div className="container-site py-12">
      <h1 className="text-4xl font-bold">{t('title')}</h1>
      <p className="mt-3 max-w-2xl text-lg text-muted">{t('intro')}</p>
      <div className="mt-12 grid gap-5 md:grid-cols-2">
        {(t.raw('items') as Item[]).map((x) => (
          <section key={x.title} className="rounded-2xl border border-line bg-surface p-6">
            <h2 className="text-lg font-semibold">{x.title}</h2>
            <p className="mt-2 leading-relaxed text-muted">{x.text}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
