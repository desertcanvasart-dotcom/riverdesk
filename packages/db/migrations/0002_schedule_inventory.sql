-- Batch 1: product, schedule, inventory per leg × category, outbox events, invariants 1 and 3.
-- Runs as vs_owner. Every tenant table: operator_id, composite foreign keys (operator_id, x_id)
-- so a row can never point at another tenant's row, RLS with the tenant policy.

-- ---------------------------------------------------------------------------
-- Product
-- ---------------------------------------------------------------------------
create table vs.port (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  code text not null check (code ~ '^[A-Z][A-Z0-9_]{1,15}$'),
  name_en text not null,
  name_ar text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, code)
);

create table vs.vessel (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  code text not null check (code ~ '^[A-Z][A-Z0-9_]{1,15}$'),
  name text not null,
  type text not null check (type in ('cruise_ship', 'dahabiya', 'steam')),
  max_guests integer not null check (max_guests > 0),
  sells_cabins boolean not null default true,
  sells_charter boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, code)
);

create table vs.cabin_category (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  code text not null check (code ~ '^[A-Z][A-Z0-9_]{0,15}$'),
  name_en text not null,
  name_ar text not null,
  deck text,
  view text,
  bed_config text,
  max_adults integer not null check (max_adults between 1 and 10),
  max_occupancy integer not null,
  extra_bed_allowed boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, vessel_id, id),
  unique (operator_id, vessel_id, code),
  check (max_occupancy >= max_adults and max_occupancy <= 12),
  foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id)
);

-- A physical cabin. Its category and whether it is in service are date-effective (cabin_period),
-- so "active" is derived: a cabin is active on a date when a period covers that date.
create table vs.cabin (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  number text not null check (length(number) between 1 and 16),
  deck text,
  connecting_cabin_id uuid,
  accessible boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, vessel_id, id),
  unique (operator_id, vessel_id, number),
  foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id),
  foreign key (operator_id, connecting_cabin_id) references vs.cabin (operator_id, id)
);

-- When a cabin is in service and in which category. Half-open ranges; upper bound null = open.
-- A cabin counts on a leg when a period covers the leg's departure date.
create table vs.cabin_period (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  cabin_id uuid not null,
  category_id uuid not null,
  during daterange not null check (not isempty(during) and lower_inc(during) and not lower_inf(during)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  foreign key (operator_id, vessel_id, cabin_id) references vs.cabin (operator_id, vessel_id, id),
  foreign key (operator_id, vessel_id, category_id) references vs.cabin_category (operator_id, vessel_id, id),
  exclude using gist (cabin_id with =, during with &&)
);
create index cabin_period_vessel_idx on vs.cabin_period using gist (vessel_id, during);

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------

-- A repeating cycle of stops (usually 7 days). Cycles start on valid_from and every cycle_days
-- after it, up to valid_to. The last stop ends the cycle at day_offset = cycle_days, at the same
-- port as the first stop, which is where the next cycle begins.
create table vs.schedule_template (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  name text not null,
  cycle_days integer not null check (cycle_days between 1 and 60),
  valid_from date not null,
  valid_to date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, vessel_id, id),
  check (valid_to is null or valid_to >= valid_from),
  foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id)
);

-- Legs split at every stop where guests may board or leave (docs/decisions.md).
create table vs.schedule_template_stop (
  operator_id uuid not null references vs.operator (id),
  template_id uuid not null,
  seq integer not null check (seq >= 0),
  port_id uuid not null,
  day_offset integer not null check (day_offset >= 0),
  arrive_time time,
  depart_time time,
  embark_allowed boolean not null default false,
  disembark_allowed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (template_id, seq),
  foreign key (operator_id, template_id) references vs.schedule_template (operator_id, id),
  foreign key (operator_id, port_id) references vs.port (operator_id, id)
);

