import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  CreditCard,
  Handshake,
  MessageSquareReply,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { pageMetadata } from '../../../lib/metadata';
import { PageHero } from '../../../components/page-hero';
import { Screen } from '../../../components/screen';
import { Link } from '../../../i18n/routing';
import { site } from '../../../lib/site';

type Item = { title: string; text: string };

const CONTRACT_ICONS: LucideIcon[] = [Boxes, Handshake, MessageSquareReply];
const PAYMENT_ICONS: LucideIcon[] = [Wallet, CreditCard, Handshake];

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'channels' });
  return pageMetadata({ locale, path: '/channels', title: t('title'), description: t('intro') });
}

export default async function Channels({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('channels');
  const c = await getTranslations('cta');
  return (
    <>
      <PageHero kicker={t('kicker')} title={t('title')} intro={t('intro')} />
      <div className="container-site py-20">
        <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('contractsTitle')}</h2>
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {(t.raw('contracts') as Item[]).map((x, i) => {
            const Icon = CONTRACT_ICONS[i]!;
            return (
              <div
                key={x.title}
                className="rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-card)]"
              >
                <span className="flex size-11 items-center justify-center rounded-xl bg-brand-soft text-brand">
                  <Icon aria-hidden className="size-5" />
                </span>
                <p className="mt-4 text-lg font-semibold">{x.title}</p>
                <p className="mt-2 leading-relaxed text-muted">{x.text}</p>
              </div>
            );
          })}
        </div>

        <div className="mt-20 grid items-center gap-10 lg:grid-cols-[1fr_1.3fr]">
          <div>
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('paymentTitle')}</h2>
            <p className="mt-3 text-muted">{t('paymentIntro')}</p>
            <ul className="mt-6 flex flex-col gap-3">
              {(t.raw('payment') as string[]).map((line, i) => {
                const Icon = PAYMENT_ICONS[i] ?? Wallet;
                return (
                  <li
                    key={line}
                    className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3"
                  >
                    <Icon aria-hidden className="size-5 shrink-0 text-sand" />
                    {line}
                  </li>
                );
              })}
            </ul>
          </div>
          <Screen src={`/screens/${locale}/guide-contract.jpg`} alt={t('contractsTitle')} />
        </div>

        <section className="band-deep relative mt-20 overflow-hidden rounded-3xl">
          <div className="band-waves absolute inset-0" aria-hidden />
          <div className="relative p-8 sm:p-10">
            <h2 className="text-2xl font-bold text-white sm:text-3xl">{t('apiTitle')}</h2>
            {t('apiText')
              .split('\n\n')
              .map((para) => (
                <p key={para} className="mt-3 max-w-3xl text-lg leading-relaxed text-white/70">
                  {para}
                </p>
              ))}
            <h3 className="mt-8 font-semibold text-white">{t('apiPointsTitle')}</h3>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(t.raw('apiPoints') as string[]).map((line) => (
                <li key={line} className="flex items-center gap-2.5 text-white/90">
                  <CheckCircle2 aria-hidden className="size-5 shrink-0 text-[#7fe0d6]" />
                  {line}
                </li>
              ))}
            </ul>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link
                href="/docs/channel-api/overview"
                className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-6 text-sm font-semibold text-deep hover:opacity-90"
              >
                {c('apiGuide')}
                <ArrowRight aria-hidden className="size-4 rtl:-scale-x-100" />
              </Link>
              <a
                href={site.apiDocsUrl}
                className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/25 px-6 text-sm font-semibold text-white hover:bg-white/10"
              >
                {c('apiReference')}
                <ArrowUpRight aria-hidden className="size-4 rtl:-scale-x-100" />
              </a>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
