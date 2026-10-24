import {
  Building2,
  DatabaseBackup,
  FileSearch,
  Globe2,
  KeyRound,
  LockKeyhole,
  ScrollText,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { PageHero } from '../../../components/page-hero';

type Item = { title: string; text: string };

const ICONS: LucideIcon[] = [
  Building2,
  LockKeyhole,
  KeyRound,
  ScrollText,
  ShieldCheck,
  DatabaseBackup,
  FileSearch,
  Globe2,
];

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
    <>
      <PageHero kicker={t('kicker')} title={t('title')} intro={t('intro')} />
      <div className="container-site grid gap-5 py-20 md:grid-cols-2">
        {(t.raw('items') as Item[]).map((x, i) => {
          const Icon = ICONS[i] ?? ShieldCheck;
          return (
            <section
              key={x.title}
              className="flex gap-5 rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-card)]"
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <Icon aria-hidden className="size-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold">{x.title}</h2>
                <p className="mt-2 leading-relaxed text-muted">{x.text}</p>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