-- Which runs of legs are sold as cruises: embark at a stop in cycle k, disembark at a stop in
-- cycle k + disembark_cycle_offset. "7 nights from Aswan" = Aswan stop to Aswan stop, offset 1.
create table vs.sailing_pattern (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  template_id uuid not null,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'),
  name_en text not null,
  name_ar text not null,
  embark_stop_seq integer not null check (embark_stop_seq >= 0),
  disembark_stop_seq integer not null check (disembark_stop_seq >= 1),
  disembark_cycle_offset integer not null default 0 check (disembark_cycle_offset between 0 and 8),
  nights integer not null check (nights > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, template_id, code),
  check (disembark_cycle_offset > 0 or disembark_stop_seq > embark_stop_seq),
  foreign key (operator_id, vessel_id, template_id) references vs.schedule_template (operator_id, vessel_id, id)
);

create table vs.leg (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  template_id uuid,
  cycle_start date,
  from_stop_seq integer,
  to_stop_seq integer,
  from_port_id uuid not null,
  to_port_id uuid not null,
  depart_date date not null,
  arrive_date date not null,
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, vessel_id, id),
  check (arrive_date > depart_date),
  check ((template_id is null) = (cycle_start is null)),
  foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id),
  foreign key (operator_id, template_id) references vs.schedule_template (operator_id, id),
  foreign key (operator_id, from_port_id) references vs.port (operator_id, id),
  foreign key (operator_id, to_port_id) references vs.port (operator_id, id),
  -- A vessel is in one place at a time: live legs never overlap ([depart, arrive) ranges).
  -- Deferrable so a run of legs can be shifted in one statement.
  constraint leg_no_overlap exclude using gist (vessel_id with =, daterange(depart_date, arrive_date) with &&)
    where (status <> 'cancelled') deferrable initially immediate
);
-- Generation is idempotent: one leg per template cycle and starting stop.
create unique index leg_template_cycle_idx on vs.leg (operator_id, template_id, cycle_start, from_stop_seq)
  where template_id is not null;
create index leg_vessel_depart_idx on vs.leg (operator_id, vessel_id, depart_date);

create table vs.sailing (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  pattern_id uuid,
  embark_port_id uuid not null,
  disembark_port_id uuid not null,
  embark_date date not null,
  disembark_date date not null,
  nights integer not null check (nights > 0),
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, vessel_id, id),
  check (disembark_date > embark_date),
  foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id),
  foreign key (operator_id, pattern_id) references vs.sailing_pattern (operator_id, id),
  foreign key (operator_id, embark_port_id) references vs.port (operator_id, id),
  foreign key (operator_id, disembark_port_id) references vs.port (operator_id, id)
);
create unique index sailing_pattern_date_idx on vs.sailing (operator_id, pattern_id, embark_date)
  where pattern_id is not null;
create index sailing_vessel_embark_idx on vs.sailing (operator_id, vessel_id, embark_date);

create table vs.sailing_leg (
  operator_id uuid not null references vs.operator (id),
  sailing_id uuid not null,
  leg_id uuid not null,
  seq integer not null check (seq >= 0),
  created_at timestamptz not null default now(),
  primary key (sailing_id, seq),
  unique (sailing_id, leg_id),
  foreign key (operator_id, sailing_id) references vs.sailing (operator_id, id),
  foreign key (operator_id, leg_id) references vs.leg (operator_id, id)
);
create index sailing_leg_leg_idx on vs.sailing_leg (leg_id);

create table vs.schedule_exception (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  kind text not null check (kind in ('cancel', 'shift', 'port_change', 'dry_dock')),
  date_from date not null,
  date_to date not null,
  details jsonb not null default '{}'::jsonb,
  reason text not null,
  status text not null default 'applied' check (status in ('applied')),
  exception_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  check (date_to >= date_from),
  foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id),
  foreign key (operator_id, exception_id) references vs.exception (operator_id, id)
);
create index schedule_exception_vessel_idx on vs.schedule_exception (operator_id, vessel_id, kind, date_from);

