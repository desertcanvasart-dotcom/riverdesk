import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations as runGraphileMigrations } from 'graphile-worker';
import { bootstrap, OWNER_ROLE, RUNTIME_ROLES, type RuntimeRoleName } from './bootstrap';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const LOCK_KEY = 7_302_026; // advisory lock: one migration run at a time

export interface MigrateOptions {
  adminUrl: string;
  ssl?: boolean;
  passwords: Record<RuntimeRoleName, string>;
  log?: (message: string) => void;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export function listMigrations(dir = MIGRATIONS_DIR): { name: string; sql: string }[] {
  return readdirSync(dir)
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

/**
 * Applies bootstrap, then every pending SQL file in order (each in its own transaction, as
 * vs_owner), then Graphile Worker's own migrations. A changed, already-applied file fails.
 */
export async function migrate(options: MigrateOptions): Promise<string[]> {
  const log = options.log ?? (() => {});
  const ssl = options.ssl ? { rejectUnauthorized: false } : undefined;
  const client = new pg.Client({ connectionString: options.adminUrl, ssl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await bootstrap(client, options.passwords);

    const done = new Map(
      (
        await client.query<{ name: string; checksum: string }>(
          'select name, checksum from vs_migrations.schema_migration',
        )
      ).rows.map((row) => [row.name, row.checksum]),
    );
    for (const migration of listMigrations()) {
      const sum = checksum(migration.sql);
      const previous = done.get(migration.name);
      if (previous) {
        if (previous !== sum) {
          throw new Error(`Migration ${migration.name} changed after it was applied`);
        }
        continue;
      }
      log(`applying ${migration.name}`);
      await client.query('begin');
      try {
        await client.query(`set local role ${OWNER_ROLE}`);
        await client.query(migration.sql);
        await client.query('reset role');
        await client.query(
          'insert into vs_migrations.schema_migration (name, checksum) values ($1, $2)',
          [migration.name, sum],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(`Migration ${migration.name} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      applied.push(migration.name);
    }

    await installGraphileWorker(options.adminUrl, ssl);
    log('graphile_worker schema up to date');
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return applied;
}

/** Graphile Worker installs its own schema; it runs as vs_owner, and only vs_worker gets rights. */
async function installGraphileWorker(adminUrl: string, ssl: pg.ConnectionConfig['ssl']) {
  const pool = new pg.Pool({
    connectionString: adminUrl,
    ssl,
    max: 1,
    onConnect: async (connection) => {
      await connection.query(`set role ${OWNER_ROLE}`);
    },
  });
  pool.on('error', () => {});
  pool.on('connect', (connection) => connection.on('error', () => {}));
  try {
    await runGraphileMigrations({ pgPool: pool });
    // Graphile Worker enables RLS (with no policies) on its private tables, so only their owner
    // could use them. vs_worker gets an explicit policy; these tables hold jobs, not tenant rows.
    const { rows: rlsTables } = await pool.query<{ name: string }>(`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'graphile_worker' and c.relkind = 'r' and c.relrowsecurity
    `);
    for (const { name } of rlsTables) {
      const table = `graphile_worker."${name.replace(/"/g, '""')}"`;
      await pool.query(`drop policy if exists vs_worker_queue on ${table}`);
      await pool.query(
        `create policy vs_worker_queue on ${table} for all to vs_worker using (true) with check (true)`,
      );
    }
    await pool.query(`
      grant usage on schema graphile_worker to vs_worker;
      grant select, insert, update, delete on all tables in schema graphile_worker to vs_worker;
      grant usage, select on all sequences in schema graphile_worker to vs_worker;
      grant execute on all functions in schema graphile_worker to vs_worker;
      revoke all on all tables in schema graphile_worker from ${RUNTIME_ROLES.filter((r) => r !== 'vs_worker').join(', ')};
    `);
  } finally {
    await pool.end();
  }
}
