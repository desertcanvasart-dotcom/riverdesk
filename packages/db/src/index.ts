import pg from 'pg';
import {
  createDatabase,
  databaseTls,
  loadConfig,
  roleConnection,
  type Config,
  type Database,
  type Logger,
  type RuntimeRole,
} from '@vs/shared';
import type { DB } from './generated/types';

export type { DB } from './generated/types';
export * from './generated/types';
export {
  LOGIN_ROLES,
  OWNER_ROLE,
  RUNTIME_ROLES,
  WEBSITE_ROLE,
  type LoginRoleName,
  type RuntimeRoleName,
} from './bootstrap';

export type VsDatabase = Database<DB>;

/** Opens a pool for one runtime role, with Kysely queries qualified to schema `vs`. */
export function openDatabase(
  role: RuntimeRole,
  options: { config?: Config; logger?: Logger; session?: boolean; max?: number } = {},
): VsDatabase {
  const config = options.config ?? loadConfig();
  return createDatabase<DB>(
    {
      ...roleConnection(config, role, { session: options.session }),
      max: options.max ?? config.DATABASE_POOL_MAX,
    },
    { logger: options.logger, schema: 'vs' },
  );
}

/**
 * The job queue's own pool for Graphile Worker: vs_worker in session mode (LISTEN/NOTIFY), plain
 * pg (no custom type parsers), TLS verified like every other connection.
 */
export function openJobQueuePool(options: { config?: Config; max?: number } = {}): pg.Pool {
  const config = options.config ?? loadConfig();
  const connection = roleConnection(config, 'vs_worker', { session: true });
  return new pg.Pool({
    ...connection,
    ssl: databaseTls(connection.host, connection.ssl),
    max: options.max ?? 4,
  });
}
