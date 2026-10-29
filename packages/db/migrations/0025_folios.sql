-- Extras E1 (docs/folio-plan.md § 3): the price list of extras sold on board, each vessel's folio
-- currency, and the folio (open bill) of each booking cabin with its charges. Charges are
-- append-only: a mistake is undone by a void line, never edited or deleted.

-- Whether a vessel keeps folios, and the one currency its extras are priced and billed in.
alter table vs.vessel
  add column folio_enabled boolean not null default false,
  add column folio_currency char(3) not null default 'USD' check (folio_currency ~ '^[A-Z]{3}$');

-- ---------------------------------------------------------------------------
-- The price list. vessel_id null: sold on every vessel. A price change never touches a charge
-- already posted (the charge keeps its own copy).
-- ---------------------------------------------------------------------------
create table vs.extra_item (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  vessel_id uuid,
  category text not null check (category in ('bar', 'minibar', 'restaurant', 'laundry', 'spa',
    'excursion', 'gratuity', 'communication', 'shop', 'other')),
  name_ar text not null check (length(name_ar) between 1 and 80),
  name_en text not null check (length(name_en) between 1 and 80),
  price bigint not null check (price >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  tax_rate_id uuid,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id),
  foreign key (operator_id, tax_rate_id) references vs.tax_rate (operator_id, id)
);
create index extra_item_vessel_idx on vs.extra_item (operator_id, vessel_id, category, sort_order);
create trigger extra_item_touch before update on vs.extra_item
  for each row execute function vs.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Folios: one per booking cabin (a booking cabin belongs to one sailing). Opened by its first
-- charge; closed (invoice issued) and settled (paid) in E2.
-- ---------------------------------------------------------------------------
create table vs.folio (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  booking_id uuid not null,
  booking_cabin_id uuid not null,
  vessel_id uuid not null,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  bill_to text not null default 'guest' check (bill_to in ('guest', 'agency')),
  status text not null default 'open' check (status in ('open', 'closed', 'settled', 'void')),
  opened_by uuid,
  opened_at timestamptz not null default now(),
  closed_by uuid,
  closed_at timestamptz,
  invoice_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (booking_cabin_id),
  check ((status = 'open') = (closed_at is null)),
  foreign key (operator_id, booking_id) references vs.booking (operator_id, id),
  foreign key (operator_id, booking_cabin_id) references vs.booking_cabin (operator_id, id),
  foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id),
  foreign key (operator_id, opened_by) references vs.staff_user (operator_id, id),
  foreign key (operator_id, closed_by) references vs.staff_user (operator_id, id),
  foreign key (operator_id, invoice_id) references vs.invoice (operator_id, id)
);
create index folio_booking_idx on vs.folio (operator_id, booking_id);
create index folio_open_idx on vs.folio (operator_id, vessel_id) where status = 'open';
create trigger folio_touch before update on vs.folio
  for each row execute function vs.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Charges. The guest is a name copy, not a key: guests are rewritten when a booking's names are
-- edited, and the folio must keep who had what.
-- ---------------------------------------------------------------------------
create table vs.folio_charge (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  folio_id uuid not null,
  extra_item_id uuid,
  guest_name text check (length(guest_name) between 1 and 200),
  category text not null check (category in ('bar', 'minibar', 'restaurant', 'laundry', 'spa',
    'excursion', 'gratuity', 'communication', 'shop', 'other')),
  description_ar text not null check (length(description_ar) between 1 and 200),
  description_en text not null check (length(description_en) between 1 and 200),
  -- Negative on a void line, opposite the charge it voids.
  quantity integer not null check (quantity <> 0 and abs(quantity) <= 999),
  unit_amount bigint not null check (unit_amount >= 0),
  amount bigint not null,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  tax_rate_id uuid,
  tax_name_ar text,
  tax_name_en text,
  tax_bps integer check (tax_bps between 0 and 10000),
  tax_inclusive boolean,
  charged_on date not null,
  note text check (length(note) <= 300),
  voids_charge_id uuid,
  void_reason text check (length(void_reason) between 1 and 300),
  posted_by uuid,
  posted_at timestamptz not null default now(),
  unique (operator_id, id),
  check (amount = quantity * unit_amount),
  check ((voids_charge_id is null) = (quantity > 0)),
  check ((voids_charge_id is null) = (void_reason is null)),
  check ((tax_rate_id is null) = (tax_bps is null)),
  foreign key (operator_id, folio_id) references vs.folio (operator_id, id),
  foreign key (operator_id, extra_item_id) references vs.extra_item (operator_id, id),
  foreign key (operator_id, tax_rate_id) references vs.tax_rate (operator_id, id),
  foreign key (operator_id, voids_charge_id) references vs.folio_charge (operator_id, id),
  foreign key (operator_id, posted_by) references vs.staff_user (operator_id, id)
);
create unique index folio_charge_void_idx on vs.folio_charge (voids_charge_id) where voids_charge_id is not null;
create index folio_charge_folio_idx on vs.folio_charge (operator_id, folio_id, posted_at);

-- Charges go only on an open folio, in its currency; a void only voids a charge of the same folio.
create function vs.folio_charge_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  f record;
begin
  select status, currency into f from vs.folio where id = new.folio_id for share;
  if f.status is distinct from 'open' then
    raise exception 'this folio is closed' using errcode = '42501';
  end if;
  if new.currency <> f.currency then
    raise exception 'a charge must be in the folio currency' using errcode = '23514';
  end if;
  if new.voids_charge_id is not null and not exists (
    select from vs.folio_charge c
    where c.id = new.voids_charge_id and c.folio_id = new.folio_id and c.voids_charge_id is null
      and c.quantity = -new.quantity and c.unit_amount = new.unit_amount
  ) then
    raise exception 'a void must cancel a charge of the same folio exactly' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger folio_charge_guard before insert on vs.folio_charge
  for each row execute function vs.folio_charge_guard();

-- ---------------------------------------------------------------------------
-- Row-level security like every tenant table; only the back office writes any of it.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['extra_item', 'folio', 'folio_charge'] loop
    execute format('alter table vs.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation on vs.%I for all to vs_backoffice, vs_api, vs_worker
         using (operator_id = vs.current_operator_id())
         with check (operator_id = vs.current_operator_id())', t);
  end loop;
end
$$;
revoke delete on vs.extra_item, vs.folio from vs_backoffice, vs_api, vs_worker;
revoke update, delete on vs.folio_charge from vs_backoffice, vs_api, vs_worker;
revoke insert, update, delete on vs.extra_item, vs.folio, vs.folio_charge from vs_api, vs_worker;
