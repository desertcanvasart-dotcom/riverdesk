import { isIP } from 'node:net';

/** Token requests per client address per minute: plenty for a channel, little for a flood. */
export const TOKEN_REQUESTS_PER_MINUTE = 30;

const WINDOW_MS = 60_000;
/** Addresses remembered at once. Past it the table is emptied: the limiter forgets, it never grows. */
const MAX_ADDRESSES = 20_000;

function privateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  );
}

/** The first four groups of an IPv6 address, written out in full. */
function v6Network(ip: string): string[] {
  const [head = '', tail] = ip.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'),
          ...right,
        ];
  return groups.slice(0, 4).map((g) => g.toLowerCase().padStart(4, '0'));
}

/**
 * What a client address is counted under, or null when it is not counted.
 *  - IPv6 is counted by its /64: one subscriber has that many addresses to rotate through.
 *  - A private or loopback address is not counted. Behind the edge every caller has a public
 *    address; a private one means a proxy hop we did not expect is being read as the client,
 *    and counting it would lock every channel out together.
 */
export function addressKey(address: string): string | null {
  const ip =
    address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  if (isIP(ip) === 4) return privateV4(ip) ? null : ip;
  if (isIP(ip) !== 6) return null;
  const network = v6Network(ip);
  const first = network[0]!;
  if (ip === '::1' || /^f[cd]/.test(first) || /^fe[89ab]/.test(first)) return null;
  return `${network.join(':')}::/64`;
}

/**
 * A fixed one-minute window per address, in memory (one API instance; a restart forgets it).
 * The token endpoint checks secrets in the database, so a flood of guesses is load, not access:
 * secrets are 32 random bytes.
 */
export function tokenLimiter(limit: number) {
  const windows = new Map<string, { start: number; count: number }>();
  let swept = 0;
  return (address: string, now = Date.now()) => {
    const key = addressKey(address);
    if (key === null) return { allowed: true, retryAfter: 0 };
    // Finished windows are dropped at most every ten seconds, not on every request.
    if (now - swept >= 10_000) {
      swept = now;
      for (const [k, w] of windows) if (now - w.start >= WINDOW_MS) windows.delete(k);
    }
    if (windows.size >= MAX_ADDRESSES && !windows.has(key)) windows.clear();
    const current = windows.get(key);
    const window = current && now - current.start < WINDOW_MS ? current : { start: now, count: 0 };
    window.count += 1;
    windows.set(key, window);
    return {
      allowed: window.count <= limit,
      retryAfter: Math.max(1, Math.ceil((window.start + WINDOW_MS - now) / 1000)),
    };
  };
}
