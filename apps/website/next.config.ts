import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/**
 * The public website: static pages and docs, no login. Its only server code is the /pilot form,
 * which stores requests through the vs_website database role.
 */
const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@vs/shared'],
  serverExternalPackages: ['pg', 'pino', 'nodemailer'],
  poweredByHeader: false,
};

export default withNextIntl(config);
