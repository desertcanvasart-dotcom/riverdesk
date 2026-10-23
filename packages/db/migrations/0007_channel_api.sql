-- Batch 5: channel API clients, webhook endpoints and deliveries, rate limits, event feed.

-- OAuth 2.0 client credentials. One client belongs to one channel of one company. Secrets are
-- stored as SHA-256 hashes of high-entropy random strings; at most two are active (rotation).
create table vs.api_client (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  channel_id uuid not null,
  client_id text not null unique check (client_id ~ '^vsc_[a-z0-9]{16,40}$'),
  name text not null,
  rate_limit_per_minute integer not null default 600 check (rate_limit_per_minute between 1 and 100000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  foreign key (operator_id, channel_id) references vs.channel (operator_id, id)
);

create table vs.api_client_secret (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  api_client_id uuid not null,
  secret_hash text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  hint text not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (operator_id, api_client_id) references vs.api_client (operator_id, id)
);
create index api_client_secret_client_idx on vs.api_client_secret (api_client_id) where revoked_at is null;

-- Fixed one-minute windows per client (Postgres-backed, no Redis).
create table vs.rate_limit_counter (
  operator_id uuid not null references vs.operator (id),
  api_client_id uuid not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (api_client_id, window_start),
  foreign key (operator_id, api_client_id) references vs.api_client (operator_id, id)
);

-- Webhook endpoints. The signing secret is encrypted like other secret fields (AES-256-GCM).
-- last_txid/last_seq: how far the dispatcher has fanned events out to this endpoint.
create table vs.webhook_endpoint (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  channel_id uuid not null,
  url text not null check (url ~ '^https?://'),
  secret_ciphertext bytea not null,
  secret_key_id text not null,
  event_types text[],
  active boolean not null default true,
  last_txid xid8 not null default '0'::xid8,
  last_seq bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  foreign key (operator_id, channel_id) references vs.channel (operator_id, id)
);

alter table vs.event add constraint event_operator_id_id_key unique (operator_id, id);

-- One delivery per endpoint × event; every attempt is recorded in webhook_attempt.
create table vs.webhook_delivery (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  endpoint_id uuid not null,
  event_id uuid not null,
  resource_id uuid not null,
  event_txid xid8 not null,
  event_seq bigint not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'dead')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  delivered_at timestamptz,
  last_status_code integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (endpoint_id, event_id),
  foreign key (operator_id, endpoint_id) references vs.webhook_endpoint (operator_id, id),
  foreign key (operator_id, event_id) references vs.event (operator_id, id)
);
create index webhook_delivery_due_idx on vs.webhook_delivery (next_attempt_at) where status = 'pending';
create index webhook_delivery_order_idx on vs.webhook_delivery (endpoint_id, resource_id, event_txid, event_seq) where status = 'pending';

create table vs.webhook_attempt (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  delivery_id uuid not null,
  attempt integer not null,
  status_code integer,
  error text,
  duration_ms integer,
  created_at timestamptz not null default now(),
  foreign key (operator_id, delivery_id) references vs.webhook_delivery (operator_id, id)
);
create index webhook_attempt_delivery_idx on vs.webhook_attempt (delivery_id, attempt);

-- The event feed is read in (txid, seq) order, only below the oldest running transaction, so a
-- transaction that commits late can never be skipped by a cursor.
create index event_feed_idx on vs.event (operator_id, txid, seq);

do $$
declare
  t text;
begin
  foreach t in array array['api_client', 'api_client_secret', 'rate_limit_counter', 'webhook_endpoint', 'webhook_delivery', 'webhook_attempt'] loop
    execute format('alter table vs.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation on vs.%I for all to vs_backoffice, vs_api, vs_worker
         using (operator_id = vs.current_operator_id())
         with check (operator_id = vs.current_operator_id())', t);
    if exists (
      select from information_schema.columns
      where table_schema = 'vs' and table_name = t and column_name = 'updated_at'
    ) then
      execute format(
        'create trigger %I before update on vs.%I for each row execute function vs.touch_updated_at()',
        t || '_touch', t);
    end if;
  end loop;
end
$$;
revoke update, delete on vs.webhook_attempt from vs_backoffice, vs_api, vs_worker;
revoke delete on vs.api_client, vs.api_client_secret, vs.webhook_endpoint, vs.webhook_delivery
  from vs_backoffice, vs_api, vs_worker;

-- Token endpoint: finds a client by its public client_id before the tenant is known. Returns
-- ids and active secret hashes only. API role only.
create function vs.resolve_api_client(p_client_id text)
returns table (api_client_id uuid, operator_id uuid, channel_id uuid, secret_hashes text[])
language sql stable security definer
set search_path = ''
as $$
  select c.id, c.operator_id, c.channel_id,
         array(select s.secret_hash from vs.api_client_secret s
               where s.api_client_id = c.id and s.revoked_at is null)
  from vs.api_client c
  where c.client_id = p_client_id and c.active
$$;
revoke execute on function vs.resolve_api_client(text) from public, vs_backoffice, vs_worker;

-- The current safe horizon for the event feed: events with txid below it are all committed.
create function vs.event_horizon() returns xid8
language sql stable
set search_path = ''
as $$ select pg_snapshot_xmin(pg_current_snapshot()) $$;
