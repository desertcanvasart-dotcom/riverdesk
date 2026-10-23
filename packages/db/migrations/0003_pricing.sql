-- Batch 2: seasons, policies, rate plans, rates, supplements, channels, contracts, quotes.
-- Money is bigint minor units with a char(3) currency (rule 10). Percentages are basis points
-- (2500 = 25%).

-- ---------------------------------------------------------------------------
-- Seasons: the season of the embark date prices the whole sailing.
-- ---------------------------------------------------------------------------
create table vs.season (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  code text not null check (code ~ '^[A-Z][A-Z0-9_]{0,15}$'),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, vessel_id, id),
  unique (operator_id, vessel_id, code),
  foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id)
);

create table vs.season_period (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  season_id uuid not null,
  during daterange not null check (not isempty(during) and not lower_inf(during) and not upper_inf(during)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (operator_id, vessel_id, season_id) references vs.season (operator_id, vessel_id, id),
  -- One season per date on a vessel.
  exclude using gist (vessel_id with =, during with &&)
);

-- ---------------------------------------------------------------------------
-- Policies (snapshotted onto quotes and bookings; editing them never changes a booking).
-- ---------------------------------------------------------------------------
create table vs.child_policy (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  name text not null,
  adult_from_age integer not null default 12 check (adult_from_age between 1 and 18),
  max_children_per_cabin integer not null default 2 check (max_children_per_cabin between 0 and 6),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id)
);

-- Bands cover ages 0 .. adult_from_age - 1 without gaps (checked by the engine).
-- requires_two_adults: the band price applies only when the cabin has two or more adults;
-- otherwise the child pays the adult rate (docs/decisions.md, child policy).
create table vs.child_policy_band (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  child_policy_id uuid not null,
  age_from integer not null check (age_from >= 0),
  age_to integer not null,
  basis text not null check (basis in ('free', 'percent_of_adult', 'fixed', 'included')),
  percent_bps integer check (percent_bps between 0 and 10000),
  fixed_amount bigint check (fixed_amount >= 0),
  fixed_currency char(3) check (fixed_currency ~ '^[A-Z]{3}$'),
  requires_two_adults boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (age_to >= age_from),
  check ((basis = 'percent_of_adult') = (percent_bps is not null)),
  check ((basis = 'fixed') = (fixed_amount is not null and fixed_currency is not null)),
  foreign key (operator_id, child_policy_id) references vs.child_policy (operator_id, id)
);

create table vs.cancellation_policy (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id)
);

-- Penalty when cancelling `from_days` or more days before embarkation (Cairo dates); the rule
-- with the largest from_days not above the actual days applies. A rule with from_days 0 exists.
create table vs.cancellation_rule (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  cancellation_policy_id uuid not null,
  from_days integer not null check (from_days >= 0),
  penalty_bps integer not null check (penalty_bps between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cancellation_policy_id, from_days),
  foreign key (operator_id, cancellation_policy_id) references vs.cancellation_policy (operator_id, id)
);