-- ---------------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------------
create table vs.cabin_block (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  category_id uuid not null,
  cabin_id uuid,
  kind text not null check (kind in ('normal', 'emergency')),
  count integer not null check (count > 0),
  reason text not null check (length(reason) between 1 and 500),
  status text not null default 'active' check (status in ('active', 'released')),
  exception_id uuid,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  check (cabin_id is null or count = 1),
  check ((status = 'released') = (released_at is not null)),
  foreign key (operator_id, vessel_id, category_id) references vs.cabin_category (operator_id, vessel_id, id),
  foreign key (operator_id, vessel_id, cabin_id) references vs.cabin (operator_id, vessel_id, id),
  foreign key (operator_id, exception_id) references vs.exception (operator_id, id)
);

-- One counter per leg × category × kind (spec § Inventory model). free = total − held − booked.
-- overcommit (pool only): cabins an emergency block took beyond free; while it is above zero the
-- bucket must be stopped and an open oversubscription exception must reference it (invariant 3).
create table vs.inventory_bucket (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  leg_id uuid not null,
  category_id uuid not null,
  kind text not null check (kind in ('pool', 'allotment', 'block')),
  allotment_id uuid, -- foreign key added with the allotment table (Batch 3)
  block_id uuid,
  total integer not null default 0 check (total >= 0),
  held integer not null default 0 check (held >= 0),
  booked integer not null default 0 check (booked >= 0),
  overcommit integer not null default 0 check (overcommit >= 0),
  stop_sale boolean not null default false,
  stop_reason text,
  released_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  check ((kind = 'pool') = (allotment_id is null and block_id is null)),
  check (kind <> 'allotment' or (allotment_id is not null and block_id is null)),
  check (kind <> 'block' or (block_id is not null and allotment_id is null)),
  check (stop_sale = (stop_reason is not null)),
  foreign key (operator_id, vessel_id, leg_id) references vs.leg (operator_id, vessel_id, id),
  foreign key (operator_id, vessel_id, category_id) references vs.cabin_category (operator_id, vessel_id, id),
  foreign key (operator_id, block_id) references vs.cabin_block (operator_id, id)
);
create unique index inventory_bucket_pool_idx on vs.inventory_bucket (leg_id, category_id) where kind = 'pool';
create unique index inventory_bucket_block_idx on vs.inventory_bucket (leg_id, block_id) where kind = 'block';
create index inventory_bucket_leg_idx on vs.inventory_bucket (operator_id, leg_id, category_id);

-- Append-only history of every counter change.
create table vs.inventory_event (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  bucket_id uuid not null,
  leg_id uuid not null,
  category_id uuid not null,
  delta_total integer not null default 0,
  delta_held integer not null default 0,
  delta_booked integer not null default 0,
  delta_overcommit integer not null default 0,
  cause text not null check (cause ~ '^[a-z][a-z0-9_.]*$'),
  ref_entity text,
  ref_id uuid,
  actor_type text not null check (actor_type in ('staff', 'channel', 'system')),
  actor_id uuid,
  actor_label text,
  created_at timestamptz not null default now(),
  foreign key (operator_id, bucket_id) references vs.inventory_bucket (operator_id, id)
);
create index inventory_event_bucket_idx on vs.inventory_event (operator_id, bucket_id, created_at);
create index inventory_event_leg_idx on vs.inventory_event (operator_id, leg_id, created_at);

-- Outbox (rule 3). resource_version is the owning row's version after the change, so it is
-- monotonic per resource. seq orders the feed; txid lets the feed skip in-flight transactions.
create table vs.event (
  id uuid primary key default vs.uuid_v7(),
  seq bigint generated by default as identity unique,
  operator_id uuid not null references vs.operator (id),
  type text not null check (type ~ '^[a-z]+\.[a-z_]+$'),
  resource text not null,
  resource_id uuid not null,
  resource_version bigint not null,
  payload jsonb not null default '{}'::jsonb,
  txid xid8 not null default pg_current_xact_id(),
  occurred_at timestamptz not null default now(),
  unique (operator_id, resource, resource_id, resource_version, type)
);
create index event_operator_seq_idx on vs.event (operator_id, seq);

