-- Analytics A1.3: each Analytics tab exports to Excel through the document worker, like every
-- other document (queued, audited, expiring after a week). An export covers the whole company,
-- so its entity is the operator itself; its filters are in params.
alter table vs.document drop constraint document_kind_check;
alter table vs.document add constraint document_kind_check check (kind in (
  'voucher', 'itinerary', 'payment_schedule', 'cancellation_terms',
  'manifest', 'rooming_list', 'vacancy_sheet', 'outage_pack',
  'embarkation_sheet', 'checkin_file', 'registration_cards', 'analytics_export'));
alter table vs.document drop constraint document_entity_check;
alter table vs.document add constraint document_entity_check
  check (entity in ('booking', 'leg', 'vessel', 'operator'));
