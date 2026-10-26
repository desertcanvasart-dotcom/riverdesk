import { loadConfig, required } from '@vs/shared';

export function adminOptions() {
  const config = loadConfig();
  return {
    config,
    adminUrl: required(config, 'DATABASE_URL_ADMIN'),
    ssl: config.DATABASE_SSL,
    passwords: {
      vs_backoffice: required(config, 'VS_BACKOFFICE_PASSWORD'),
      vs_api: required(config, 'VS_API_PASSWORD'),
      vs_worker: required(config, 'VS_WORKER_PASSWORD'),
      vs_website: required(config, 'VS_WEBSITE_PASSWORD'),
    },
  };
}

/** Destructive scripts (reset, seed) refuse to run against anything but a local database. */
export function assertLocal(adminUrl: string): void {
  const host = new URL(adminUrl).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`Refusing to run against non-local database host ${host}`);
  }
}
