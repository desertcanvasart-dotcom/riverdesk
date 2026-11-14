import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/**
 * Sent with every page: no framing by other sites (clickjacking), no MIME sniffing, forms and
 * base URLs only to this site, no plugins, and HTTPS remembered. Scripts are not restricted by
 * this policy (Next.js inline scripts would need per-request nonces).
 */
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@vs/contracts', '@vs/shared', '@vs/engine', '@vs/db', '@vs/documents'],
  serverExternalPackages: ['pg', 'pino'],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default withNextIntl(config);
