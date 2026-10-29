-- Extras E2 (docs/folio-plan.md § 3 and § 5): closing a folio issues an invoice with `extra`
-- lines (not tied to the booking, so the booking's own invoice is never blocked), paid at
-- reception through receipts or billed to the agency where its contract allows; the guest folio
-- and the purser's shift report.

alter table vs.invoice_line drop constraint invoice_line_kind_check;
alter table vs.invoice_line add constraint invoice_line_kind_check
  check (kind in ('cabin', 'fee', 'penalty', 'commission', 'manual', 'extra'));
alter table vs.invoice_line drop constraint invoice_line_check2;
alter table vs.invoice_line add constraint invoice_line_check2
  check (kind in ('manual', 'extra') or booking_id is not null);

-- Whether an agency agrees to pay the extras of its guests (off by default: guests pay on board).
alter table vs.channel_contract
  add column folio_to_agency boolean not null default false;

-- Paid or not is read from the folio's invoice, so a folio is only open, closed or void
-- (closed with nothing to bill).
alter table vs.folio drop constraint folio_status_check;
alter table vs.folio add constraint folio_status_check check (status in ('open', 'closed', 'void'));
alter table vs.folio add constraint folio_invoice_check
  check ((status = 'closed') = (invoice_id is not null));
create unique index folio_invoice_idx on vs.folio (invoice_id) where invoice_id is not null;

alter table vs.document drop constraint document_kind_check;
alter table vs.document add constraint document_kind_check check (kind in (
  'voucher', 'itinerary', 'payment_schedule', 'cancellation_terms',
  'manifest', 'rooming_list', 'vacancy_sheet', 'outage_pack',
  'embarkation_sheet', 'checkin_file', 'registration_cards', 'analytics_export',
  'invoice', 'invoice_register', 'statement', 'aging', 'finance_report', 'accountant_export',
  'predeparture', 'diet_list', 'occasion_list', 'door_cards', 'disembarkation_list',
  'daily_programme',
  'transfer_voucher', 'boarding_pass', 'luggage_tags', 'excursion_list', 'table_plan',
  'muster_list', 'feedback_forms', 'housekeeping_sheet',
  'guest_folio', 'folio_shift_report'));

-- The guest folio is a document of the folio itself.
alter table vs.document drop constraint document_entity_check;
alter table vs.document add constraint document_entity_check
  check (entity in ('booking', 'leg', 'vessel', 'operator', 'invoice', 'billing_party', 'folio'));
