-- Invoicing F1 (docs/invoicing-plan.md § 3, answers taken 2026-10-26): finance settings, tax lines,
-- billing parties, invoices and credit notes with gap-free numbers, and the rule that an issued
-- invoice never changes except through a credit note. Money is bigint minor units.

-- ---------------------------------------------------------------------------
-- The company as issuer. A company without a row uses the defaults.
-- ---------------------------------------------------------------------------
create table vs.finance_setting (
  operator_id uuid primary key references vs.operator (id),
  legal_name_ar text check (length(legal_name_ar) between 1 and 200),
  legal_name_en text check (length(legal_name_en) between 1 and 200),
  address_ar text check (length(address_ar) <= 400),
  address_en text check (length(address_en) <= 400),
  tax_registration_no text check (length(tax_registration_no) between 1 and 40),
  commercial_registration_no text check (length(commercial_registration_no) between 1 and 40),
  base_currency char(3) not null default 'EGP' check (base_currency ~ '^[A-Z]{3}$'),
  invoice_currencies char(3)[] not null default '{EUR,USD,EGP}',
  invoice_prefix text not null default 'INV' check (invoice_prefix ~ '^[A-Z][A-Z0-9]{0,7}$'),
  credit_note_prefix text not null default 'CN' check (credit_note_prefix ~ '^[A-Z][A-Z0-9]{0,7}$'),
  number_digits integer not null default 5 check (number_digits between 3 and 8),
  -- For an operator continuing a paper series: the first number Riverdesk issues each series.
  first_invoice_number integer not null default 1 check (first_invoice_number >= 1),
  first_credit_note_number integer not null default 1 check (first_credit_note_number >= 1),
  default_terms_days integer not null default 14 check (default_terms_days between 0 and 365),
  bank_details_ar text check (length(bank_details_ar) <= 1000),
  bank_details_en text check (length(bank_details_en) <= 1000),
  invoice_note_ar text check (length(invoice_note_ar) <= 1000),
  invoice_note_en text check (length(invoice_note_en) <= 1000),
  -- «مستند تجاري — ليس فاتورة إلكترونية معتمدة من مصلحة الضرائب» on every document.
  eta_footer boolean not null default true,
  -- Egyptian e-invoicing (ETA), for a later integration; nothing uses them yet.
  eta_activity_code text check (length(eta_activity_code) <= 20),
  eta_branch_id text check (length(eta_branch_id) <= 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger finance_setting_touch before update on vs.finance_setting
  for each row execute function vs.touch_updated_at();

-- Each company's tax lines. None by default. At most one active default, applied to booking lines.
create table vs.tax_rate (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  name_ar text not null check (length(name_ar) between 1 and 60),
  name_en text not null check (length(name_en) between 1 and 60),
  rate_bps integer not null check (rate_bps between 0 and 10000),
  inclusive boolean not null default true,
  is_default boolean not null default false,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id)
);
create unique index tax_rate_default_idx on vs.tax_rate (operator_id) where is_default and active;
create trigger tax_rate_touch before update on vs.tax_rate
  for each row execute function vs.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Who an invoice is issued to: an agency (one per channel) or a direct guest.
-- ---------------------------------------------------------------------------
create table vs.billing_party (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  kind text not null check (kind in ('agency', 'guest')),
  channel_id uuid,
  name text not null check (length(name) between 1 and 200),
  legal_name_ar text check (length(legal_name_ar) between 1 and 200),
  legal_name_en text check (length(legal_name_en) between 1 and 200),
  address text check (length(address) <= 400),
  tax_registration_no text check (length(tax_registration_no) between 1 and 40),
  commercial_registration_no text check (length(commercial_registration_no) between 1 and 40),
  email text check (email ~ '^[^@\s]+@[^@\s]+$'),
  phone text check (length(phone) between 3 and 30),
  country char(2) check (country ~ '^[A-Z]{2}$'),
  -- ETA receiver type: B business, P person, F foreigner.
  eta_party_type text check (eta_party_type in ('B', 'P', 'F')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  check ((kind = 'agency') = (channel_id is not null)),
  foreign key (operator_id, channel_id) references vs.channel (operator_id, id)
);
create unique index billing_party_channel_idx on vs.billing_party (operator_id, channel_id) where kind = 'agency';
create trigger billing_party_touch before update on vs.billing_party
  for each row execute function vs.touch_updated_at();

-- Contract terms invoicing uses: days to pay an invoice, and what an over-limit booking does.
alter table vs.channel_contract
  add column credit_terms_days integer check (credit_terms_days between 0 and 365),
  add column credit_limit_mode text not null default 'block' check (credit_limit_mode in ('warn', 'block')),
  add column contract_ref text check (length(contract_ref) between 1 and 60);

-- ---------------------------------------------------------------------------
-- Gap-free numbering: one counter per company, series and year, taken under a row lock in the
-- transaction that issues the document, so a rolled-back issue leaves no gap.
-- ---------------------------------------------------------------------------
create table vs.document_counter (
  operator_id uuid not null references vs.operator (id),
  series text not null check (series in ('invoice', 'credit_note')),
  year integer not null check (year between 2000 and 2999),
  last_seq integer not null check (last_seq >= 0),
  primary key (operator_id, series, year)
);

-- ---------------------------------------------------------------------------
-- Invoices, proformas and credit notes (one table). A proforma has no number and stays a draft;
-- an invoice or credit note gets its number when issued and never changes afterwards except its
-- status and the amounts paid and credited, which the engine maintains.
-- ---------------------------------------------------------------------------
create table vs.invoice (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  type text not null check (type in ('proforma', 'invoice', 'credit_note')),
  status text not null default 'draft'
    check (status in ('draft', 'issued', 'partially_paid', 'paid', 'cancelled')),
  series text check (series in ('invoice', 'credit_note')),
  year integer,
  seq integer check (seq >= 1),
  number text,
  billing_party_id uuid not null,
  party_snapshot jsonb,
  issuer_snapshot jsonb,
  credits_invoice_id uuid,
  credit_reason text check (length(credit_reason) between 1 and 500),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  base_currency char(3) not null check (base_currency ~ '^[A-Z]{3}$'),
  -- 1 unit of currency = fx_rate units of base currency, when they differ (≤ 6 decimals).
  fx_rate text check (fx_rate ~ '^[0-9]+(\.[0-9]{1,6})?$'),
  fx_source text check (length(fx_source) between 1 and 100),
  fx_date date,
  issue_date date,
  due_date date,
  subtotal bigint not null default 0,
  tax_total bigint not null default 0,
  total bigint not null default 0,
  amount_credited bigint not null default 0 check (amount_credited >= 0),
  amount_paid bigint not null default 0,
  notes text check (length(notes) <= 2000),
  locale text not null default 'ar' check (locale in ('ar', 'en', 'both')),
  -- ETA (later): nothing uses these yet.
  eta_uuid text,
  eta_submission_status text,
  eta_submitted_at timestamptz,
  eta_long_id text,
  created_by uuid,
  issued_by uuid,
  issued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, number),
  check (type <> 'proforma' or (status = 'draft' and number is null)),
  check ((status = 'draft') = (number is null)),
  check ((number is null) = (seq is null) and (seq is null) = (series is null) and (series is null) = (year is null)),
  check (status = 'draft' or (issue_date is not null and issued_at is not null and party_snapshot is not null)),
  check ((type = 'credit_note') = (credits_invoice_id is not null)),
  check (type <> 'credit_note' or credit_reason is not null),
  check (currency = base_currency or status = 'draft' or fx_rate is not null),
  check (series is null or series = case type when 'credit_note' then 'credit_note' else 'invoice' end),
  foreign key (operator_id, billing_party_id) references vs.billing_party (operator_id, id),
  foreign key (operator_id, credits_invoice_id) references vs.invoice (operator_id, id),
  foreign key (operator_id, created_by) references vs.staff_user (operator_id, id),
  foreign key (operator_id, issued_by) references vs.staff_user (operator_id, id)
);
create index invoice_party_idx on vs.invoice (operator_id, billing_party_id, status);
create index invoice_due_idx on vs.invoice (operator_id, due_date) where status in ('issued', 'partially_paid');
create index invoice_credits_idx on vs.invoice (operator_id, credits_invoice_id) where credits_invoice_id is not null;
create trigger invoice_touch before update on vs.invoice
  for each row execute function vs.touch_updated_at();

create table vs.invoice_line (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  invoice_id uuid not null,
  seq integer not null check (seq >= 0),
  kind text not null check (kind in ('cabin', 'fee', 'penalty', 'commission', 'manual')),
  booking_id uuid,
  booking_cabin_id uuid,
  description_ar text not null check (length(description_ar) between 1 and 300),
  description_en text not null check (length(description_en) between 1 and 300),
  quantity integer not null default 1 check (quantity >= 1),
  unit_amount bigint not null,
  -- quantity × unit_amount; negative for a deduction such as an agency's commission.
  amount bigint not null,
  tax_rate_id uuid,
  tax_name_ar text,
  tax_name_en text,
  tax_bps integer check (tax_bps between 0 and 10000),
  tax_inclusive boolean,
  tax_amount bigint not null default 0,
  -- ETA (later).
  item_code text,
  item_type text,
  unit_type text,
  created_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (invoice_id, seq),
  check (amount = quantity * unit_amount),
  check ((tax_bps is null) = (tax_inclusive is null)),
  check (kind = 'manual' or booking_id is not null),
  foreign key (operator_id, invoice_id) references vs.invoice (operator_id, id) on delete cascade,
  foreign key (operator_id, booking_id) references vs.booking (operator_id, id),
  foreign key (operator_id, booking_cabin_id) references vs.booking_cabin (operator_id, id),
  foreign key (operator_id, tax_rate_id) references vs.tax_rate (operator_id, id)
);
create index invoice_line_booking_idx on vs.invoice_line (operator_id, booking_id) where booking_id is not null;

-- ---------------------------------------------------------------------------
-- An issued invoice is final: the database itself refuses any other change, whoever asks.
-- ---------------------------------------------------------------------------
create function vs.invoice_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'an issued % cannot be deleted', old.type using errcode = '42501';
    end if;
    return old;
  end if;
  if old.status <> 'draft' and (
       new.type, new.series, new.year, new.seq, new.number, new.billing_party_id, new.party_snapshot,
       new.issuer_snapshot, new.credits_invoice_id, new.credit_reason, new.currency, new.base_currency,
       new.fx_rate, new.fx_source, new.fx_date, new.issue_date, new.due_date, new.subtotal,
       new.tax_total, new.total, new.notes, new.locale, new.issued_by, new.issued_at, new.created_by)
     is distinct from (
       old.type, old.series, old.year, old.seq, old.number, old.billing_party_id, old.party_snapshot,
       old.issuer_snapshot, old.credits_invoice_id, old.credit_reason, old.currency, old.base_currency,
       old.fx_rate, old.fx_source, old.fx_date, old.issue_date, old.due_date, old.subtotal,
       old.tax_total, old.total, old.notes, old.locale, old.issued_by, old.issued_at, old.created_by)
  then
    raise exception 'issued % % cannot be changed; issue a credit note', old.type, old.number
      using errcode = '42501';
  end if;
  if old.status <> 'draft' and new.status = 'draft' then
    raise exception 'an issued % cannot return to draft', old.type using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger invoice_guard before update or delete on vs.invoice
  for each row execute function vs.invoice_guard();

create function vs.invoice_line_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select i.status into v_status from vs.invoice i
  where i.id = case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end;
  -- A cascade from deleting a draft finds no parent left; that is allowed.
  if v_status is not null and v_status <> 'draft' then
    raise exception 'lines of an issued invoice cannot change' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
create trigger invoice_line_guard before insert or update or delete on vs.invoice_line
  for each row execute function vs.invoice_line_guard();

-- ---------------------------------------------------------------------------
-- Row-level security like every tenant table.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['finance_setting', 'tax_rate', 'billing_party', 'document_counter',
                           'invoice', 'invoice_line'] loop
    execute format('alter table vs.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation on vs.%I for all to vs_backoffice, vs_api, vs_worker
         using (operator_id = vs.current_operator_id())
         with check (operator_id = vs.current_operator_id())', t);
  end loop;
end
$$;
revoke delete on vs.finance_setting, vs.document_counter, vs.billing_party from vs_backoffice, vs_api, vs_worker;
revoke update, delete on vs.tax_rate from vs_api, vs_worker;
-- The channel API writes none of this (a scoped read API may come later; question 13).
revoke insert, update, delete on vs.finance_setting, vs.tax_rate, vs.billing_party, vs.document_counter,
  vs.invoice, vs.invoice_line from vs_api;
