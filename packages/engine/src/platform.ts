import { sql } from 'kysely';
import type { VsDatabase } from '@vs/db';

/**
 * Platform area (agreed 2026-10-24): the platform owner adds companies and sees them with counts
 * only. Every call goes through an allow-listed SECURITY DEFINER function that checks the
 * caller's verified email against platform.admin first. Back office only.
 */
export interface PlatformCompany {
  id: string;
  name: string;
  slug: string;
  bookingRefPrefix: string | null;
  createdAt: Date;
  ownerActive: boolean;
  openInvitations: number;
  staff: number;
  vessels: number;
  bookings: number;
}

export interface NewPlatformCompany {
  name: string;
  slug: string;
  bookingRefPrefix: string;
  ownerEmail: string;
  ownerName: string;
  locale: 'ar' | 'en';
}

export async function isPlatformAdmin(db: VsDatabase, verifiedEmail: string): Promise<boolean> {
  const { rows } = await db.withLookupTx((tx) =>
    sql<{ ok: boolean }>`select vs.platform_is_admin(${verifiedEmail}) as ok`.execute(tx),
  );
  return rows[0]?.ok === true;
}

export async function listPlatformCompanies(
  db: VsDatabase,
  adminEmail: string,
): Promise<PlatformCompany[]> {
  const { rows } = await db.withLookupTx((tx) =>
    sql<{
      id: string;
      name: string;
      slug: string;
      booking_ref_prefix: string | null;
      created_at: Date;
      owner_active: boolean;
      open_invitations: number;
      staff: number;
      vessels: number;
      bookings: number;
    }>`select * from vs.platform_companies(${adminEmail})`.execute(tx),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    bookingRefPrefix: r.booking_ref_prefix,
    createdAt: r.created_at,
    ownerActive: r.owner_active,
    openInvitations: r.open_invitations,
    staff: r.staff,
    vessels: r.vessels,
    bookings: r.bookings,
  }));
}

export async function createPlatformCompany(
  db: VsDatabase,
  adminEmail: string,
  input: NewPlatformCompany,
): Promise<{ operatorId: string; invitationId: string }> {
  const { rows } = await db.withLookupTx((tx) =>
    sql<{ operator_id: string; invitation_id: string }>`
      select operator_id, invitation_id from vs.platform_create_company(
        ${adminEmail}, ${input.name}, ${input.slug}, ${input.bookingRefPrefix},
        ${input.ownerEmail}, ${input.ownerName}, ${input.locale})`.execute(tx),
  );
  return { operatorId: rows[0]!.operator_id, invitationId: rows[0]!.invitation_id };
}

/** A fresh owner invitation for a company that has no active owner yet. */
export async function reinvitePlatformOwner(
  db: VsDatabase,
  adminEmail: string,
  input: { operatorId: string; ownerEmail: string; ownerName: string },
): Promise<string> {
  const { rows } = await db.withLookupTx((tx) =>
    sql<{ id: string }>`
      select vs.platform_reinvite_owner(${adminEmail}, ${input.operatorId}::uuid,
        ${input.ownerEmail}, ${input.ownerName}) as id`.execute(tx),
  );
  return rows[0]!.id;
}
