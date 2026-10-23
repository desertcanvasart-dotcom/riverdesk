import pg from 'pg';
import { required } from '@vs/shared';
import { adminOptions, assertLocal } from '../src/cli/env';

/**
 * Local demo data (idempotent, fixed ids): one operator, an owner and a reservations user who
 * can log in to local Supabase Auth with SEED_STAFF_PASSWORD. Hosted environments do not use
 * this script: staff are invited through Supabase Auth and linked in the back office.
 */
export const DEMO_OPERATOR_ID = '019a0000-0000-7000-8000-000000000001';
export const DEMO_STAFF = [
  {
    authUserId: '019a0000-0000-7000-8000-0000000000a1',
    staffUserId: '019a0000-0000-7000-8000-0000000000b1',
    email: 'owner@demo.local',
    name: 'Demo Owner',
    role: 'owner',
  },
  {
    authUserId: '019a0000-0000-7000-8000-0000000000a2',
    staffUserId: '019a0000-0000-7000-8000-0000000000b2',
    email: 'reservations@demo.local',
    name: 'Demo Reservations',
    role: 'reservations',
  },
] as const;

const { config, adminUrl } = adminOptions();
assertLocal(adminUrl);
const password = required(config, 'SEED_STAFF_PASSWORD');

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  await client.query('begin');
  for (const staff of DEMO_STAFF) {
    await client.query(
      `insert into auth.users (
         instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
         confirmation_token, recovery_token, email_change_token_new, email_change
       ) values (
         '00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
         extensions.crypt($3, extensions.gen_salt('bf')), now(),
         '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
       ) on conflict (id) do nothing`,
      [staff.authUserId, staff.email, password],
    );
    await client.query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       values ($1::text, $1::uuid, jsonb_build_object('sub', $1::text, 'email', $2::text), 'email', now(), now(), now())
       on conflict (provider_id, provider) do nothing`,
      [staff.authUserId, staff.email],
    );
  }

  await client.query('set local role vs_owner');
  await client.query(
    `insert into vs.operator (id, name, slug, default_locale)
     values ($1, 'Demo Nile Cruises', 'demo', 'ar') on conflict (id) do nothing`,
    [DEMO_OPERATOR_ID],
  );
  await client.query(
    'insert into vs.operator_setting (operator_id) values ($1) on conflict (operator_id) do nothing',
    [DEMO_OPERATOR_ID],
  );
  for (const staff of DEMO_STAFF) {
    await client.query(
      `insert into vs.staff_user (id, operator_id, auth_user_id, email, display_name, role)
       values ($1, $2, $3, $4, $5, $6) on conflict (id) do nothing`,
      [staff.staffUserId, DEMO_OPERATOR_ID, staff.authUserId, staff.email, staff.name, staff.role],
    );
  }
  await client.query('commit');
  console.log(`seeded operator ${DEMO_OPERATOR_ID} with ${DEMO_STAFF.length} staff users`);
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  await client.end();
}
