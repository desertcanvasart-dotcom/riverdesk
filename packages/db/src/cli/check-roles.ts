import pg from 'pg';
import { loadConfig, roleConnection, type RuntimeRole } from '@vs/shared';

/**
 * Read-only check that each runtime role can log in where it will run (transaction port for
 * back office and API, session port for the worker) and that RLS applies to it: not the owner,
 * no BYPASSRLS, and no rows visible without a tenant. Prints no secrets. Exit code 1 on failure.
 */
const config = loadConfig();
const checks: { role: RuntimeRole; session: boolean }[] = [
  { role: 'vs_backoffice', session: false },
  { role: 'vs_api', session: false },
  { role: 'vs_worker', session: false },
  { role: 'vs_worker', session: true },
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
      visible: number;
      owner_member: boolean;
    }>(`
      select current_user as who,
             r.rolbypassrls as bypass,
             r.rolsuper as superuser,
             pg_has_role(current_user, 'vs_owner', 'MEMBER') as owner_member,
             (select count(*)::int from vs.operator) as visible
      from pg_roles r where r.rolname = current_user`);
    const row = rows[0]!;
    const problems = [
      row.who !== role && `connected as ${row.who}`,
      row.bypass && 'has BYPASSRLS',
      row.superuser && 'is superuser',
      row.owner_member && 'is a member of vs_owner',
      row.visible !== 0 && `sees ${row.visible} operator rows without a tenant`,
    ].filter(Boolean);
    if (problems.length) {
      failed = true;
      console.log(`FAIL ${label}: ${problems.join(', ')}`);
    } else {
      console.log(`ok   ${label}: logged in, RLS applies, no rows without a tenant`);
    }
  } catch (error) {
    failed = true;
    console.log(`FAIL ${label}: ${(error as Error).message}`);
  } finally {
    await client.end().catch(() => {});
  }
}
process.exit(failed ? 1 : 0);
