import { describe, expect, it } from 'vitest';
import { checkRolesAndDefiners, owner, roleClient } from '../src/testing/index';

describe('database roles (rule 7)', () => {
  it('runtime roles are not owners, superusers or BYPASSRLS; definers are allow-listed', async () => {
    expect(await checkRolesAndDefiners()).toEqual([]);
  });

  it('nobody can log in as vs_owner', async () => {
    const { rows } = await owner().query<{ rolcanlogin: boolean }>(
      `select rolcanlogin from pg_roles where rolname = 'vs_owner'`,
    );
    expect(rows[0]?.rolcanlogin).toBe(false);
  });

  it('Supabase anon and authenticated roles cannot use schema vs', async () => {
    const { rows } = await owner().query<{ anon: boolean; authenticated: boolean }>(
      `select has_schema_privilege('anon', 'vs', 'USAGE') as anon,
              has_schema_privilege('authenticated', 'vs', 'USAGE') as authenticated`,
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: false });
  });

  it('only the worker can reach the Graphile Worker schema', async () => {
    const { rows } = await owner().query<{ role: string; usage: boolean }>(
      `select r as role, has_schema_privilege(r, 'graphile_worker', 'USAGE') as usage
       from unnest(array['vs_backoffice', 'vs_api', 'vs_worker']) r order by r`,
    );
    expect(rows).toEqual([
      { role: 'vs_api', usage: false },
      { role: 'vs_backoffice', usage: false },
      { role: 'vs_worker', usage: true },
    ]);
  });

  it('generates UUID v7 ids in the database', async () => {
    const client = await roleClient('vs_api');
    try {
      const { rows } = await client.query<{ id: string }>('select vs.uuid_v7()::text as id');
      expect(rows[0]?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      await client.end();
    }
  });
});
