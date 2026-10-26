import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pgErrorCode } from '@vs/shared';
import { LOGIN_ROLES, RUNTIME_ROLES, type LoginRoleName, type RuntimeRoleName } from '../bootstrap';
import { owner, roleClient } from './env';
import { TENANT_FIXTURES, type Fixture } from './fixtures';

/** Tables in schema vs that are deliberately not tenant-scoped. Empty: every table has a tenant. */
export const NON_TENANT_TABLES: readonly string[] = [];

/** The only SECURITY DEFINER functions allowed in schema vs, and the one role that may call each. */
export const SECURITY_DEFINER_ALLOWLIST: Record<string, LoginRoleName[]> = {
  list_operator_ids: ['vs_worker'],
  resolve_staff: ['vs_backoffice'],
  claim_staff_invitation: ['vs_backoffice'],
  resolve_api_client: ['vs_api'],
  enqueue_document: ['vs_backoffice'],
  platform_is_admin: ['vs_backoffice'],
  platform_companies: ['vs_backoffice'],
  platform_create_company: ['vs_backoffice'],
  platform_reinvite_owner: ['vs_backoffice'],
  submit_pilot_request: ['vs_website'],
};

export interface TenantTable {
  name: string;
  /** The column holding the tenant: `id` for vs.operator, `operator_id` everywhere else. */
  tenantColumn: string;
  hasId: boolean;
}

/** Every tenant table, discovered from the catalogue (not a hand-written list). */
export async function discoverTenantTables(): Promise<TenantTable[]> {
  const { rows } = await owner().query<{
    name: string;
    has_operator_id: boolean;
    has_id: boolean;
  }>(`
    select c.relname as name,
           exists (select from pg_attribute a where a.attrelid = c.oid and a.attname = 'operator_id' and not a.attisdropped) as has_operator_id,
           exists (select from pg_attribute a where a.attrelid = c.oid and a.attname = 'id' and not a.attisdropped) as has_id
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'vs' and c.relkind in ('r', 'p')
    order by c.relname
  `);
  return rows
    .filter((row) => row.name === 'operator' || row.has_operator_id)
    .map((row) => ({
      name: row.name,
      tenantColumn: row.name === 'operator' ? 'id' : 'operator_id',
      hasId: row.has_id,
    }));
}

/** Tables in schema vs that have no tenant column and are not on the allow-list. */
export async function findUnscopedTables(): Promise<string[]> {
  const { rows } = await owner().query<{ name: string }>(`
    select c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'vs' and c.relkind in ('r', 'p') and c.relname <> 'operator'
      and not exists (
        select from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'operator_id' and not a.attisdropped
      )
  `);
  return rows.map((row) => row.name).filter((name) => !NON_TENANT_TABLES.includes(name));
}

type Outcome =
  | { ok: true; rowCount: number; rows: Record<string, unknown>[] }
  | { ok: false; code: string | undefined; message: string };

/** Runs one statement as a role in a transaction that is always rolled back. */
async function attempt(
  client: pg.Client,
  operatorId: string | null,
  text: string,
  params: unknown[] = [],
): Promise<Outcome> {
  await client.query('begin');
  try {
    if (operatorId)
      await client.query(`select set_config('app.operator_id', $1, true)`, [operatorId]);
    const result = await client.query(text, params);
    return { ok: true, rowCount: result.rowCount ?? 0, rows: result.rows };
  } catch (error) {
    return { ok: false, code: pgErrorCode(error), message: (error as Error).message };
  } finally {
    await client.query('rollback');
  }
}

const denied = (outcome: Outcome) => !outcome.ok && outcome.code === '42501';
const describe = (outcome: Outcome) =>
  outcome.ok
    ? `succeeded (${outcome.rowCount} rows)`
    : `failed with ${outcome.code}: ${outcome.message}`;

export interface IsolationOptions {
  operatorA: string;
  operatorB: string;
  roles?: readonly RuntimeRoleName[];
  tables?: TenantTable[];
  fixtures?: Record<string, Fixture>;
}

