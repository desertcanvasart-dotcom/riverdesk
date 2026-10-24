import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/** The public website: static pages and docs, no database and no login. */
const config: NextConfig = {
  poweredByHeader: false,
};

export default withNextIntl(config);
