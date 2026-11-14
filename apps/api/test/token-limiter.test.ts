import { describe, expect, it } from 'vitest';
import { addressKey, tokenLimiter } from '../src/token-limiter';

describe('token request limiter', () => {
  it('counts a public IPv4 address as itself and IPv6 by its /64', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:0db8:0001:0002::/64');
    expect(addressKey('2001:db8:1:2::1')).toBe(addressKey('2001:DB8:1:2:ffff::9'));
    expect(addressKey('2001:db8::1')).toBe('2001:0db8:0000:0000::/64');
  });

  it('does not count private, loopback or unreadable addresses', () => {
    for (const address of [
      '10.1.2.3',
      '127.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.9',
      '169.254.1.1',
      '::ffff:10.0.0.1',
      '::1',
      'fd12:3456::1',
      'fe80::1',
      'not-an-address',
      '',
    ])
      expect(addressKey(address), address).toBeNull();
    expect(addressKey('172.32.0.1')).toBe('172.32.0.1');
  });

  it('allows the limit per minute per address, then says how long to wait', () => {
    const ask = tokenLimiter(2);
    const t = 1_000_000;
    expect(ask('203.0.113.7', t).allowed).toBe(true);
    expect(ask('203.0.113.7', t + 1_000).allowed).toBe(true);
    expect(ask('203.0.113.7', t + 2_000)).toEqual({ allowed: false, retryAfter: 58 });
    expect(ask('198.51.100.9', t + 2_000).allowed).toBe(true);
    // One /64 is one caller.
    expect(ask('2001:db8:1:2::1', t).allowed).toBe(true);
    expect(ask('2001:db8:1:2::2', t).allowed).toBe(true);
    expect(ask('2001:db8:1:2::3', t).allowed).toBe(false);
    // A new minute starts again; a private address is never refused.
    expect(ask('203.0.113.7', t + 61_000).allowed).toBe(true);
    for (let i = 0; i < 10; i += 1) expect(ask('10.0.0.5', t).allowed).toBe(true);
  });

  it('never remembers more than its cap: a flood of addresses empties the table', () => {
    const ask = tokenLimiter(1);
    const t = 1_000_000;
    expect(ask('203.0.113.7', t).allowed).toBe(true);
    expect(ask('203.0.113.7', t).allowed).toBe(false);
    for (let i = 0; i < 20_000; i += 1)
      ask(`11.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, t);
    // Forgotten with the rest: allowed again rather than the table growing without end.
    expect(ask('203.0.113.7', t).allowed).toBe(true);
  });
});
