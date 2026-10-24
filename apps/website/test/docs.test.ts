import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDoc, listDocs, SECTIONS } from '../lib/docs';

const ROOT = join(process.cwd(), 'content', 'docs');
const PUBLIC = join(process.cwd(), 'public');

describe('docs content', () => {
  const pages = listDocs('en').flatMap((s) => s.pages);

  it('has pages in every section, each with a title and a summary', () => {
    for (const section of SECTIONS)
      expect(listDocs('en').find((s) => s.section === section)!.pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      expect(p.title, `${p.section}/${p.slug}`).not.toBe(p.slug);
      expect(p.summary, `${p.section}/${p.slug}`).not.toBe('');
    }
  });

  it.each(['en', 'ar'])('links only to pages and screenshots that exist (%s)', (locale) => {
    const known = new Set(pages.map((p) => `/${locale}/docs/${p.section}/${p.slug}`));
    for (const p of pages) {
      const doc = getDoc(locale, p.section, p.slug)!;
      for (const [, href] of doc.html.matchAll(/href="([^"]+)"/g)) {
        if (!href!.startsWith(`/${locale}/docs/`)) continue;
        expect(known.has(href!.split('#')[0]!), `${p.section}/${p.slug} → ${href}`).toBe(true);
      }
      for (const [, src] of doc.html.matchAll(/src="([^"]+)"/g)) {
        expect(existsSync(join(PUBLIC, src!)), `${p.section}/${p.slug} → ${src}`).toBe(true);
      }
    }
  });

  it('has no Arabic page without an English original, and Arabic pages have their own title', () => {
    for (const section of SECTIONS) {
      const dir = join(ROOT, 'ar', section);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        expect(existsSync(join(ROOT, 'en', section, file)), `ar/${section}/${file}`).toBe(true);
        const raw = readFileSync(join(dir, file), 'utf8');
        expect(raw, `ar/${section}/${file}`).toMatch(/^---\ntitle: .*[؀-ۿ]/);
      }
    }
  });
});
