import { defineRouting } from 'next-intl/routing';
import { createNavigation } from 'next-intl/navigation';

/** The language is in the URL (/ar/…, /en/…) so pages can be shared and indexed. Arabic first. */
export const routing = defineRouting({
  locales: ['ar', 'en'],
  defaultLocale: 'ar',
});

export type Locale = (typeof routing.locales)[number];

export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
