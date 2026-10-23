import pg from 'pg';
import { adminOptions, assertLocal } from './env';

// Local only: drops everything this project owns so `migrate` starts from scratch.
const { adminUrl } = adminOptions();
assertLocal(adminUrl);
const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
await client.query(`
  do $$ begin
    if exists (select from pg_roles where rolname = 'vs_owner') then
      set local role vs_owner;
      -- Drops every object vs_owner owns (schemas vs and graphile_worker included).
      execute 'drop owned by vs_owner cascade';
      reset role;
    end if;
  end $$;
  drop schema if exists vs_migrations cascade;
`);
await client.end();
console.log('local database reset');
