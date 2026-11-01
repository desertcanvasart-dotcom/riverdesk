import { BlockList, isIP } from 'node:net';

/**
 * Addresses an outgoing request to a customer's server must never reach on the hosted platform:
 * this machine, the private network and the cloud metadata service (webhook SSRF).
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  blocked.addSubnet(network, prefix, 'ipv6');

/**
 * True for an address on the public internet. IPv4-mapped IPv6 (::ffff:a.b.c.d) is checked as the
 * IPv4 address; BlockList itself would match every IPv4 address against a ::ffff:0:0/96 rule.
 */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !blocked.check(address, 'ipv4');
  if (version !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return !blocked.check(mapped[1]!, 'ipv4');
  return !blocked.check(address, 'ipv6');
}

/**
 * Why a webhook URL may not be used, or null. Hosted: https only, and not an address or name
 * that points inside (the name's DNS answer is checked again when sending). Locally anything
 * goes, so a receiver on 127.0.0.1 can be tested.
 */
export function webhookUrlProblem(url: string, hosted: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Not a valid URL';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'http(s) only';
  if (!hosted) return null;
  if (parsed.protocol !== 'https:') return 'Webhooks must use https';
  if (parsed.username || parsed.password) return 'No user name or password in the URL';
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) return isPublicAddress(host) ? null : 'Not a public address';
  if (
    !host.includes('.') ||
    host === 'localhost' ||
    /\.(localhost|local|internal|intranet|lan|home|corp)$/.test(host)
  )
    return 'Not a public host name';
  return null;
}
