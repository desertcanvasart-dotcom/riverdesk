import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

export const LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = 'vs_locale';

/** The staff member's language, kept in a cookie (and on their staff profile); Arabic by default. */
export default getRequestConfig(async () => {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale = value === 'en' ? 'en' : 'ar';
  return {
    locale,
    timeZone: 'Africa/Cairo',
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
