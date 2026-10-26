/**
 * Brand colours (#rrggbb, lower case). A company may pick any colour; these helpers derive the
 * shades a document needs and darken a colour used for text until it reads well on white
 * (WCAG contrast 4.5:1), so no choice can make a document hard to read.
 */

export const HEX_COLOR = /^#[0-9a-f]{6}$/;

export const DEFAULT_BRAND = { primary: '#165a5c', secondary: '#c58b3c' } as const;

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  if (!HEX_COLOR.test(hex)) throw new Error(`Not a #rrggbb colour: ${hex}`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Accepts "#ABC", "abc123", " #AbC123 " and returns "#abc123", or null. */
export function normalizeHex(value: string): string | null {
  let v = value.trim().toLowerCase().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/.test(v)) v = [...v].map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/.test(v) ? `#${v}` : null;
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mixes `color` with `other`; amount 0 = color, 1 = other. */
export function mix(color: string, other: string, amount: number): string {
  const a = rgb(color);
  const b = rgb(other);
  return hex(a.map((c, i) => c + (b[i]! - c) * amount) as Rgb);
}

/** The colour itself, or darker, until text in it reads on `background` (default white). */
export function readableOn(color: string, background = '#ffffff', minimum = 4.5): string {
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(color, '#000000', step / 20);
    if (contrast(candidate, background) >= minimum) return candidate;
  }
  return '#000000';
}

/** White or near-black, whichever reads better on a filled `background`. */
export function inkOn(background: string): string {
  return contrast('#ffffff', background) >= contrast('#1c2430', background) ? '#ffffff' : '#1c2430';
}

/** Every shade a document uses, from the company's two colours. */
export function brandPalette(primary: string, secondary: string) {
  return {
    primary,
    primaryText: readableOn(primary),
    primaryInk: inkOn(primary),
    primaryTint: mix(primary, '#ffffff', 0.9),
    primaryLine: mix(primary, '#ffffff', 0.75),
    secondary,
    secondaryText: readableOn(secondary),
    secondaryTint: mix(secondary, '#ffffff', 0.85),
  };
}
