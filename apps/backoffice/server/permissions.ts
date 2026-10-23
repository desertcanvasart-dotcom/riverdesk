import type { StaffRole } from '@vs/engine';

/**
 * What each role may do, enforced in every tRPC procedure (never only by hiding buttons).
 * read_only can open every screen and change nothing.
 */
export const PERMISSIONS = {
  read: ['owner', 'reservations', 'finance', 'read_only'],
  'bookings.write': ['owner', 'reservations'],
  'inventory.write': ['owner', 'reservations'],
  'payments.write': ['owner', 'finance'],
  'documents.create': ['owner', 'reservations', 'finance'],
  /** Manifests carry passport numbers: only the people who board guests. */
  manifests: ['owner', 'reservations'],
  'guests.assign': ['owner', 'reservations'],
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
