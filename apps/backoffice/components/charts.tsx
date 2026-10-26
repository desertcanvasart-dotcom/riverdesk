'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from './ui';

/**
 * Small charts for Analytics, drawn as SVG with the app's own tokens. Thin marks, one axis, a
 * legend for two or more series, values in text colours (never the series colour), and a hover
 * or focus readout on every chart. Every figure is also in a table on the page.
 */

export interface LineSeries {
  name: string;
  /** A CSS colour, e.g. var(--color-chart-1). */
  color: string;
  points: { x: number; y: number; estimated?: boolean }[];
}

const W = 640;
const H = 236;
const PAD = { top: 12, right: 44, bottom: 42, left: 40 };

/** A clean, even top for the axis, so the middle tick is a whole number too. */
function niceMax(value: number) {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  const top = Math.ceil(value / step) * step;
  return top % 2 === 0 ? top : top + step;
}

/**
 * A line per series over a numeric x (here: days before embarkation, counting down to 0 on the
 * right). Crosshair snaps to the nearest x and lists every series there.
 */
export function LineChart({
  series,
  xLabel,
  format,
  formatX,
  empty,
}: {
  series: LineSeries[];
  xLabel: string;
  format: (n: number) => string;
  formatX: (x: number) => string;
  empty: ReactNode;
}) {
  const box = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const xs = useMemo(
    () => [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => b - a),
    [series],
  );
  if (xs.length === 0) return <div className="py-8 text-center text-sm text-muted">{empty}</div>;
  const xMax = Math.max(...xs, 1);
  const yMax = niceMax(Math.max(...series.flatMap((s) => s.points.map((p) => p.y)), 1));
  // Days before departure run right to left: the departure is the right edge.
  const sx = (x: number) => PAD.left + ((xMax - x) / xMax) * (W - PAD.left - PAD.right);
  const sy = (y: number) => PAD.top + (1 - y / yMax) * (H - PAD.top - PAD.bottom);
  const ticks = [0, yMax / 2, yMax];
  const at = (x: number) => series.map((s) => ({ s, p: s.points.find((p) => p.x === x) }));

  const onMove = (clientX: number) => {
    const rect = box.current!.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    let best = xs[0]!;
    for (const x of xs) if (Math.abs(sx(x) - px) < Math.abs(sx(best) - px)) best = x;
    setHover(best);
  };

  return (
    <div className="relative" dir="ltr">
      <svg
        ref={box}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none"
        role="img"
        aria-label={series.map((s) => s.name).join(', ')}
        tabIndex={0}
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          const i = hover === null ? xs.length - 1 : xs.indexOf(hover);
          if (e.key === 'ArrowLeft') setHover(xs[Math.max(0, i - 1)]!);
          if (e.key === 'ArrowRight') setHover(xs[Math.min(xs.length - 1, i + 1)]!);
        }}
        onBlur={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={sy(t)}
              y2={sy(t)}
              stroke="var(--color-line)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={sy(t) + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--color-muted)"
            >
              {format(t)}
            </text>
          </g>
        ))}
        <text
          x={(PAD.left + W - PAD.right) / 2}
          y={H - 4}
          textAnchor="middle"
          fontSize={11}
          fill="var(--color-muted)"
        >
          {xLabel}
        </text>
        {[xMax, Math.round(xMax / 2), 0].map((x) => (
          <text
            key={x}
            x={sx(x)}
            y={H - PAD.bottom + 14}
            textAnchor="middle"
            fontSize={11}
            fill="var(--color-muted)"
          >
            {formatX(x)}
          </text>
        ))}
        {series.map((s) => {
          const pts = [...s.points].sort((a, b) => b.x - a.x);
          if (pts.length === 0) return null;
          const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x)},${sy(p.y)}`).join(' ');
          const last = pts.at(-1)!;
          return (
            <g key={s.name}>
              <path
                d={d}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <circle
                cx={sx(last.x)}
                cy={sy(last.y)}
                r={4}
                fill={s.color}
                stroke="var(--color-surface)"
                strokeWidth={2}
              />
              <text
                x={sx(last.x) + 8}
                y={sy(last.y) + 4}
                fontSize={11}
                fontWeight={600}
                fill="var(--color-ink)"
              >
                {format(last.y)}
              </text>
            </g>
          );
        })}
        {hover !== null && (
          <g>
            <line
              x1={sx(hover)}
              x2={sx(hover)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="var(--color-muted)"
              strokeWidth={1}
            />
            {at(hover).map(({ s, p }) =>
              p ? (
                <circle
                  key={s.name}
                  cx={sx(hover)}
                  cy={sy(p.y)}
                  r={4}
                  fill={s.color}
                  stroke="var(--color-surface)"
                  strokeWidth={2}
                />
              ) : null,
            )}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-1 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-sm"
          style={{
            left: `${(sx(hover) / W) * 100}%`,
            transform: sx(hover) > W / 2 ? 'translateX(-105%)' : 'translateX(5%)',
          }}
        >
          <div className="mb-1 text-muted">{formatX(hover)}</div>
          {at(hover).map(({ s, p }) => (
            <div key={s.name} className="flex items-center gap-2">
              <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
              <span className="font-semibold">{p ? format(p.y) : '—'}</span>
              <span className="text-muted">
                {s.name}
                {p?.estimated ? ' *' : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap gap-4 text-xs text-muted" dir="auto">
          {series.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** One horizontal bar per row, a single series: share of 100%, value at the tip. */
export function ShareBars({
  rows,
  format,
}: {
  rows: { key: string; label: string; share: number; detail: string }[];
  format: (share: number) => string;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(6rem,10rem)_1fr] items-center gap-3">
          <span className="truncate text-sm" title={r.label}>
            {r.label}
          </span>
          <span className="flex items-center gap-2" title={r.detail}>
            <span className="h-3 flex-1 rounded-full bg-line/50">
              <span
                className="block h-3 rounded-full"
                style={{
                  width: `${Math.min(100, Math.max(0, r.share * 100))}%`,
                  background: 'var(--color-chart-1)',
                }}
              />
            </span>
            <span className="w-12 text-end text-sm font-semibold tabular-nums">
              {format(r.share)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A sailings × categories grid, one hue from light (empty) to dark (full). Each cell shows its
 * percentage and explains itself on hover or focus.
 */
export function HeatMap({
  rows,
  columns,
  cell,
  format,
}: {
  rows: { key: string; label: ReactNode }[];
  columns: { key: string; label: string; title: string }[];
  cell: (row: string, column: string) => { share: number | null; detail: string };
  format: (share: number) => string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0.5 text-xs">
        <thead>
          <tr>
            <th />
            {columns.map((c) => (
              <th key={c.key} title={c.title} className="px-1 pb-1 font-medium text-muted">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="pe-2 text-start font-normal whitespace-nowrap text-muted">
                {r.label}
              </th>
              {columns.map((c) => {
                const { share, detail } = cell(r.key, c.key);
                const pct = share === null ? null : Math.round(share * 100);
                const strong = pct !== null && pct >= 55;
                return (
                  <td
                    key={c.key}
                    tabIndex={0}
                    title={detail}
                    aria-label={detail}
                    className={cx(
                      'h-8 min-w-12 rounded text-center tabular-nums outline-offset-1 hover:outline focus:outline',
                      strong ? 'font-semibold text-chart-ink' : 'text-ink',
                    )}
                    style={{
                      background:
                        pct === null
                          ? 'transparent'
                          : `color-mix(in oklab, var(--color-chart-1) ${8 + Math.round(pct * 0.86)}%, var(--color-surface))`,
                    }}
                  >
                    {pct === null ? '—' : format(share!)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
