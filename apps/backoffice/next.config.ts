import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@vs/contracts', '@vs/shared', '@vs/engine', '@vs/db', '@vs/documents'],
  serverExternalPackages: ['pg', 'pino'],
  poweredByHeader: false,
};

export default withNextIntl(config);
