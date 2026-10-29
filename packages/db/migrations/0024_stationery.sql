-- Documents D4 (docs/documents-plan.md § 5): the remaining stationery. What it needs that was not
-- stored yet: a guest's preferred language (for guide groups; else read from nationality), and
-- each vessel's muster station per deck and restaurant table size.

alter table vs.guest
  add column language char(2) check (language ~ '^[a-z]{2}$');

alter table vs.vessel
  -- {"Upper": "Muster station A, sun deck aft", ...}
  add column muster_stations jsonb not null default '{}' check (jsonb_typeof(muster_stations) = 'object'),
  add column table_size integer not null default 4 check (table_size between 2 and 12);

alter table vs.document drop constraint document_kind_check;
alter table vs.document add constraint document_kind_check check (kind in (
  'voucher', 'itinerary', 'payment_schedule', 'cancellation_terms',
  'manifest', 'rooming_list', 'vacancy_sheet', 'outage_pack',
  'embarkation_sheet', 'checkin_file', 'registration_cards', 'analytics_export',
  'invoice', 'invoice_register', 'statement', 'aging', 'finance_report', 'accountant_export',
  'predeparture', 'diet_list', 'occasion_list', 'door_cards', 'disembarkation_list',
  'daily_programme',
  'transfer_voucher', 'boarding_pass', 'luggage_tags', 'excursion_list', 'table_plan',
  'muster_list', 'feedback_forms', 'housekeeping_sheet'));
