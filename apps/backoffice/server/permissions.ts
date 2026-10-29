import type { StaffRole } from '@vs/engine';

/**
 * What each role may do, enforced in every tRPC procedure (never only by hiding buttons).
 * manager does what reservations does and also runs the setup (fleet, schedule, rates, channels),
 * without company settings, staff, guest privacy or money. read_only can open every screen and change nothing. onboard (the vessel's reception) sees only
 * Check-in, for its own vessel, with no prices or payments; the vessel is enforced in the engine.
 */
export const PERMISSIONS = {
  /** One's own profile and language. */
  self: ['owner', 'manager', 'reservations', 'finance', 'read_only', 'onboard'],
  read: ['owner', 'manager', 'reservations', 'finance', 'read_only'],
  'bookings.write': ['owner', 'manager', 'reservations'],
  'inventory.write': ['owner', 'manager', 'reservations'],
  /** Money in and out: payments, refunds, invoices, credit notes, finance settings. */
  finance: ['owner', 'finance'],
  'documents.create': ['owner', 'manager', 'reservations', 'finance', 'onboard'],
  /** Manifests, check-in files and registration cards carry passport numbers: only the people who board guests. */
  manifests: ['owner', 'manager', 'reservations', 'onboard'],
  /** The Check-in screen: departures boarding, guests' details, the reception's marks. */
  'checkin.view': ['owner', 'manager', 'reservations', 'finance', 'read_only', 'onboard'],
  'checkin.write': ['owner', 'manager', 'reservations', 'onboard'],
  /** Extras on board (E1): see each cabin's folio, and post or void its charges. */
  'folio.view': ['owner', 'manager', 'reservations', 'finance', 'onboard'],
  'folio.write': ['owner', 'finance', 'onboard'],
  /** E2: close a folio (issues its invoice) and take payment for it at reception. */
  'folio.settle': ['owner', 'finance', 'onboard'],
  /** Analytics: occupancy, pace, channels. Money figures need analytics.money as well. */
  'analytics.view': ['owner', 'manager', 'reservations', 'finance', 'read_only'],
  'analytics.money': ['owner', 'finance'],
  'guests.assign': ['owner', 'manager', 'reservations'],
  /** Data subject requests: export or erase one guest's personal data. */
  'guests.privacy': ['owner'],
  /** The pilot dashboard: whether the system is safe to keep running. */
  'pilot.view': ['owner'],
  /** Ships, cabin categories: the company's own setup. */
  'fleet.write': ['owner', 'manager'],
  'schedule.write': ['owner', 'manager'],
  'rates.write': ['owner', 'manager'],
  'channels.write': ['owner', 'manager'],
  'settings.write': ['owner'],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: StaffRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);
}

/** Roles that must sign in with a second factor (TOTP) before doing anything. */
export const MFA_REQUIRED: readonly StaffRole[] = ['owner', 'manager', 'finance'];
