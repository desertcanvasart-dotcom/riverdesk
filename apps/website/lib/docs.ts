import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Marked, type Tokens } from 'marked';

/**
 * Docs are Markdown files: content/docs/<locale>/<section>/<NN-slug>.md, read when the site is
 * built. The number orders the pages; the front matter gives the title and a one-line summary.
 * A page missing in Arabic falls back to English (and says so).
 */

export const SECTIONS = [
  'getting-started',
  'guides',
  'staff-guide',
  'concepts',
  'channel-api',
] as const;
export type Section = (typeof SECTIONS)[number];

const ROOT = join(process.cwd(), 'content', 'docs');

export interface DocMeta {
  section: Section;
  slug: string;
  title: string;
  summary: string;
  /** Guides only: who the guide is for and how long it takes. */
  who?: string;
  time?: string;
}

export interface Doc extends DocMeta {
  html: string;
  headings: { id: string; text: string; depth: number }[];
  /** True when this locale has no translation yet and English is shown. */
  fallback: boolean;
  /** Minutes to read, rounded up. */
  minutes: number;
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
        who: meta.who,
        time: meta.time,
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
  const labels = CALLOUTS[shownLocale === 'ar' ? 'ar' : 'en'];
  const headings: Doc['headings'] = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const id = anchor(text);
        if (depth === 2 || depth === 3)
          headings.push({ id, text: text.replace(/<[^>]+>/g, ''), depth });
        const link =
          depth === 2 || depth === 3
            ? `<a class="anchor" href="#${id}" aria-hidden="true">#</a>`
            : '';
        return `<h${depth} id="${id}">${text}${link}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        // Site links are written without a language ("/docs/…"): keep the reader's language.
        const target = href.startsWith('/') && !href.startsWith('//') ? `/${locale}${href}` : href;
        const external = /^https?:\/\//.test(href);
        return `<a href="${target}"${title ? ` title="${title}"` : ''}${external ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
      },
      // A picture on its own line becomes a framed screenshot with its caption (the title).
      paragraph({ tokens }) {
        const only = tokens.filter((t) => !(t.type === 'text' && !t.raw.trim()));
        if (only.length === 1 && only[0]!.type === 'image') {
          const { href, title, text } = only[0] as Tokens.Image;
          return `<figure class="doc-figure"><a class="frame" href="${href}" target="_blank" rel="noopener"><span class="bar" aria-hidden="true"><i></i><i></i><i></i></span><img src="${href}" alt="${escape(text)}" loading="lazy"></a>${title ? `<figcaption>${title}</figcaption>` : ''}</figure>\n`;
        }
        return `<p>${this.parser.parseInline(tokens)}</p>\n`;
      },
      // GitHub-style callouts: "> [!TIP]" on the first line of a quote.
      blockquote({ tokens }) {
        const inner = this.parser.parse(tokens);
        const match = /^<p>\[!(TIP|NOTE|WARNING|IMPORTANT)\]\s*/.exec(inner);
        if (!match) return `<blockquote>${inner}</blockquote>\n`;
        const kind = match[1] === 'IMPORTANT' ? 'WARNING' : (match[1] as keyof typeof labels);
        const rest = inner.slice(match[0].length).replace(/^<\/p>\s*/, '');
        const body = rest.startsWith('<') ? rest : `<p>${rest}`;
        return `<aside class="callout callout-${kind.toLowerCase()}"><p class="callout-title">${ICONS[kind]}${labels[kind]}</p>${body}</aside>\n`;
      },
    },
  });
  // The page header shows the title, so the Markdown's own "# Title" is left out.
  const text = body.replace(/^\s*# .*\n/, '');
  const html = (marked.parse(text.replaceAll('{locale}', shownLocale), { async: false }) as string)
    // Steps continued after a note keep their numbers (the badges are a CSS counter).
    .replace(
      /<ol start="(\d+)">/g,
      (_, n) => `<ol start="${n}" style="counter-reset: step ${Number(n) - 1}">`,
    );
  const words = text.split(/\s+/).filter(Boolean).length;
  return {
    section,
    slug,
    title: meta.title ?? slug,
    summary: meta.summary ?? '',
    who: meta.who,
    time: meta.time,
    html,
    headings,
    fallback: fallback && locale !== 'en',
    minutes: Math.max(1, Math.ceil(words / 200)),
  };
}

const CALLOUTS = {
  en: { TIP: 'Tip', NOTE: 'Note', WARNING: 'Watch out' },
  ar: { TIP: 'نصيحة', NOTE: 'ملاحظة', WARNING: 'انتبه' },
};

const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  TIP: svg(
    '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
  ),
  NOTE: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  WARNING: svg(
    '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3zM12 9v4M12 17h.01"/>',
  ),
};

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const indexes = new Map<string, ReturnType<typeof buildIndex>>();

/** What the docs search looks through: every page's title, summary and headings. */
export function searchIndex(locale: string) {
  if (!indexes.has(locale)) indexes.set(locale, buildIndex(locale));
  return indexes.get(locale)!;
}

function buildIndex(locale: string) {
  return listDocs(locale).flatMap(({ section, pages }) =>
    pages.map((p) => {
      const doc = getDoc(locale, section, p.slug)!;
      return {
        href: `/docs/${section}/${p.slug}`,
        section,
        title: p.title,
        summary: p.summary,
        headings: doc.headings.map((h) => h.text),
      };
    }),
  );
}
