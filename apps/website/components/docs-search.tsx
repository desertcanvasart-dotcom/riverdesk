'use client';

import { CornerDownLeft, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useRouter } from '../i18n/routing';

export interface SearchEntry {
  href: string;
  sectionLabel: string;
  title: string;
  summary: string;
  headings: string[];
}

/** Arabic and Latin both: lower case, no diacritics, alef and yaa forms folded. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ًͯ-ٰٟ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}

/** Search across every page's title, summary and headings; "/" focuses it from anywhere. */
export function DocsSearch({
  entries,
  large = false,
}: {
  entries: SearchEntry[];
  large?: boolean;
}) {
  const t = useTranslations('docs');
  const router = useRouter();
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(0);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === '/' && !/input|textarea|select/i.test(target.tagName)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const results = useMemo(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return entries
      .map((e) => {
        const title = fold(e.title);
        const rest = fold(`${e.summary} ${e.headings.join(' ')}`);
        if (!words.every((w) => title.includes(w) || rest.includes(w))) return null;
        const score = words.reduce((s, w) => s + (title.includes(w) ? 3 : 1), 0);
        const heading = e.headings.find((h) => words.some((w) => fold(h).includes(w)));
        return { ...e, score, heading };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }, [q, entries]);
  const open = focused && q.trim().length > 0;
  return (
    <div className="relative">
      <label
        className={`flex items-center gap-3 rounded-2xl border bg-surface transition-shadow ${
          large
            ? 'border-white/10 px-5 py-4 shadow-[var(--shadow-lift)]'
            : 'border-line px-3 py-2 shadow-[var(--shadow-card)]'
        } focus-within:ring-2 focus-within:ring-brand/40`}
      >
        <Search aria-hidden className={`shrink-0 text-muted ${large ? 'size-5' : 'size-4'}`} />
        <span className="sr-only">{t('searchLabel')}</span>
        <input
          ref={input}
          type="search"
          value={q}
          placeholder={t('searchPlaceholder')}
          onChange={(e) => {
            setQ(e.target.value);
            setPick(0);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setPick((p) => Math.min(p + 1, results.length - 1));
            else if (e.key === 'ArrowUp') setPick((p) => Math.max(p - 1, 0));
            else if (e.key === 'Enter' && results[pick]) router.push(results[pick].href);
            else if (e.key === 'Escape') setQ('');
            else return;
            e.preventDefault();
          }}
          className={`min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-muted ${
            large ? 'text-lg' : 'text-sm'
          }`}
        />
        <kbd className="hidden rounded-md border border-line px-1.5 text-xs text-muted sm:inline">
          /
        </kbd>
      </label>
      {open && (
        <div className="absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-line bg-surface text-ink shadow-[var(--shadow-lift)]">
          {results.length === 0 ? (
            <div className="p-4 text-sm">
              <p>{t('searchEmpty', { q: q.trim() })}</p>
              <p className="mt-1 text-muted">{t('searchHint')}</p>
            </div>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto p-1.5">
              {results.map((r, i) => (
                <li key={r.href}>
                  <Link
                    href={r.href}
                    onMouseEnter={() => setPick(i)}
                    className={`flex items-start gap-3 rounded-xl px-3 py-2.5 ${i === pick ? 'bg-brand-soft' : ''}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-muted">{r.sectionLabel}</span>
                      <span className="block font-medium">{r.title}</span>
                      <span className="block truncate text-sm text-muted">
                        {r.heading ? `# ${r.heading}` : r.summary}
                      </span>
                    </span>
                    {i === pick && (
                      <CornerDownLeft aria-hidden className="mt-5 size-4 shrink-0 text-brand" />
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
