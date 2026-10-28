-- Invoicing F4: a party's statement (PDF or workbook) and the receivables aging (workbook).
alter table vs.document drop constraint document_kind_check;
alter table vs.document add constraint document_kind_check check (kind in (
  'voucher', 'itinerary', 'payment_schedule', 'cancellation_terms',
  'manifest', 'rooming_list', 'vacancy_sheet', 'outage_pack',
  'embarkation_sheet', 'checkin_file', 'registration_cards', 'analytics_export',
  'invoice', 'invoice_register', 'statement', 'aging'));
alter table vs.document drop constraint document_entity_check;
alter table vs.document add constraint document_entity_check
  check (entity in ('booking', 'leg', 'vessel', 'operator', 'invoice', 'billing_party'));
