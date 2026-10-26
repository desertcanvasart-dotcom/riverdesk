import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentBrand } from '@vs/engine';
import { findRepoRoot } from '@vs/shared';
import { brandPalette } from '@vs/shared/color';
import { translator, type DocLocale } from './i18n';

/**
 * Fonts are embedded, so a document looks the same on any server (Arabic shaping included). They
 * are read from this package's own dependencies by path: bundlers (the back office's preview)
 * cannot follow a dynamic require.resolve. The turbopackIgnore comments keep the bundler out.
 */
function font(pkg: string, file: string): string {
  const path = join(
    /*turbopackIgnore: true*/ findRepoRoot(),
    'packages/documents/node_modules',
    pkg,
    'files',
    file,
  );
  return readFileSync(/*turbopackIgnore: true*/ path).toString('base64');
}

let fontCss: string | undefined;
function fonts(): string {
  fontCss ??= [
    [
      'Noto Sans Arabic',
      '@fontsource/noto-sans-arabic',
      'noto-sans-arabic-arabic-400-normal.woff2',
      400,
    ],
    [
      'Noto Sans Arabic',
      '@fontsource/noto-sans-arabic',
      'noto-sans-arabic-arabic-700-normal.woff2',
      700,
    ],
    ['Noto Sans', '@fontsource/noto-sans', 'noto-sans-latin-400-normal.woff2', 400],
    ['Noto Sans', '@fontsource/noto-sans', 'noto-sans-latin-700-normal.woff2', 700],
  ]
    .map(
      ([family, pkg, file, weight]) =>
        `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${font(String(pkg), String(file))}) format('woff2');}`,
    )
    .join('\n');
  return fontCss;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML. Every value from the database goes through it. */
export function e(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Left-to-right island inside Arabic text (references, codes, phone numbers). */
export function ltr(value: unknown): string {
  return `<bdi dir="ltr">${e(value)}</bdi>`;
}

/** A {ar, en} value from the database, escaped; both, stacked, in a bilingual document. */
export function loc(value: { ar?: string | null; en?: string | null }, locale: DocLocale): string {
  const ar = value.ar ?? '';
  const en = value.en ?? '';
  if (locale !== 'both') return e((locale === 'ar' ? ar : en) || ar || en);
  if (!ar || !en || ar === en) return e(ar || en);
  return `<span class="bi">${e(ar)}<span class="en" dir="ltr">${e(en)}</span></span>`;
}

/** List items in the document's language; a bilingual document pairs them by position. */
export function locList(lists: { ar?: string[]; en?: string[] }, locale: DocLocale): string[] {
  const ar = lists.ar ?? [];
  const en = lists.en ?? [];
  if (locale !== 'both')
    return (
      (locale === 'ar' ? ar : en).length ? (locale === 'ar' ? ar : en) : ar.length ? ar : en
    ).map(e);
  const n = Math.max(ar.length, en.length);
  return Array.from({ length: n }, (_, i) => loc({ ar: ar[i], en: en[i] }, 'both'));
}

function contactStrip(brand: DocumentBrand, locale: DocLocale): string {
  const t = translator(locale === 'both' ? 'en' : locale);
  const c = brand.contact;
  const parts = [
    c.phone && `${t('tel')} ${ltr(c.phone)}`,
    c.whatsapp && `${t('whatsapp')} ${ltr(c.whatsapp)}`,
    c.email && ltr(c.email),
    c.website && ltr(c.website.replace(/^https?:\/\//, '')),
  ].filter(Boolean);
  const address = loc(c.address, locale);
  if (!parts.length && !address) return '';
  return `<div class="contact"><span class="contact-name">${e(brand.name)}</span>${address ? `<span>${address}</span>` : ''}${parts
    .map((part) => `<span>${part}</span>`)
    .join('')}</div>`;
}

/**
 * The page every document shares: the company's logo and name, the document title, its colours
 * and, at the end, its contact details. `title` is plain text (the PDF title); `heading` may be
 * HTML (bilingual).
 */
export function page(options: {
  locale: DocLocale;
  brand: DocumentBrand;
  title: string;
  heading?: string;
  subtitle?: string;
  body: string;
  landscape?: boolean;
  /** No page header or contact strip (each part carries its own, like registration cards). */
  bare?: boolean;
}): string {
  const { locale, brand } = options;
  const c = brandPalette(brand.primary, brand.secondary);
  const rtl = locale !== 'en';
  return `<!doctype html>
<html lang="${locale === 'en' ? 'en' : 'ar'}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${e(options.title)}</title>
<style>
${fonts()}
:root {
  --brand: ${c.primary}; --brand-text: ${c.primaryText}; --brand-ink: ${c.primaryInk};
  --brand-tint: ${c.primaryTint}; --brand-line: ${c.primaryLine};
  --accent: ${c.secondary}; --accent-text: ${c.secondaryText}; --accent-tint: ${c.secondaryTint};
  --ink: #1c2430; --muted: #5b6573; --rule: #e3e7ec;
}
@page { size: A4 ${options.landscape ? 'landscape' : 'portrait'}; margin: 12mm 12mm 14mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: ${rtl ? "'Noto Sans Arabic', 'Noto Sans'" : "'Noto Sans', 'Noto Sans Arabic'"}, sans-serif; font-size: 10pt; color: var(--ink); line-height: 1.5; }
.sheet { background: #fff; }
/* On screen (previews, PNG) the sheet carries the page margins print gives it. */
@media screen { .sheet { padding: 12mm 12mm 14mm; } }
.doc-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding-bottom: 10px; }
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand .logo { max-height: 15mm; max-width: 45mm; object-fit: contain; }
.brand .name { font-size: 14pt; font-weight: 700; color: var(--brand-text); line-height: 1.2; }
.doc-title { text-align: end; }
.doc-title .title { font-size: 15pt; font-weight: 700; color: var(--ink); line-height: 1.25; }
.doc-title .subtitle { font-size: 9.5pt; color: var(--muted); margin-top: 2px; }
.rule { height: 4px; border-radius: 2px; background: linear-gradient(to ${rtl ? 'left' : 'right'}, var(--brand) 0 72%, var(--accent) 72% 100%); margin-bottom: 14px; }
h2 { font-size: 11pt; margin: 18px 0 8px; padding-inline-start: 8px; border-inline-start: 4px solid var(--accent); line-height: 1.3; color: var(--brand-text); break-after: avoid; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 6px 7px; text-align: start; vertical-align: top; border-bottom: 1px solid var(--rule); }
thead th { font-size: 8.5pt; color: var(--brand-text); font-weight: 700; background: var(--brand-tint); border-bottom: 1.5px solid var(--brand-line); }
tbody tr:nth-child(even) td { background: #fafbfc; }
.facts { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
.facts .kv { display: flex; gap: 10px; padding: 7px 10px; border-bottom: 1px solid var(--rule); }
.facts .kv:nth-child(odd) { border-inline-end: 1px solid var(--rule); }
.facts .kv:nth-last-child(-n+2) { border-bottom: 0; }
.kv .k { color: var(--muted); min-width: 34%; font-size: 9pt; }
.kv .v { font-weight: 700; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; }
.num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }
.note { border-inline-start: 4px solid var(--accent); background: var(--accent-tint); padding: 8px 12px; border-radius: 6px; margin: 12px 0; }
.note.alert { border-color: #c2410c; background: #fff4ec; }
.muted { color: var(--muted); }
.total td { font-weight: 700; border-top: 2px solid var(--brand); background: var(--brand-tint) !important; }
ul.list { margin: 4px 0; padding-inline-start: 18px; }
ul.list li::marker { color: var(--accent); }
tr { break-inside: avoid; }
.bi { display: inline-flex; flex-direction: column; line-height: 1.25; }
.bi .en { font-family: 'Noto Sans', sans-serif; font-size: 0.82em; font-weight: 400; color: var(--muted); }
.meta { margin-top: 14px; font-size: 8.5pt; color: var(--muted); }
.contact { margin-top: 18px; padding-top: 8px; border-top: 2px solid var(--brand); display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 8.5pt; color: var(--muted); break-inside: avoid; }
.contact .contact-name { font-weight: 700; color: var(--brand-text); }
</style>
</head>
<body>
<div class="sheet">
${
  options.bare
    ? ''
    : `<header class="doc-head">
  <div class="brand">
    ${brand.logo ? `<img class="logo" src="${e(brand.logo)}" alt="">` : ''}
    <div class="name">${e(brand.name)}</div>
  </div>
  <div class="doc-title">
    <div class="title">${options.heading ?? e(options.title)}</div>
    ${options.subtitle ? `<div class="subtitle">${options.subtitle}</div>` : ''}
  </div>
</header>
<div class="rule"></div>`
}
${options.body}
${options.bare ? '' : contactStrip(brand, locale)}
</div>
</body>
</html>`;
}
