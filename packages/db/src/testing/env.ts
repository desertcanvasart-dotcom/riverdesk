import pg from 'pg';
import { loadConfig, required, type Config } from '@vs/shared';

/** Tests only ever run against a local database. */
export function testConfig(): Config {
  const config = loadConfig();
  if (config.VS_ENV === 'hosted') throw new Error('Refusing to run tests with VS_ENV=hosted');
  const adminUrl = required(config, 'DATABASE_URL_ADMIN');
  const hosts = [new URL(adminUrl).hostname, config.DATABASE_HOST];
  for (const host of hosts) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error(`Refusing to run tests against non-local database host ${host}`);
    }
  }
  return config;
}

let ownerPool: pg.Pool | undefined;

/**
 * A pool acting as vs_owner (admin user + SET ROLE). Used only for fixtures, time travel and
 * whole-database assertions — never for the behaviour under test (rule: tests act as the
 * runtime roles).
 */
export function owner(): pg.Pool {
  if (!ownerPool) {
    const config = testConfig();
    ownerPool = new pg.Pool({
      connectionString: required(config, 'DATABASE_URL_ADMIN'),
      max: 4,
      onConnect: async (client) => {
        await client.query('set role vs_owner');
      },
    });
    ownerPool.on('error', () => {});
  }
  return ownerPool;
}

export async function closeOwner(): Promise<void> {
  const pool = ownerPool;
  ownerPool = undefined;
  await pool?.end();
}

const PASSWORD_KEY = {
  vs_backoffice: 'VS_BACKOFFICE_PASSWORD',
  vs_api: 'VS_API_PASSWORD',
  vs_worker: 'VS_WORKER_PASSWORD',
  vs_website: 'VS_WEBSITE_PASSWORD',
} as const;

/** A raw client logged in as a runtime role, for statements the harness must control exactly. */
export async function roleClient(role: keyof typeof PASSWORD_KEY): Promise<pg.Client> {
  const config = testConfig();
  const client = new pg.Client({
    host: config.DATABASE_HOST,
    port: config.DATABASE_PORT,
    database: config.DATABASE_NAME,
    user: role,
    password: required(config, PASSWORD_KEY[role]),
  });
  await client.connect();
  return client;
}
