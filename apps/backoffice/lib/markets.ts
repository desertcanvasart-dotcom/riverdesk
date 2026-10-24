'use client';

import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useTRPC } from './trpc';

/** The company's markets, and a market code → its name in the screen's language. */
export function useMarkets() {
  const trpc = useTRPC();
  const locale = useLocale();
  const tbook = useTranslations('book');
  const markets = useQuery(trpc.settings.markets.queryOptions());
  const name = (code: string) => {
    const m = markets.data?.find((x) => x.code === code);
    if (m) return locale.startsWith('ar') ? m.nameAr : m.nameEn;
    return tbook.has(`market_${code}`) ? tbook(`market_${code}`) : code;
  };
  return { markets: markets.data ?? [], name };
}
