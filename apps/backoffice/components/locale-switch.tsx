'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { switchLocale } from '../app/actions';

export function LocaleSwitch() {
  const locale = useLocale();
  const t = useTranslations('app');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await switchLocale(locale === 'ar' ? 'en' : 'ar');
          router.refresh();
        })
      }
      className="rounded-lg px-3 py-2 text-sm text-brand hover:bg-line/40"
    >
      {t('language')}
    </button>
  );
}