-- Optional fees for amendments (operator unsure; default none). Used from Batch 3.
create table vs.amendment_fee_rule (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  cancellation_policy_id uuid not null,
  change_kind text not null check (change_kind in ('any', 'date', 'category', 'occupancy', 'cabins', 'guests')),
  from_days integer not null default 0 check (from_days >= 0),
  fee_kind text not null check (fee_kind in ('flat', 'percent')),
  amount bigint check (amount >= 0),
  currency char(3) check (currency ~ '^[A-Z]{3}$'),
  percent_bps integer check (percent_bps between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((fee_kind = 'flat') = (amount is not null and currency is not null)),
  check ((fee_kind = 'percent') = (percent_bps is not null)),
  foreign key (operator_id, cancellation_policy_id) references vs.cancellation_policy (operator_id, id)
);

create table vs.payment_policy (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  name text not null,
  deposit_bps integer not null default 2500 check (deposit_bps between 0 and 10000),
  balance_due_days integer not null default 30 check (balance_due_days >= 0),
  bank_transfer_hold_hours integer not null default 24 check (bank_transfer_hold_hours > 0),
  card_hold_minutes integer not null default 30 check (card_hold_minutes > 0),
  auto_cancel_overdue boolean not null default false,
  auto_cancel_after_days integer check (auto_cancel_after_days >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  check (not auto_cancel_overdue or auto_cancel_after_days is not null)
);

-- ---------------------------------------------------------------------------
-- Rate plans and rates
-- ---------------------------------------------------------------------------
create table vs.rate_plan (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  code text not null check (code ~ '^[A-Z][A-Z0-9_-]{0,23}$'),
  name text not null,
  market text not null check (market ~ '^[a-z][a-z_]{1,31}$'),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  board text not null default 'full_board',
  pricing_unit text not null check (pricing_unit in ('per_person', 'per_cabin')),
  pricing_period text not null check (pricing_period in ('per_night', 'per_package')),
  min_nights integer not null default 1 check (min_nights >= 1),
  child_policy_id uuid not null,
  cancellation_policy_id uuid not null,
  payment_policy_id uuid not null,
  inclusions jsonb not null default '{}'::jsonb,
  exclusions jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, vessel_id, id),
  unique (operator_id, vessel_id, code),
  foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id),
  foreign key (operator_id, child_policy_id) references vs.child_policy (operator_id, id),
  foreign key (operator_id, cancellation_policy_id) references vs.cancellation_policy (operator_id, id),
  foreign key (operator_id, payment_policy_id) references vs.payment_policy (operator_id, id)
);

