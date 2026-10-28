-- Invoicing F5 (docs/invoicing-plan.md § 3.1, § 3.6, § 4): the company's account codes for the
-- accountant's journal, and finance reports and accountant exports as documents (Excel or CSV).

-- One code per kind, and per vessel, channel or tax rate where the kind takes one (ref_id null:
-- the default for that kind). Blank until the company fills it in.
create table vs.account_mapping (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  kind text not null check (kind in ('revenue_vessel', 'revenue_channel', 'tax_payable',
                                     'receivables', 'cash', 'bank', 'commission')),
  ref_id uuid,
  code text not null check (length(code) between 1 and 30),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique nulls not distinct (operator_id, kind, ref_id),
  check (ref_id is null or kind in ('revenue_vessel', 'revenue_channel', 'tax_payable'))
);
create trigger account_mapping_touch before update on vs.account_mapping
  for each row execute function vs.touch_updated_at();
alter table vs.account_mapping enable row level security;
create policy tenant_isolation on vs.account_mapping for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());
revoke insert, update, delete on vs.account_mapping from vs_api, vs_worker;

alter table vs.document drop constraint document_kind_check;
alter table vs.document add constraint document_kind_check check (kind in (
  'voucher', 'itinerary', 'payment_schedule', 'cancellation_terms',
  'manifest', 'rooming_list', 'vacancy_sheet', 'outage_pack',
  'embarkation_sheet', 'checkin_file', 'registration_cards', 'analytics_export',
  'invoice', 'invoice_register', 'statement', 'aging', 'finance_report', 'accountant_export'));
alter table vs.document drop constraint document_format_check;
alter table vs.document add constraint document_format_check check (format in ('pdf', 'xlsx', 'png', 'csv'));
