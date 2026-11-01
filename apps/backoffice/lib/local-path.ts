/**
 * A `next` target from a link: a path on this site, or null. It is resolved the way a browser
 * resolves it, so anything that would leave the site ("//evil.com", "/\evil.com", "/<tab>/evil.com")
 * is refused rather than pattern-matched; only the path, query and hash are kept.
 */
export function localPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/')) return null;
  const base = 'https://site.invalid';
  try {
    const url = new URL(next, base);
    if (url.origin !== base) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
