import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Marked } from 'marked';

/**
 * Docs are Markdown files: content/docs/<locale>/<section>/<NN-slug>.md, read when the site is
 * built. The number orders the pages; the front matter gives the title and a one-line summary.
 * A page missing in Arabic falls back to English (and says so).
 */

export const SECTIONS = ['getting-started', 'staff-guide', 'channel-api', 'concepts'] as const;
export type Section = (typeof SECTIONS)[number];

const ROOT = join(process.cwd(), 'content', 'docs');

export interface DocMeta {
  section: Section;
  slug: string;
  title: string;
  summary: string;
}

export interface Doc extends DocMeta {
  html: string;
  headings: { id: string; text: string; depth: number }[];
  /** True when this locale has no translation yet and English is shown. */
  fallback: boolean;
}

function parse(raw: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  const meta = Object.fromEntries(
    match[1]!
      .split('\n')
      .map((line) => line.split(/:(.*)/s).map((part) => part.trim()))
      .filter(([key]) => key)
      .map(([key, value]) => [key!, (value ?? '').replace(/^"(.*)"$/, '$1')]),
  );
  return { meta, body: match[2]! };
}

function files(locale: string, section: Section): string[] {
  const dir = join(ROOT, locale, section);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
    : [];
}

const slugOf = (file: string) => file.replace(/^\d+-/, '').replace(/\.md$/, '');

/** The pages of every section, in order (English defines the set and the order). */
export function listDocs(locale: string): { section: Section; pages: DocMeta[] }[] {
  return SECTIONS.map((section) => ({
    section,
    pages: files('en', section).map((file) => {
      const local = join(ROOT, locale, section, file);
      const { meta } = parse(
        readFileSync(existsSync(local) ? local : join(ROOT, 'en', section, file), 'utf8'),
      );
      return {
        section,
        slug: slugOf(file),
        title: meta.title ?? slugOf(file),
        summary: meta.summary ?? '',
      };
    }),
  }));
}

/** Heading ids that keep Arabic letters, so in-page links work in both languages. */
function anchor(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

export function getDoc(locale: string, section: Section, slug: string): Doc | null {
  const file = files('en', section).find((f) => slugOf(f) === slug);
  if (!file) return null;
  const local = join(ROOT, locale, section, file);
  const fallback = !existsSync(local);
  const { meta, body } = parse(
    readFileSync(fallback ? join(ROOT, 'en', section, file) : local, 'utf8'),
  );
  const shownLocale = fallback ? 'en' : locale;
  const headings: Doc['headings'] = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const id = anchor(text);
        if (depth === 2 || depth === 3)
          headings.push({ id, text: text.replace(/<[^>]+>/g, ''), depth });
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        // Site links are written without a language ("/docs/…"): keep the reader's language.
        const target = href.startsWith('/') && !href.startsWith('//') ? `/${locale}${href}` : href;
        const external = /^https?:\/\//.test(href);
        return `<a href="${target}"${title ? ` title="${title}"` : ''}${external ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
      },
    },
  });
  const html = marked.parse(body.replaceAll('{locale}', shownLocale), { async: false }) as string;
  return {
    section,
    slug,
    title: meta.title ?? slug,
    summary: meta.summary ?? '',
    html,
    headings,
    fallback: fallback && locale !== 'en',
  };
}
