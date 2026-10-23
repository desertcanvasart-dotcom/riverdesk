-- Batch 0 foundation: privileges, helpers, tenant tables, RLS, invariant stub.
-- Runs as vs_owner (the migration runner does SET LOCAL ROLE vs_owner).

-- ---------------------------------------------------------------------------
-- Default privileges: every table vs_owner creates in schema vs is usable by the runtime
-- roles through RLS. Functions are not executable by PUBLIC; runtime roles get EXECUTE, and
-- SECURITY DEFINER functions revoke it again from all but the role that needs them.
-- ---------------------------------------------------------------------------
alter default privileges in schema vs
  grant select, insert, update, delete on tables to vs_backoffice, vs_api, vs_worker;
alter default privileges in schema vs
  grant usage, select on sequences to vs_backoffice, vs_api, vs_worker;
-- PUBLIC's EXECUTE is a global default, so it has to be revoked without IN SCHEMA.
alter default privileges revoke execute on functions from public;
alter default privileges in schema vs
  grant execute on functions to vs_backoffice, vs_api, vs_worker;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- UUID v7: 48-bit Unix milliseconds, then random bits; version nibble 7, RFC 4122 variant.
create function vs.uuid_v7() returns uuid
language sql volatile parallel safe
set search_path = ''
as $$
  select encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          placing substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
          from 1 for 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid
$$;

-- The tenant of the current transaction. A missing or empty setting yields NULL, so every
-- policy comparison is false and no rows are visible.
create function vs.current_operator_id() returns uuid
language sql stable parallel safe
set search_path = ''
as $$
  select nullif(current_setting('app.operator_id', true), '')::uuid
$$;

