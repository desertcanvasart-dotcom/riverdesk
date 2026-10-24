import { getTranslations } from 'next-intl/server';
import type { SearchEntry } from '../components/docs-search';
import { searchIndex } from './docs';

/** The docs search data for one language, with each section's name. */
export async function searchEntries(locale: string): Promise<SearchEntry[]> {
  const t = await getTranslations({ locale, namespace: 'docs' });
  return searchIndex(locale).map(({ section, ...entry }) => ({
    ...entry,
    sectionLabel: t(`section.${section}`),
  }));
}