/**
 * Proves, for every tenant table and every runtime role, that a transaction scoped to operator A
 * cannot read, update, delete or insert operator B's rows, cannot move its own rows to B, and
 * sees nothing without a tenant. Also checks RLS is enabled with a tenant policy, and that the
 * table is owned by vs_owner. Returns a list of failures (empty means isolated).
 *
 * Both operators must already have one fixture row in each table.
 */
export async function checkTenantIsolation(options: IsolationOptions): Promise<string[]> {
  const { operatorA, operatorB } = options;
  const roles = options.roles ?? RUNTIME_ROLES;
  const tables = options.tables ?? (await discoverTenantTables());
  const fixtures = options.fixtures ?? TENANT_FIXTURES;
  const failures: string[] = [];

  const structure = await owner().query<{
    name: string;
    rls: boolean;
    owner: string;
    policies: number;
    tenant_policies: number;
  }>(
    `select c.relname as name, c.relrowsecurity as rls, pg_get_userbyid(c.relowner) as owner,
            (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
            (select count(*)::int from pg_policy p where p.polrelid = c.oid
               and pg_get_expr(p.polqual, p.polrelid) like '%current_operator_id()%'
               and pg_get_expr(p.polwithcheck, p.polrelid) like '%current_operator_id()%') as tenant_policies
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'vs' and c.relname = any($1)`,
    [tables.map((table) => table.name)],
  );
  const byName = new Map(structure.rows.map((row) => [row.name, row]));

  for (const table of tables) {
    const info = byName.get(table.name);
    if (!info) {
      failures.push(`${table.name}: not found`);
      continue;
    }
    if (!fixtures[table.name])
      failures.push(`${table.name}: no fixture registered (add one to TENANT_FIXTURES)`);
    if (!info.rls) failures.push(`${table.name}: RLS is disabled`);
    if (info.tenant_policies === 0)
      failures.push(`${table.name}: no tenant policy on current_operator_id()`);
    if (info.policies !== info.tenant_policies)
      failures.push(`${table.name}: has a policy not keyed on the tenant`);
    if (info.owner !== 'vs_owner')
      failures.push(`${table.name}: owned by ${info.owner}, not vs_owner`);
  }

  for (const role of roles) {
    const client = await roleClient(role);
    try {
      for (const table of tables) {
        const t = `vs.${table.name}`;
        const col = table.tenantColumn;
        const where = `${role} on ${table.name}`;

        const ownerCounts = await owner().query<{ a: number; b: number }>(
          `select count(*) filter (where ${col} = $1)::int as a, count(*) filter (where ${col} = $2)::int as b from ${t}`,
          [operatorA, operatorB],
        );
        const { a: rowsA, b: rowsB } = ownerCounts.rows[0]!;
        if (rowsA === 0 || rowsB === 0) {
          failures.push(
            `${where}: needs a fixture row for both operators (A=${rowsA}, B=${rowsB})`,
          );
          continue;
        }

        const visible = await attempt(client, operatorA, `select ${col}::text as tenant from ${t}`);
        if (!visible.ok) {
          failures.push(`${where}: own-tenant select ${describe(visible)}`);
        } else {
          const foreign = visible.rows.filter((row) => row.tenant !== operatorA).length;
          if (foreign > 0) failures.push(`${where}: read ${foreign} row(s) of another operator`);
          if (visible.rows.length !== rowsA) {
            failures.push(`${where}: sees ${visible.rows.length} of its own ${rowsA} row(s)`);
          }
        }

        const untenanted = await attempt(client, null, `select count(*)::int as n from ${t}`);
        if (!untenanted.ok || untenanted.rows[0]?.n !== 0) {
          failures.push(
            `${where}: without app.operator_id the select ${untenanted.ok ? `returned ${String(untenanted.rows[0]?.n)} rows` : describe(untenanted)}`,
          );
        }

        const update = await attempt(
          client,
          operatorA,
          `update ${t} set ${col} = ${col} where ${col} = $1`,
          [operatorB],
        );
        if (update.ok && update.rowCount > 0)
          failures.push(`${where}: updated ${update.rowCount} row(s) of another operator`);
        if (!update.ok && !denied(update))
          failures.push(`${where}: cross-tenant update ${describe(update)}`);

        const remove = await attempt(client, operatorA, `delete from ${t} where ${col} = $1`, [
          operatorB,
        ]);
        if (remove.ok && remove.rowCount > 0)
          failures.push(`${where}: deleted ${remove.rowCount} row(s) of another operator`);
        if (!remove.ok && !denied(remove))
          failures.push(`${where}: cross-tenant delete ${describe(remove)}`);

        const sample = await owner().query<{ row: Record<string, unknown> }>(
          `select to_jsonb(x) as row from ${t} x where ${col} = $1 limit 1`,
          [operatorB],
        );
        const foreignRow = { ...sample.rows[0]!.row };
        if (table.hasId && table.name !== 'operator') foreignRow.id = randomUUID();
        if (table.name === 'operator') foreignRow.id = operatorB;
        const insert = await attempt(
          client,
          operatorA,
          `insert into ${t} select * from jsonb_populate_record(null::${t}, $1::jsonb)`,
          [JSON.stringify(foreignRow)],
        );
        if (!denied(insert))
          failures.push(`${where}: insert of another operator's row ${describe(insert)}`);

        const hijack = await attempt(
          client,
          operatorA,
          `update ${t} set ${col} = $2 where ${col} = $1`,
          [operatorA, operatorB],
        );
        if (!denied(hijack))
          failures.push(`${where}: moving own rows to another operator ${describe(hijack)}`);
      }
    } finally {
      await client.end();
    }
  }
  return failures;
}

