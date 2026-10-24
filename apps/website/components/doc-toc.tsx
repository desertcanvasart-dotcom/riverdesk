'use client';

import { useEffect, useState } from 'react';

/** "On this page": follows the reader, highlighting the heading in view. */
export function DocToc({
  title,
  headings,
}: {
  title: string;
  headings: { id: string; text: string; depth: number }[];
}) {
  const [active, setActive] = useState(headings[0]?.id);
  useEffect(() => {
    const els = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => el !== null);
    const onScroll = () => {
      let current = els[0]?.id;
      for (const el of els) if (el.getBoundingClientRect().top < 140) current = el.id;
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [headings]);
  return (
    <div className="text-sm">
      <p className="mb-3 text-xs font-semibold tracking-wider text-muted uppercase">{title}</p>
      <ul className="flex flex-col border-s border-line">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={`-ms-px block border-s-2 py-1 leading-snug transition-colors ${
                h.depth === 3 ? 'ps-6 text-[0.8rem]' : 'ps-3'
              } ${
                active === h.id
                  ? 'border-brand font-medium text-brand'
                  : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
