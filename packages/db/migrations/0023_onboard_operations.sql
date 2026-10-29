-- Documents D3 (docs/documents-plan.md § 5): on-board operations. What the new documents need
-- that was not stored yet: when guests fly home, each vessel's boarding and meal times, where a
-- vessel berths and what guests visit at each port, and the company's pre-departure texts.

-- Leaving Egypt, for the disembarkation and transfer list (all optional, like arrival).
alter table vs.guest
  add column departure_date date,
  add column departure_flight text check (length(departure_flight) between 1 and 20),
  add column departure_time time;

-- The vessel's day: boarding opens, meals, luggage out and check-out on the last morning.
alter table vs.vessel
  add column boarding_time time,
  add column breakfast_time time,
  add column lunch_time time,
  add column tea_time time,
  add column dinner_time time,
  add column luggage_time time,
  add column checkout_time time,
  add column programme_note_ar text check (length(programme_note_ar) <= 1000),
  add column programme_note_en text check (length(programme_note_en) <= 1000);

-- Where the vessel berths (for the guest's pre-departure sheet) and what guests visit there (the
-- daily programme).
alter table vs.port
  add column berth_ar text check (length(berth_ar) <= 300),
  add column berth_en text check (length(berth_en) <= 300),
  add column visits_ar text check (length(visits_ar) <= 600),
  add column visits_en text check (length(visits_en) <= 600);

-- The company's pre-departure texts; a company without a row gets the standard wording.
create table vs.guest_info_setting (
  operator_id uuid primary key references vs.operator (id),
  what_to_bring_ar text check (length(what_to_bring_ar) <= 1500),
  what_to_bring_en text check (length(what_to_bring_en) <= 1500),
  dress_code_ar text check (length(dress_code_ar) <= 800),
  dress_code_en text check (length(dress_code_en) <= 800),
  documents_ar text check (length(documents_ar) <= 800),
  documents_en text check (length(documents_en) <= 800),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger guest_info_setting_touch before update on vs.guest_info_setting
  for each row execute function vs.touch_updated_at();
alter table vs.guest_info_setting enable row level security;
create policy tenant_isolation on vs.guest_info_setting for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());
revoke delete on vs.guest_info_setting from vs_backoffice, vs_api, vs_worker;
revoke insert, update on vs.guest_info_setting from vs_api, vs_worker;

alter table vs.document drop constraint document_kind_check;
alter table vs.document add constraint document_kind_check check (kind in (
  'voucher', 'itinerary', 'payment_schedule', 'cancellation_terms',
  'manifest', 'rooming_list', 'vacancy_sheet', 'outage_pack',
  'embarkation_sheet', 'checkin_file', 'registration_cards', 'analytics_export',
  'invoice', 'invoice_register', 'statement', 'aging', 'finance_report', 'accountant_export',
  'predeparture', 'diet_list', 'occasion_list', 'door_cards', 'disembarkation_list',
  'daily_programme'));
