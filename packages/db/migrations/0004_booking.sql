-- Batch 3: allotments, holds, bookings, revisions, offers, guests; invariant 2.

-- Booking references: PREFIX-YY-NNNNN. One global sequence (no lock, gaps are fine), so
-- concurrent confirmations never queue on a counter row.
alter table vs.operator_setting
  add column booking_ref_prefix text not null default 'VS' check (booking_ref_prefix ~ '^[A-Z]{2,5}$');
create sequence vs.booking_ref_seq as bigint start 1;

-- ---------------------------------------------------------------------------
-- Allotments: a channel's own block of cabins per leg × category (spec § Allotments).
-- Counters live in inventory_bucket rows of kind 'allotment'; released_at marks a released leg.
-- ---------------------------------------------------------------------------
create table vs.allotment (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  channel_id uuid not null,
  vessel_id uuid not null,
  release_days integer not null check (release_days between 0 and 400),
  status text not null default 'active' check (status in ('active', 'released')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  foreign key (operator_id, channel_id) references vs.channel (operator_id, id),
  foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id)
);
alter table vs.inventory_bucket
  add foreign key (operator_id, allotment_id) references vs.allotment (operator_id, id);
create unique index inventory_bucket_allotment_idx on vs.inventory_bucket (leg_id, allotment_id, category_id)
  where kind = 'allotment';
create index inventory_bucket_release_idx on vs.inventory_bucket (operator_id, allotment_id)
  where kind = 'allotment' and released_at is null;

-- ---------------------------------------------------------------------------
-- Bookings
-- status: requested → held | offered | confirmed | declined | expired;
--         held → confirmed | expired | cancelled; confirmed → cancelled | completed.
-- ---------------------------------------------------------------------------
create table vs.booking (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  ref text not null check (ref ~ '^[A-Z]{2,5}-[0-9]{2}-[0-9]{5,}$'),
  channel_id uuid not null,
  contract_id uuid not null,
  channel_ref text check (length(channel_ref) between 1 and 100),
  vessel_id uuid not null,
  sailing_id uuid not null,
  quote_id uuid not null,
  rate_plan_id uuid not null,
  kind text not null default 'cabins' check (kind in ('cabins')),
  status text not null check (status in (
    'requested', 'held', 'offered', 'confirmed', 'declined', 'expired', 'cancelled', 'completed'
  )),
  revision integer not null default 0 check (revision >= 0),
  market text not null,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  total bigint not null check (total >= 0),
  net_total bigint not null check (net_total >= 0),
  request_expires_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  penalty_amount bigint check (penalty_amount >= 0),
  completed_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, ref),
  check (status <> 'requested' or request_expires_at is not null),
  foreign key (operator_id, channel_id) references vs.channel (operator_id, id),
  foreign key (operator_id, contract_id) references vs.channel_contract (operator_id, id),
  foreign key (operator_id, vessel_id, sailing_id) references vs.sailing (operator_id, vessel_id, id),
  foreign key (operator_id, quote_id) references vs.quote (operator_id, id),
  foreign key (operator_id, rate_plan_id) references vs.rate_plan (operator_id, id)
);
-- channel_ref is unique per channel forever (spec § Idempotency).
create unique index booking_channel_ref_idx on vs.booking (operator_id, channel_id, channel_ref)
  where channel_ref is not null;
create index booking_status_idx on vs.booking (operator_id, status);
create index booking_sailing_idx on vs.booking (operator_id, sailing_id);
create index booking_request_expiry_idx on vs.booking (request_expires_at) where status = 'requested';

create table vs.booking_cabin (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  booking_id uuid not null,
  seq integer not null check (seq >= 0),
  category_id uuid not null,
  adults integer not null check (adults >= 1),
  child_ages integer[] not null default '{}',
  assigned_cabin_id uuid,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  foreign key (operator_id, booking_id) references vs.booking (operator_id, id),
  foreign key (operator_id, category_id) references vs.cabin_category (operator_id, id),
  foreign key (operator_id, assigned_cabin_id) references vs.cabin (operator_id, id)
);
create unique index booking_cabin_seq_idx on vs.booking_cabin (booking_id, seq) where status = 'active';

-- The inventory link: one row per booked cabin per leg, with the bucket it came from.
create table vs.booking_line (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  booking_id uuid not null,
  booking_cabin_id uuid not null,
  leg_id uuid not null,
  category_id uuid not null,
  bucket_id uuid not null,
  status text not null default 'confirmed' check (status in ('confirmed', 'released')),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'released') = (released_at is not null)),
  foreign key (operator_id, booking_id) references vs.booking (operator_id, id),
  foreign key (operator_id, booking_cabin_id) references vs.booking_cabin (operator_id, id),
  foreign key (operator_id, leg_id) references vs.leg (operator_id, id),
  foreign key (operator_id, bucket_id) references vs.inventory_bucket (operator_id, id)
);
create index booking_line_bucket_idx on vs.booking_line (bucket_id) where status = 'confirmed';
create index booking_line_booking_idx on vs.booking_line (booking_id) where status = 'confirmed';

create table vs.booking_revision (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  booking_id uuid not null,
  rev integer not null check (rev >= 1),
  quote_id uuid not null,
  sailing_id uuid not null,
  currency char(3) not null,
  total bigint not null,
  net_total bigint not null,
  fee bigint not null default 0 check (fee >= 0),
  snapshot jsonb not null,
  reason text not null,
  actor_type text not null check (actor_type in ('staff', 'channel', 'system')),
  actor_id uuid,
  actor_label text,
  created_at timestamptz not null default now(),
  unique (booking_id, rev),
  foreign key (operator_id, booking_id) references vs.booking (operator_id, id),
  foreign key (operator_id, quote_id) references vs.quote (operator_id, id)
);

