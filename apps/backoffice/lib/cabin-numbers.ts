/**
 * Cabin numbers as typed by staff: single numbers and ranges, separated by commas or spaces.
 * "101-104, 201" → 101 102 103 104 201. A letter prefix and leading zeros are kept:
 * "A01-A03" → A01 A02 A03.
 */
export function parseCabinNumbers(
  text: string,
): { numbers: string[] } | { error: 'empty' | 'invalid' | 'tooMany' | 'repeat'; part?: string } {
  const parts = text
    .split(/[,،\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { error: 'empty' };
  const numbers: string[] = [];
  for (const part of parts) {
    const range = /^([A-Za-z]*)(\d+)-([A-Za-z]*)(\d+)$/.exec(part);
    if (range) {
      const [, prefix, start, prefix2, end] = range as unknown as [
        string,
        string,
        string,
        string,
        string,
      ];
      const from = Number(start);
      const to = Number(end);
      if ((prefix2 && prefix2 !== prefix) || to < from || to - from >= 200)
        return { error: 'invalid', part };
      for (let n = from; n <= to; n += 1)
        numbers.push(prefix + String(n).padStart(start.length, '0'));
    } else if (/^[A-Za-z0-9]{1,16}$/.test(part)) {
      numbers.push(part);
    } else {
      return { error: 'invalid', part };
    }
    if (numbers.length > 200) return { error: 'tooMany' };
  }
  const seen = new Set<string>();
  for (const n of numbers) {
    if (seen.has(n)) return { error: 'repeat', part: n };
    seen.add(n);
  }
  return { numbers };
}
