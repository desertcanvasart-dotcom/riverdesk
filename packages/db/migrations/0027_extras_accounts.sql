-- Extras E3 (docs/folio-plan.md § 7): extras sold on board get their own revenue account in the
-- accountant's journal, one for the company and optionally one per vessel (else the vessel's
-- revenue account is used).
alter table vs.account_mapping drop constraint account_mapping_kind_check;
alter table vs.account_mapping add constraint account_mapping_kind_check check (kind in (
  'revenue_vessel', 'revenue_channel', 'revenue_extras', 'tax_payable',
  'receivables', 'cash', 'bank', 'commission'));
alter table vs.account_mapping drop constraint account_mapping_check;
alter table vs.account_mapping add constraint account_mapping_check
  check (ref_id is null or kind in ('revenue_vessel', 'revenue_channel', 'revenue_extras', 'tax_payable'));
