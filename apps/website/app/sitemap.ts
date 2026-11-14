import type { MetadataRoute } from 'next';
import { listDocs } from '../lib/docs';
import { site } from '../lib/site';
import { routing } from '../i18n/routing';

const PAGES = ['', '/features', '/channels', '/charter', '/security', '/pilot', '/docs'];

/** Every page in both languages, each with its other-language alternate. */
export default function sitemap(): MetadataRoute.Sitemap {
  const docs = listDocs('en').flatMap(({ section, pages }) =>
    pages.map((p) => `/docs/${section}/${p.slug}`),
  );
  return [...PAGES, ...docs].flatMap((path) =>
    routing.locales.map((locale) => ({
      url: `${site.siteUrl}/${locale}${path}`,
      alternates: {
        languages: Object.fromEntries(
          routing.locales.map((other) => [other, `${site.siteUrl}/${other}${path}`]),
        ),
      },
    })),
  );
}
