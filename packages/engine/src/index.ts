// The only write path (rule 1). Apps call these functions; they never query the database.
export { openDatabase, type VsDatabase } from '@vs/db';
export * from './audit';
export * from './invariants';
export * from './staff';
export * from './platform';
export type { EngineContext } from './internal';
export * from './schedule/setup';
export * from './schedule/generate';
export * from './schedule/exceptions';
export { planLegs, chainLegs, cycleStarts, overlapsRange, type ChainLeg } from './schedule/plan';
export * from './inventory/capacity';
export * from './inventory/blocks';
export * from './inventory/availability';
export * from './demo';
export * from './pricing/setup';
export * from './pricing/compute';
export * from './pricing/quote';
export * from './booking/holds';
export * from './booking/requests';
export * from './booking/cancel';
export * from './booking/allotments';
export * from './booking/amendments';
export {
  withRequestKey,
  guestSchema,
  DIETARY,
  GUEST_TITLES,
  OCCASIONS,
  VISA_TYPES,
  type GuestInput,
} from './booking/common';
export * from './booking/payments';
export * from './channel/clients';
export * from './channel/reads';
export * from './channel/webhooks';
export * from './backoffice/reads';
export * from './backoffice/book';
export * from './backoffice/setup-reads';
export * from './backoffice/fleet';
export * from './backoffice/routes';
export * from './backoffice/policies';
export * from './backoffice/plans';
export * from './backoffice/cabin-map';
export * from './backoffice/markets';
export * from './backoffice/channels';
export * from './backoffice/settings';
export * from './backoffice/branding';
export * from './backoffice/checkin';
export * from './analytics/snapshot';
export * from './analytics/reports';
export * from './analytics/breakdowns';
export * from './analytics/exports';
export * from './backoffice/assignment';
export * from './backoffice/manifest';
export * from './documents/requests';
export * from './documents/data';
export * from './backoffice/privacy';
export * from './health';
export * from './backoffice/import';
export * from './backoffice/pilot';
export * from './finance/settings';
export * from './finance/parties';
export * from './finance/invoices';
export * from './finance/documents';
export * from './finance/receipts';
export * from './finance/receivables';
export * from './finance/reports';
export * from './demo-invoicing';
export * from './analytics/money';
export * from './backoffice/operations';
export * from './demo-operations';
