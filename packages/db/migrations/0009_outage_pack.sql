-- Batch 7: the nightly outage pack (spec § Availability: fallback for staff).

-- Where the nightly pack is emailed: the operations inbox, not a person's login.
alter table vs.operator_setting
  add column ops_email text check (ops_email ~ '^[^@\s]+@[^@\s]+$');

-- The pack is a document of its own kind: 14 days of availability and departure manifests.
alter table vs.document drop constraint document_kind_check;
alter table vs.document add constraint document_kind_check check (kind in (
  'voucher', 'itinerary', 'payment_schedule', 'cancellation_terms',
  'manifest', 'rooming_list', 'vacancy_sheet', 'outage_pack'));
