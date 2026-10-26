import type { StaffRole } from '@vs/engine';

/**
 * What each role may do, enforced in every tRPC procedure (never only by hiding buttons).
 * read_only can open every screen and change nothing. onboard (the vessel's reception) sees only
 * Check-in, for its own vessel, with no prices or payments; the vessel is enforced in the engine.
 */
export const PERMISSIONS = {
  /** One's own profile and language. */
  self: ['owner', 'reservations', 'finance', 'read_only', 'onboard'],
  read: ['owner', 'reservations', 'finance', 'read_only'],
  'bookings.write': ['owner', 'reservations'],
  'inventory.write': ['owner', 'reservations'],
  'payments.write': ['owner', 'finance'],
  'documents.create': ['owner', 'reservations', 'finance', 'onboard'],
  /** Manifests, check-in files and registration cards carry passport numbers: only the people who board guests. */
  manifests: ['owner', 'reservations', 'onboard'],
  /** The Check-in screen: departures boarding, guests' details, the reception's marks. */
  'checkin.view': ['owner', 'reservations', 'finance', 'read_only', 'onboard'],
  'checkin.write': ['owner', 'reservations', 'onboard'],
  'guests.assign': ['owner', 'reservations'],
  /** Data subject requests: export or erase one guest's personal data. */
  'guests.privacy': ['owner'],
  /** The pilot dashboard: whether the system is safe to keep running. */
  'pilot.view': ['owner'],
  /** Ships, cabin categories: the company's own setup. */
  'fleet.write': ['owner'],
  'schedule.write': ['owner'],
  'rates.write': ['owner'],
  'channels.write': ['owner'],
  'settings.write': ['owner'],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: StaffRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);
}

/** Roles that must sign in with a second factor (TOTP) before doing anything. */
export const MFA_REQUIRED: readonly StaffRole[] = ['owner', 'finance'];
