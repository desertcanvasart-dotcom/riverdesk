-- Analytics A1.1 (agreed 2026-10-26): a nightly snapshot of what is on the books for every
-- upcoming departure and sailing, so booking pace can be compared night by night and with the
-- same calendar date a year earlier. History the snapshot does not record cannot be recovered
-- later. Rows are written once a night (re-running a night overwrites it) and kept.

-- Capacity and sales by departure and cabin category, as they stood that night.
create table vs.analytics_leg_day (
  operator_id uuid not null references vs.operator (id),
  snapshot_date date not null,
  leg_id uuid not null,
  category_id uuid not null,
  depart_date date not null,
  -- Cabins on sale: the pool and agency allotments (blocked cabins are not on sale).
  capacity integer not null check (capacity >= 0),
  booked integer not null check (booked >= 0),
  held integer not null check (held >= 0),
  blocked integer not null check (blocked >= 0),
  -- In an agency's allotment, not yet sold or released back.
  allotted_unsold integer not null check (allotted_unsold >= 0),
  stop_sale boolean not null default false,
  -- Rebuilt from booking dates for nights before the snapshot existed: holds, blocks and
  -- amendments of those nights are not known.
  reconstructed boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (operator_id, snapshot_date, leg_id, category_id),
  foreign key (operator_id, leg_id) references vs.leg (operator_id, id),
  foreign key (operator_id, category_id) references vs.cabin_category (operator_id, id)
);
create index analytics_leg_day_leg_idx on vs.analytics_leg_day (operator_id, leg_id, snapshot_date);
create index analytics_leg_day_depart_idx on vs.analytics_leg_day (operator_id, depart_date, snapshot_date);

-- What was booked for each sailing that night, by channel, market and currency (money is never
-- added across currencies).
create table vs.analytics_sailing_day (
  operator_id uuid not null references vs.operator (id),
  snapshot_date date not null,
  sailing_id uuid not null,
  embark_date date not null,
  channel_id uuid not null,
  market text not null,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  bookings integer not null check (bookings >= 0),
  cabins integer not null check (cabins >= 0),
  guests integer not null check (guests >= 0),
  cabin_nights integer not null check (cabin_nights >= 0),
  -- Minor units: the guests' price and what the company keeps after commission.
  value_total bigint not null check (value_total >= 0),
  value_net bigint not null check (value_net >= 0),
  requests_open integer not null default 0 check (requests_open >= 0),
  holds_open integer not null default 0 check (holds_open >= 0),
  reconstructed boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (operator_id, snapshot_date, sailing_id, channel_id, market, currency),
  foreign key (operator_id, sailing_id) references vs.sailing (operator_id, id),
  foreign key (operator_id, channel_id) references vs.channel (operator_id, id)
);
create index analytics_sailing_day_sailing_idx on vs.analytics_sailing_day (operator_id, sailing_id, snapshot_date);
create index analytics_sailing_day_embark_idx on vs.analytics_sailing_day (operator_id, embark_date, snapshot_date);

do $$
declare
  t text;
begin
  foreach t in array array['analytics_leg_day', 'analytics_sailing_day'] loop
    execute format('alter table vs.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation on vs.%I for all to vs_backoffice, vs_api, vs_worker
         using (operator_id = vs.current_operator_id())
         with check (operator_id = vs.current_operator_id())', t);
    -- The worker writes and rewrites a night; nobody else changes history.
    execute format('revoke insert, update, delete on vs.%I from vs_backoffice, vs_api', t);
  end loop;
end
$$;
