import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Locale } from './i18n';

const require = createRequire(import.meta.url);

/** Fonts are embedded, so a document looks the same on any server (Arabic shaping included). */
function font(pkg: string, file: string): string {
  const path = require.resolve(`${pkg}/files/${file}`);
  return readFileSync(path).toString('base64');
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

export function page(options: {
  locale: Locale;
  title: string;
  operator: string;
  subtitle?: string;
  body: string;
  landscape?: boolean;
}): string {
  const { locale } = options;
  return `<!doctype html>
<html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${e(options.title)}</title>
<style>
${fonts()}
@page { size: A4 ${options.landscape ? 'landscape' : 'portrait'}; margin: 14mm 12mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: 'Noto Sans Arabic', 'Noto Sans', sans-serif; font-size: 10.5pt; color: #1c2430; line-height: 1.5; }
header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #165a5c; padding-bottom: 8px; margin-bottom: 14px; }
header .operator { font-size: 15pt; font-weight: 700; color: #165a5c; }
header .title { font-size: 12pt; font-weight: 700; text-align: end; }
header .subtitle { font-size: 9.5pt; color: #5b6573; text-align: end; }
h2 { font-size: 11pt; margin: 16px 0 6px; color: #165a5c; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 5px 6px; text-align: start; vertical-align: top; border-bottom: 1px solid #dfe3e8; }
th { font-size: 9pt; color: #5b6573; font-weight: 700; background: #f3f6f7; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; }
.kv { display: flex; gap: 8px; }
.kv .k { color: #5b6573; min-width: 34%; }
.kv .v { font-weight: 700; }
.num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }
.note { border: 1px solid #e7c873; background: #fff8e6; padding: 8px 10px; border-radius: 6px; margin: 10px 0; }
.muted { color: #5b6573; }
.total td { font-weight: 700; border-top: 2px solid #1c2430; }
ul.list { margin: 4px 0; padding-inline-start: 18px; }
tr { break-inside: avoid; }
footer { margin-top: 18px; font-size: 8.5pt; color: #5b6573; border-top: 1px solid #dfe3e8; padding-top: 6px; }
.sheet { padding: 4px; background: #fff; }
</style>
</head>
<body>
<div class="sheet">
<header>
  <div class="operator">${e(options.operator)}</div>
  <div>
    <div class="title">${e(options.title)}</div>
    ${options.subtitle ? `<div class="subtitle">${options.subtitle}</div>` : ''}
  </div>
</header>
${options.body}
</div>
</body>
</html>`;
}
