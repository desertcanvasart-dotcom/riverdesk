import pg from 'pg';
import { loadConfig, roleConnection, type RuntimeRole } from '@vs/shared';

/**
 * Read-only check that each runtime role can log in where it will run (transaction port for
 * back office and API, session port for the worker) and that RLS applies to it: not the owner,
 * no BYPASSRLS, and no rows visible without a tenant (the website role: no table rights at all).
 * Prints no secrets. Exit code 1 on failure.
 */
const config = loadConfig();
const checks: { role: RuntimeRole; session: boolean }[] = [
  { role: 'vs_backoffice', session: false },
  { role: 'vs_api', session: false },
  { role: 'vs_worker', session: false },
  { role: 'vs_worker', session: true },
  { role: 'vs_website', session: false },
];

let failed = false;
for (const { role, session } of checks) {
  const connection = roleConnection(config, role, { session });
  const client = new pg.Client({
    ...connection,
    ssl: connection.ssl ? { rejectUnauthorized: false } : false,
  });
  const label = `${role} via port ${connection.port}`;
  try {
    await client.connect();
    const { rows } = await client.query<{
      who: string;
      bypass: boolean;
      superuser: boolean;
      can_read: boolean;
      owner_member: boolean;
    }>(`
      select current_user as who,
             r.rolbypassrls as bypass,
             r.rolsuper as superuser,
             pg_has_role(current_user, 'vs_owner', 'MEMBER') as owner_member,
             has_table_privilege(current_user, 'vs.operator', 'SELECT') as can_read
      from pg_roles r where r.rolname = current_user`);
    const row = rows[0]!;
    const visible = row.can_read
      ? (await client.query<{ n: number }>('select count(*)::int as n from vs.operator')).rows[0]!.n
      : null;
    const problems = [
      row.who !== role && `connected as ${row.who}`,
      row.bypass && 'has BYPASSRLS',
      row.superuser && 'is superuser',
      row.owner_member && 'is a member of vs_owner',
      // The website has no table rights at all; the others must see nothing without a tenant.
      role === 'vs_website'
        ? row.can_read && 'can read vs.operator'
        : visible !== 0 && `sees ${visible} operator rows without a tenant`,
    ].filter(Boolean);
    if (problems.length) {
      failed = true;
      console.log(`FAIL ${label}: ${problems.join(', ')}`);
    } else {
      console.log(
        `ok   ${label}: logged in, ${role === 'vs_website' ? 'no table rights' : 'RLS applies, no rows without a tenant'}`,
      );
    }
  } catch (error) {
    failed = true;
    console.log(`FAIL ${label}: ${(error as Error).message}`);
  } finally {
    await client.end().catch(() => {});
  }
}
process.exit(failed ? 1 : 0);
