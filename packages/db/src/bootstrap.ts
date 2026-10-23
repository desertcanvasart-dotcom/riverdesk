import type pg from 'pg';
import { scramVerifier } from './scram';

export const OWNER_ROLE = 'vs_owner';
export const RUNTIME_ROLES = ['vs_backoffice', 'vs_api', 'vs_worker'] as const;
export type RuntimeRoleName = (typeof RUNTIME_ROLES)[number];

/**
 * Cluster-level setup that must run as the admin user (postgres), not as vs_owner:
 * roles, role passwords and schemas. Idempotent.
 *
 * - vs_owner owns every table. It is NOLOGIN: nothing can connect as it; migrations run as the
 *   admin user with SET ROLE vs_owner.
 * - Runtime roles log in, are not owners, and have no BYPASSRLS, CREATEROLE or CREATEDB.
 */
export async function bootstrap(
  client: pg.ClientBase,
  passwords: Record<RuntimeRoleName, string>,
  canLogIn: (role: RuntimeRoleName, password: string) => Promise<boolean> = async () => false,
): Promise<void> {
  await client.query(`
    do $$
    begin
      if not exists (select from pg_roles where rolname = '${OWNER_ROLE}') then
        create role ${OWNER_ROLE} nologin;
      end if;
      ${RUNTIME_ROLES.map(
        (role) => `
      if not exists (select from pg_roles where rolname = '${role}') then
        create role ${role} login;
      end if;`,
      ).join('')}
    end
    $$;
  `);
  await client.query(`alter role ${OWNER_ROLE} nologin nobypassrls nocreaterole nocreatedb`);
  for (const role of RUNTIME_ROLES) {
    await client.query(`alter role ${role} login nobypassrls nocreaterole nocreatedb noinherit`);
    // Only set the password when the configured one does not work (new role, or rotated in the
    // env file). Re-setting it unchanged makes Supabase's pooler drop its cached credentials.
    if (await canLogIn(role, passwords[role])) continue;
    const verifier = client.escapeLiteral(scramVerifier(passwords[role]));
    await client.query(`alter role ${role} password ${verifier}`);
  }
  // Lets the admin user SET ROLE vs_owner for migrations without inheriting its rights.
  await client.query(`grant ${OWNER_ROLE} to current_user with inherit false, set true`);

  // Exclusion constraints (no overlapping legs per vessel, no overlapping cabin periods) need
  // btree_gist. Supabase keeps extensions in schema `extensions`.
  await client.query('create extension if not exists btree_gist with schema extensions');
  // Graphile Worker's own migrations run `create schema if not exists`, which needs CREATE.
  const { rows } = await client.query<{ db: string }>('select current_database() as db');
  await client.query(
    `grant create on database ${client.escapeIdentifier(rows[0]!.db)} to ${OWNER_ROLE}`,
  );
  await client.query(`create schema if not exists vs authorization ${OWNER_ROLE}`);
  await client.query(`create schema if not exists graphile_worker authorization ${OWNER_ROLE}`);
  // Schema grants must come from the owner: a GRANT by a non-owner is silently ignored.
  await client.query(`set role ${OWNER_ROLE}`);
  try {
    await client.query(`revoke all on schema vs from public`);
    await client.query(`revoke all on schema graphile_worker from public`);
    await client.query(`grant usage on schema vs to ${RUNTIME_ROLES.join(', ')}`);
  } finally {
    await client.query('reset role');
  }
  await client.query(`create schema if not exists vs_migrations`);
  await client.query(`revoke all on schema vs_migrations from public`);
  await client.query(`
    create table if not exists vs_migrations.schema_migration (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}