-- Per-person rates have a basis (single / double / triple: the price per person when that many
-- people pay adult rate); per-cabin rates have none. Package rates name the sailing pattern.
create table vs.rate (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid not null,
  rate_plan_id uuid not null,
  category_id uuid not null,
  season_id uuid not null,
  sailing_pattern_id uuid,
  basis text check (basis in ('single', 'double', 'triple')),
  amount bigint not null check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (operator_id, vessel_id, rate_plan_id) references vs.rate_plan (operator_id, vessel_id, id),
  foreign key (operator_id, vessel_id, category_id) references vs.cabin_category (operator_id, vessel_id, id),
  foreign key (operator_id, vessel_id, season_id) references vs.season (operator_id, vessel_id, id),
  foreign key (operator_id, sailing_pattern_id) references vs.sailing_pattern (operator_id, id)
);
create unique index rate_key_idx on vs.rate (
  rate_plan_id, category_id, season_id,
  coalesce(sailing_pattern_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(basis, '-')
);

-- Charged once for every night of a sailing that falls in [date_from, date_to]; nights run from
-- the embark date to the day before disembarkation. Gala dinners are one-day ranges.
create table vs.supplement (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  rate_plan_id uuid not null,
  code text not null check (code ~ '^[A-Z][A-Z0-9_-]{0,23}$'),
  kind text not null check (kind in ('gala', 'peak', 'other')),
  name_en text not null,
  name_ar text not null,
  date_from date not null,
  date_to date not null,
  amount_adult bigint not null check (amount_adult >= 0),
  amount_child bigint not null check (amount_child >= 0),
  mandatory boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (date_to >= date_from),
  unique (rate_plan_id, code),
  foreign key (operator_id, rate_plan_id) references vs.rate_plan (operator_id, id)
);
create index supplement_plan_dates_idx on vs.supplement (rate_plan_id, date_from, date_to);

-- ---------------------------------------------------------------------------
-- Channels and contracts
-- ---------------------------------------------------------------------------
create table vs.channel (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  code text not null check (code ~ '^[a-z][a-z0-9_-]{1,31}$'),
  name text not null,
  type text not null check (type in ('back_office', 'agent', 'portal', 'api')),
  credit_allowed boolean not null default false,
  credit_limit bigint check (credit_limit >= 0),
  credit_currency char(3) check (credit_currency ~ '^[A-Z]{3}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, code),
  check (not credit_allowed or (credit_limit is not null and credit_currency is not null))
);
-- One back-office channel per operator: phone, WhatsApp and walk-in bookings.
create unique index channel_back_office_idx on vs.channel (operator_id) where type = 'back_office';

create table vs.channel_contract (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  channel_id uuid not null,
  vessel_id uuid not null,
  allocation text not null check (allocation in ('pool', 'allotment', 'on_request')),
  payment_mode text not null check (payment_mode in ('channel_collected', 'vessel_prepaid', 'credit')),
  price_adjustment text not null default 'none' check (price_adjustment in ('none', 'markup', 'commission')),
  adjustment_bps integer not null default 0 check (adjustment_bps between 0 and 10000),
  visible_free_cap integer check (visible_free_cap >= 0),
  checkout_hold_minutes integer not null default 30 check (checkout_hold_minutes > 0),
  option_hold_hours integer not null default 72 check (option_hold_hours > 0),
  request_sla_hours integer not null default 6 check (request_sla_hours > 0),
  stop_sell boolean not null default false,
  valid_from date not null,
  valid_to date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  check (valid_to is null or valid_to >= valid_from),
  check (price_adjustment <> 'none' or adjustment_bps = 0),
  foreign key (operator_id, channel_id) references vs.channel (operator_id, id),
  foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id)
);
-- At most one active contract per channel and vessel.
create unique index channel_contract_active_idx on vs.channel_contract (channel_id, vessel_id) where active;

create table vs.channel_contract_category (
  operator_id uuid not null references vs.operator (id),
  contract_id uuid not null,
  category_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (contract_id, category_id),
  foreign key (operator_id, contract_id) references vs.channel_contract (operator_id, id),
  foreign key (operator_id, category_id) references vs.cabin_category (operator_id, id)
);

create table vs.channel_contract_rate_plan (
  operator_id uuid not null references vs.operator (id),
  contract_id uuid not null,
  rate_plan_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (contract_id, rate_plan_id),
  foreign key (operator_id, contract_id) references vs.channel_contract (operator_id, id),
  foreign key (operator_id, rate_plan_id) references vs.rate_plan (operator_id, id)
);

-- The scope of an idempotency key is a channel (back office included).
alter table vs.idempotency_key
  add foreign key (operator_id, scope_id) references vs.channel (operator_id, id);

-- ---------------------------------------------------------------------------
-- Quotes: an immutable priced offer. Lines and policies are frozen at creation, so later rate
-- or policy changes never affect it (spec § Pricing).
-- ---------------------------------------------------------------------------
create table vs.quote (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  channel_id uuid not null,
  contract_id uuid not null,
  vessel_id uuid not null,
  sailing_id uuid not null,
  rate_plan_id uuid not null,
  season_id uuid not null,
  market text not null,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  cabins jsonb not null check (jsonb_typeof(cabins) = 'array'),
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  total bigint not null check (total >= 0),
  net_total bigint not null check (net_total >= 0),
  policies jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (operator_id, id),
  foreign key (operator_id, channel_id) references vs.channel (operator_id, id),
  foreign key (operator_id, contract_id) references vs.channel_contract (operator_id, id),
  foreign key (operator_id, vessel_id, sailing_id) references vs.sailing (operator_id, vessel_id, id),
  foreign key (operator_id, vessel_id, rate_plan_id) references vs.rate_plan (operator_id, vessel_id, id),
  foreign key (operator_id, vessel_id, season_id) references vs.season (operator_id, vessel_id, id)
);
create index quote_expiry_idx on vs.quote (operator_id, expires_at);

-- ---------------------------------------------------------------------------
-- RLS, triggers, rights
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'season', 'season_period', 'child_policy', 'child_policy_band', 'cancellation_policy',
    'cancellation_rule', 'amendment_fee_rule', 'payment_policy', 'rate_plan', 'rate',
    'supplement', 'channel', 'channel_contract', 'channel_contract_category',
    'channel_contract_rate_plan', 'quote'
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

-- Quotes are immutable once written.
revoke update, delete on vs.quote from vs_backoffice, vs_api, vs_worker;
