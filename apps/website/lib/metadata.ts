import type { Metadata } from 'next';

/**
 * Title, description, canonical link, hreflang alternates and Open Graph for one page.
 * `path` is the page without the language: '' for the home page, '/pilot', '/docs/…'.
 */
export function pageMetadata({
  locale,
  path,
  title,
  description,
  absoluteTitle = false,
}: {
  locale: string;
  path: string;
  title: string;
  description: string;
  /** The home page: the title as is, without "· Riverdesk". */
  absoluteTitle?: boolean;
}): Metadata {
  const url = `/${locale}${path}`;
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: {
      canonical: url,
      languages: { ar: `/ar${path}`, en: `/en${path}`, 'x-default': `/ar${path}` },
    },
    openGraph: {
      type: 'website',
      siteName: 'Riverdesk',
      title,
      description,
      url,
      locale: locale === 'ar' ? 'ar_EG' : 'en_US',
      alternateLocale: locale === 'ar' ? ['en_US'] : ['ar_EG'],
      images: [{ url: `/screens/${locale}/desktop-book.jpg`, width: 1280, height: 800 }],
    },
  };
}
