'use client';

import { useTranslations } from 'next-intl';

/** The translated message for a failed call: the domain code when there is one. */
export function useErrorText() {
  const t = useTranslations('errors');
  return (error: unknown): string => {
    const data = (error as { data?: { domainCode?: string; code?: string } } | null)?.data;
    const code = data?.domainCode ?? (data?.code === 'FORBIDDEN' ? 'FORBIDDEN' : undefined);
    return code && t.has(code) ? t(code) : t('INTERNAL');
  };
}