/** Checks the runtime roles' attributes (rule 7) and the SECURITY DEFINER allow-list. */
export async function checkRolesAndDefiners(): Promise<string[]> {
  const failures: string[] = [];
  const roles = await owner().query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreaterole: boolean;
    owner_member: boolean;
    owns: number;
  }>(
    `select r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole,
            pg_has_role(r.rolname, 'vs_owner', 'MEMBER') as owner_member,
            (select count(*)::int from pg_class c where c.relowner = r.oid) as owns
     from pg_roles r where r.rolname = any($1)`,
    [[...LOGIN_ROLES]],
  );
  if (roles.rows.length !== LOGIN_ROLES.length) failures.push('a runtime role is missing');
  for (const role of roles.rows) {
    if (role.rolsuper) failures.push(`${role.rolname} is a superuser`);
    if (role.rolbypassrls) failures.push(`${role.rolname} has BYPASSRLS`);
    if (role.rolcreaterole) failures.push(`${role.rolname} has CREATEROLE`);
    if (role.owner_member) failures.push(`${role.rolname} is a member of vs_owner`);
    if (role.owns > 0) failures.push(`${role.rolname} owns ${role.owns} relation(s)`);
  }

  const definers = await owner().query<{
    name: string;
    config: string[] | null;
    callers: string[];
  }>(
    `select p.proname as name, p.proconfig as config,
            array(select r from unnest($1::text[]) r where has_function_privilege(r, p.oid, 'EXECUTE')) as callers
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'vs' and p.prosecdef`,
    [[...LOGIN_ROLES, 'anon', 'authenticated']],
  );
  for (const fn of definers.rows) {
    const allowed = SECURITY_DEFINER_ALLOWLIST[fn.name];
    if (!allowed) {
      failures.push(`SECURITY DEFINER function vs.${fn.name} is not on the allow-list`);
      continue;
    }
    if (!fn.config?.some((setting) => setting === 'search_path=""' || setting === 'search_path=')) {
      failures.push(`vs.${fn.name} does not pin search_path to ''`);
    }
    if ([...fn.callers].sort().join(',') !== [...allowed].sort().join(',')) {
      failures.push(
        `vs.${fn.name} is executable by [${fn.callers.join(', ')}], expected [${allowed.join(', ')}]`,
      );
    }
  }
  return failures;
}
