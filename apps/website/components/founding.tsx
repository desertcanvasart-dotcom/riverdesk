import { CheckCircle2, Users } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { site } from '../lib/site';

/** The five promises of the Founding Operator Program and the seats line. */
export async function FoundingPoints({ dark = false }: { dark?: boolean }) {
  const t = await getTranslations('founding');
  const locale = await getLocale();
  const seats = site.foundingSeats.toLocaleString(locale === 'ar' ? 'ar-EG' : 'en');
  return (
    <>
      <ul className="flex flex-col gap-3">
        {(t.raw('points') as string[]).map((point) => (
          <li key={point} className="flex items-start gap-3">
            <CheckCircle2
              aria-hidden
              className={`mt-0.5 size-5 shrink-0 ${dark ? 'text-[#7fe0d6]' : 'text-ok'}`}
            />
            <span className={`leading-relaxed ${dark ? 'text-white/85' : ''}`}>{point}</span>
          </li>
        ))}
      </ul>
      <p
        className={`mt-6 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-semibold ${
          dark ? 'bg-white/10 text-white' : 'bg-sand-soft text-ink'
        }`}
      >
        <Users aria-hidden className={`size-4 ${dark ? 'text-[#7fe0d6]' : 'text-sand'}`} />
        {t('seats', { seats })}
      </p>
    </>
  );
}