-- ---------------------------------------------------------------------------
-- Holds: kind checkout | option | offer | payment. status active → confirmed | expired | released.
-- A payment hold belongs to a booking that waits for its deposit (status held).
-- ---------------------------------------------------------------------------
create table vs.hold (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  channel_id uuid not null,
  contract_id uuid not null,
  quote_id uuid not null,
  booking_id uuid,
  kind text not null check (kind in ('checkout', 'option', 'offer', 'payment')),
  status text not null default 'active' check (status in ('active', 'confirmed', 'expired', 'released')),
  expires_at timestamptz not null,
  ended_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  check ((status = 'active') = (ended_at is null)),
  check (kind not in ('payment', 'offer') or booking_id is not null),
  foreign key (operator_id, channel_id) references vs.channel (operator_id, id),
  foreign key (operator_id, contract_id) references vs.channel_contract (operator_id, id),
  foreign key (operator_id, quote_id) references vs.quote (operator_id, id),
  foreign key (operator_id, booking_id) references vs.booking (operator_id, id)
);
create index hold_expiry_idx on vs.hold (expires_at) where status = 'active';
create index hold_booking_idx on vs.hold (operator_id, booking_id) where booking_id is not null;

create table vs.hold_line (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  hold_id uuid not null,
  leg_id uuid not null,
  category_id uuid not null,
  bucket_id uuid not null,
  n integer not null check (n > 0),
  created_at timestamptz not null default now(),
  unique (hold_id, bucket_id),
  foreign key (operator_id, hold_id) references vs.hold (operator_id, id),
  foreign key (operator_id, leg_id) references vs.leg (operator_id, id),
  foreign key (operator_id, bucket_id) references vs.inventory_bucket (operator_id, id)
);
create index hold_line_bucket_idx on vs.hold_line (bucket_id);

-- An alternative offered for a request; it carries its own hold (spec § Transitions).
create table vs.offer (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  booking_id uuid not null,
  quote_id uuid not null,
  hold_id uuid not null,
  status text not null default 'open' check (status in ('open', 'accepted', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  foreign key (operator_id, booking_id) references vs.booking (operator_id, id),
  foreign key (operator_id, quote_id) references vs.quote (operator_id, id),
  foreign key (operator_id, hold_id) references vs.hold (operator_id, id)
);
create unique index offer_hold_idx on vs.offer (hold_id);

-- ---------------------------------------------------------------------------
-- Guests (rule 9). Passport numbers are AES-256-GCM ciphertext, only ever stored here, with the
-- id of the key that encrypted them so keys can rotate.
-- ---------------------------------------------------------------------------
create table vs.guest (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  booking_id uuid not null,
  booking_cabin_id uuid not null,
  first_name text not null check (length(first_name) between 1 and 100),
  last_name text not null check (length(last_name) between 1 and 100),
  nationality char(2) check (nationality ~ '^[A-Z]{2}$'),
  date_of_birth date,
  passport_ciphertext bytea,
  passport_key_id text,
  lead boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((passport_ciphertext is null) = (passport_key_id is null)),
  foreign key (operator_id, booking_id) references vs.booking (operator_id, id),
  foreign key (operator_id, booking_cabin_id) references vs.booking_cabin (operator_id, id)
);
create unique index guest_lead_idx on vs.guest (booking_id) where lead;
create index guest_booking_idx on vs.guest (operator_id, booking_id);

-- ---------------------------------------------------------------------------
-- RLS, triggers, rights
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'allotment', 'booking', 'booking_cabin', 'booking_line', 'booking_revision', 'hold',
    'hold_line', 'offer', 'guest'
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

revoke delete on vs.allotment, vs.booking, vs.booking_cabin, vs.booking_line, vs.hold, vs.hold_line,
  vs.offer from vs_backoffice, vs_api, vs_worker;
revoke update, delete on vs.booking_revision from vs_backoffice, vs_api, vs_worker;

-- ---------------------------------------------------------------------------
-- Invariants 1, 2 and 3.
--   2. For every bucket: held = sum of active hold lines on it; booked = confirmed booking lines.
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
  ),
  held_lines as (
    select hl.bucket_id, sum(hl.n)::bigint as n
    from vs.hold_line hl join vs.hold h on h.id = hl.hold_id
    where h.status = 'active'
    group by hl.bucket_id
  ),
  booked_lines as (
    select bl.bucket_id, count(*)::bigint as n
    from vs.booking_line bl
    where bl.status = 'confirmed'
    group by bl.bucket_id
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

  select b.operator_id, 2::smallint, 'inventory_bucket', b.id,
         jsonb_build_object(
           'leg_id', b.leg_id, 'category_id', b.category_id, 'kind', b.kind,
           'held', b.held, 'held_lines', coalesce(h.n, 0),
           'booked', b.booked, 'booked_lines', coalesce(k.n, 0))
  from vs.inventory_bucket b
  left join held_lines h on h.bucket_id = b.id
  left join booked_lines k on k.bucket_id = b.id
  where b.held <> coalesce(h.n, 0) or b.booked <> coalesce(k.n, 0)

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
