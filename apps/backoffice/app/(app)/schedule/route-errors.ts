'use client';

import { useTranslations } from 'next-intl';
import { useErrorText } from '../../../lib/errors';

/** Route rules and refusals in words: the engine sends stable codes (see backoffice/routes.ts). */
export function useRouteError() {
  const t = useTranslations('routes');
  const errorText = useErrorText();
  return (error: unknown): string => {
    const details = (
      error as { data?: { domainDetails?: { reason?: string; problems?: string[] } } } | null
    )?.data?.domainDetails;
    if (details?.reason === 'invalid_route' && details.problems?.length)
      return details.problems
        .map((p) => (t.has(`problems.${p}`) ? t(`problems.${p}`) : p))
        .join(' ');
    if (details?.reason && t.has(`refusals.${details.reason}`))
      return t(`refusals.${details.reason}`);
    return errorText(error);
  };
}
