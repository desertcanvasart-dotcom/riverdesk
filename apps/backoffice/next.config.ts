import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@vs/contracts', '@vs/shared', '@vs/engine', '@vs/db'],
  serverExternalPackages: ['pg', 'pino'],
  poweredByHeader: false,
};

export default config;
