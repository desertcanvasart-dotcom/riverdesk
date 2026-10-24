'use client';

import { useTranslations } from 'next-intl';
import { useErrorText } from '../../../lib/errors';

/** Season and policy refusals in words: the engine sends stable reasons (backoffice/policies.ts). */
export function usePolicyError() {
  const t = useTranslations('policies');
  const errorText = useErrorText();
  return (error: unknown): string => {
    const details = (
      error as { data?: { domainDetails?: { reason?: string; age?: number } } } | null
    )?.data?.domainDetails;
    if (details?.reason && t.has(`errors.${details.reason}`))
      return t(`errors.${details.reason}`, { age: details.age ?? 0 });
    return errorText(error);
  };
}

/** "12.5" → 1250 basis points; null when it is not a percentage between 0 and 100. */
export function percentToBps(text: string): number | null {
  const western = text
    .trim()
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
    .replace('٫', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(western)) return null;
  const bps = Math.round(Number(western) * 100);
  return bps <= 10_000 ? bps : null;
}

export const bpsToPercent = (bps: number) => String(bps / 100);

export const CURRENCIES = ['EGP', 'USD', 'EUR', 'GBP'] as const;