-- ---------------------------------------------------------------------------
-- RLS, triggers and rights for every table above
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'port', 'vessel', 'cabin_category', 'cabin', 'cabin_period', 'schedule_template',
    'schedule_template_stop', 'sailing_pattern', 'leg', 'sailing', 'sailing_leg',
    'schedule_exception', 'cabin_block', 'inventory_bucket', 'inventory_event', 'event'
  ] loop
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

-- History and outbox are append-only; schedule and inventory rows are never deleted.
revoke update, delete on vs.inventory_event, vs.event from vs_backoffice, vs_api, vs_worker;
revoke delete on vs.leg, vs.sailing, vs.sailing_leg, vs.inventory_bucket, vs.cabin_block,
  vs.schedule_exception from vs_backoffice, vs_api, vs_worker;

-- ---------------------------------------------------------------------------
-- Invariants 1 and 3 (spec § Inventory model). Invariant 2 is added in Batch 3.
--   1. For every leg × category: sum of bucket totals = active cabins of that category.
--   3. 0 ≤ held, 0 ≤ booked, held + booked ≤ total + overcommit; overcommit only on a stopped pool
--      bucket that an open oversubscription exception references.
-- Every row carries leg_id and category_id in detail so a violation can stop sales there.
-- ---------------------------------------------------------------------------
create or replace function vs.check_invariants()
returns table (operator_id uuid, invariant smallint, entity text, entity_id uuid, detail jsonb)
language sql stable
set search_path = ''
as $$
  with bucket_totals as (
    select b.operator_id, b.leg_id, b.category_id, sum(b.total)::bigint as total
    from vs.inventory_bucket b
    group by b.operator_id, b.leg_id, b.category_id
  ),
  cabin_counts as (
    select l.operator_id, l.id as leg_id, p.category_id, count(*)::bigint as cabins
    from vs.leg l
    join vs.cabin_period p on p.vessel_id = l.vessel_id and p.operator_id = l.operator_id
      and p.during @> l.depart_date
    group by l.operator_id, l.id, p.category_id
  )
  select coalesce(t.operator_id, c.operator_id), 1::smallint, 'leg', coalesce(t.leg_id, c.leg_id),
         jsonb_build_object(
           'leg_id', coalesce(t.leg_id, c.leg_id),
           'category_id', coalesce(t.category_id, c.category_id),
           'bucket_total', coalesce(t.total, 0),
           'active_cabins', coalesce(c.cabins, 0))
  from bucket_totals t
  full join cabin_counts c on c.leg_id = t.leg_id and c.category_id = t.category_id
  where coalesce(t.total, 0) <> coalesce(c.cabins, 0)

  union all

  select b.operator_id, 3::smallint, 'inventory_bucket', b.id,
         jsonb_build_object(
           'leg_id', b.leg_id, 'category_id', b.category_id, 'kind', b.kind,
           'total', b.total, 'held', b.held, 'booked', b.booked,
           'overcommit', b.overcommit, 'stop_sale', b.stop_sale)
  from vs.inventory_bucket b
  where b.total < 0 or b.held < 0 or b.booked < 0 or b.overcommit < 0
     or b.held + b.booked > b.total + b.overcommit
     or (b.overcommit > 0 and (
           b.kind <> 'pool'
           or not b.stop_sale
           or not exists (
             select from vs.exception e
             where e.operator_id = b.operator_id
               and e.kind = 'oversubscription'
               and e.status in ('open', 'acknowledged')
               and e.refs @> jsonb_build_array(jsonb_build_object('entity', 'inventory_bucket', 'id', b.id::text))
           )))
$$;