create function vs.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- operator: the tenant. Its own id is the tenant key.
-- Runtime roles can read and update their own operator; creating one is a platform task.
-- ---------------------------------------------------------------------------
create table vs.operator (
  id uuid primary key default vs.uuid_v7(),
  name text not null check (length(name) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  default_locale text not null default 'ar' check (default_locale in ('ar', 'en')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger operator_touch before update on vs.operator
  for each row execute function vs.touch_updated_at();
alter table vs.operator enable row level security;
create policy tenant_isolation on vs.operator
  for all to vs_backoffice, vs_api, vs_worker
  using (id = vs.current_operator_id())
  with check (id = vs.current_operator_id());
revoke insert, delete on vs.operator from vs_backoffice, vs_api, vs_worker;

-- ---------------------------------------------------------------------------
-- operator_setting: per-operator defaults (prompt § Defaults for open decisions).
-- ---------------------------------------------------------------------------
create table vs.operator_setting (
  operator_id uuid primary key references vs.operator (id),
  checkout_hold_minutes integer not null default 30 check (checkout_hold_minutes > 0),
  option_hold_hours integer not null default 72 check (option_hold_hours > 0),
  offer_hold_hours integer not null default 48 check (offer_hold_hours > 0),
  payment_hold_hours integer not null default 24 check (payment_hold_hours > 0),
  request_sla_hours integer not null default 6 check (request_sla_hours > 0),
  request_grace_hours integer not null default 2 check (request_grace_hours >= 0),
  assignment_cutoff_days integer not null default 7 check (assignment_cutoff_days >= 0),
  allotment_release_days integer not null default 21 check (allotment_release_days >= 0),
  passport_retention_days integer not null default 90 check (passport_retention_days > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger operator_setting_touch before update on vs.operator_setting
  for each row execute function vs.touch_updated_at();
alter table vs.operator_setting enable row level security;
create policy tenant_isolation on vs.operator_setting
  for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());
revoke insert, delete on vs.operator_setting from vs_backoffice, vs_api, vs_worker;

-- ---------------------------------------------------------------------------
-- staff_user: links a Supabase Auth user (auth.users.id) to exactly one operator and a role.
-- No foreign key to auth.users: hosted Supabase does not let custom roles hold REFERENCES on
-- it (see docs/decisions.md). auth_user_id is unique, so one login maps to one operator.
-- ---------------------------------------------------------------------------
create table vs.staff_user (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  auth_user_id uuid not null unique,
  email text not null check (email ~ '^[^@\s]+@[^@\s]+$'),
  display_name text not null check (length(display_name) between 1 and 200),
  role text not null check (role in ('owner', 'reservations', 'finance', 'read_only')),
  locale text not null default 'ar' check (locale in ('ar', 'en')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, email)
);
create trigger staff_user_touch before update on vs.staff_user
  for each row execute function vs.touch_updated_at();
alter table vs.staff_user enable row level security;
create policy tenant_isolation on vs.staff_user
  for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());

-- ---------------------------------------------------------------------------
-- audit_log: append-only (rule 11). Diffs are redacted by the engine before insert.
-- ---------------------------------------------------------------------------
create table vs.audit_log (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  actor_type text not null check (actor_type in ('staff', 'channel', 'system')),
  actor_id uuid,
  actor_label text,
  action text not null check (action ~ '^[a-z][a-z0-9_.]*$'),
  entity text not null,
  entity_id uuid,
  diff jsonb not null default '{}'::jsonb,
  request_key text,
  created_at timestamptz not null default now(),
  check (actor_type = 'system' or actor_id is not null)
);
create index audit_log_entity_idx on vs.audit_log (operator_id, entity, entity_id, created_at);
create index audit_log_created_idx on vs.audit_log (operator_id, created_at);
alter table vs.audit_log enable row level security;
create policy tenant_isolation on vs.audit_log
  for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());
revoke update, delete on vs.audit_log from vs_backoffice, vs_api, vs_worker;

-- ---------------------------------------------------------------------------
-- exception: things staff must resolve (action list). Resolved, never deleted.
-- dedupe_key stops a repeating check (e.g. nightly invariants) from opening duplicates.
-- ---------------------------------------------------------------------------
create table vs.exception (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  kind text not null check (kind in (
    'invariant', 'oversubscription', 'late_payment', 'paid_unavailable', 'schedule_change',
    'webhook_failure', 'allotment_release_failure', 'guest_age_mismatch'
  )),
  severity text not null default 'warning' check (severity in ('critical', 'warning', 'info')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved', 'dismissed')),
  summary text not null,
  refs jsonb not null default '[]'::jsonb check (jsonb_typeof(refs) = 'array'),
  details jsonb not null default '{}'::jsonb,
  dedupe_key text,
  owner_staff_id uuid,
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  foreign key (operator_id, owner_staff_id) references vs.staff_user (operator_id, id)
);
create unique index exception_open_dedupe_idx on vs.exception (operator_id, dedupe_key)
  where dedupe_key is not null and status in ('open', 'acknowledged');
create index exception_open_idx on vs.exception (operator_id, created_at)
  where status in ('open', 'acknowledged');
create trigger exception_touch before update on vs.exception
  for each row execute function vs.touch_updated_at();
alter table vs.exception enable row level security;
create policy tenant_isolation on vs.exception
  for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());
revoke delete on vs.exception from vs_backoffice, vs_api, vs_worker;

-- ---------------------------------------------------------------------------
-- idempotency_key: used by the channel API (Batch 5) and back-office request keys (Batch 3).
-- scope_id is the channel; its foreign key is added when channel exists (Batch 2).
-- ---------------------------------------------------------------------------
create table vs.idempotency_key (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  scope_id uuid not null,
  key text not null check (length(key) between 1 and 255),
  request_hash text not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'done')),
  response_status integer,
  response_body jsonb,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, scope_id, key)
);
create index idempotency_key_expiry_idx on vs.idempotency_key (expires_at);
create trigger idempotency_key_touch before update on vs.idempotency_key
  for each row execute function vs.touch_updated_at();
alter table vs.idempotency_key enable row level security;
create policy tenant_isolation on vs.idempotency_key
  for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());

-- ---------------------------------------------------------------------------
-- Invariants (spec § Inventory model). SECURITY INVOKER: under a runtime role it sees only the
-- current tenant; as the owner (test runner, break-glass) it sees every operator.
-- Batch 0 stub: no inventory tables yet, so it returns no rows. Batches 1 and 3 replace it.
-- ---------------------------------------------------------------------------
create function vs.check_invariants()
returns table (operator_id uuid, invariant smallint, entity text, entity_id uuid, detail jsonb)
language sql stable
set search_path = ''
as $$
  select null::uuid, null::smallint, null::text, null::uuid, null::jsonb
  where false
$$;

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER lookups that run before a tenant is known. Each returns ids only and is
-- executable by exactly one runtime role. The test harness checks this allow-list.
-- ---------------------------------------------------------------------------
create function vs.list_operator_ids() returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select id from vs.operator order by id
$$;
revoke execute on function vs.list_operator_ids() from public, vs_backoffice, vs_api;

create function vs.resolve_staff(p_auth_user_id uuid)
returns table (staff_user_id uuid, operator_id uuid, role text)
language sql stable security definer
set search_path = ''
as $$
  select s.id, s.operator_id, s.role
  from vs.staff_user s
  where s.auth_user_id = p_auth_user_id and s.active
$$;
revoke execute on function vs.resolve_staff(uuid) from public, vs_api, vs_worker;
