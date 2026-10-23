import { sql } from 'kysely';
import type { VsDatabase } from '@vs/db';

export type StaffRole = 'owner' | 'reservations' | 'finance' | 'read_only';

export interface StaffContext {
  staffUserId: string;
  operatorId: string;
  role: StaffRole;
}

/**
 * Maps a verified Supabase Auth user id to its operator and role. Runs before the tenant is
 * known, through the allow-listed SECURITY DEFINER function vs.resolve_staff (back office only).
 * Returns null for an unknown or inactive user.
 */
export async function getStaffContext(
  db: VsDatabase,
  authUserId: string,
): Promise<StaffContext | null> {
  const { rows } = await db.withLookupTx((tx) =>
    sql<{ staff_user_id: string; operator_id: string; role: StaffRole }>`
      select staff_user_id, operator_id, role from vs.resolve_staff(${authUserId}::uuid)`.execute(
      tx,
    ),
  );
  const row = rows[0];
  return row
    ? { staffUserId: row.staff_user_id, operatorId: row.operator_id, role: row.role }
    : null;
}

/** Liveness probe for /health endpoints: one round trip as the runtime role. */
export async function pingDatabase(db: VsDatabase): Promise<boolean> {
  const { rows } = await db.withLookupTx((tx) => sql<{ ok: number }>`select 1 as ok`.execute(tx));
  return rows[0]?.ok === 1;
}

/**
 * First sign-in of an invited person: links the verified email (Supabase Auth) to its open
 * invitation and returns the new staff context; returns the existing context if already linked,
 * or null when there is no open invitation for that email. Back office only.
 */
export async function claimStaffInvitation(
  db: VsDatabase,
  authUserId: string,
  verifiedEmail: string,
): Promise<StaffContext | null> {
  const { rows } = await db.withLookupTx((tx) =>
    sql<{ staff_user_id: string; operator_id: string; role: StaffRole }>`
      select staff_user_id, operator_id, role from vs.claim_staff_invitation(${authUserId}::uuid, ${verifiedEmail})`.execute(
      tx,
    ),
  );
  const row = rows[0];
  return row
    ? { staffUserId: row.staff_user_id, operatorId: row.operator_id, role: row.role }
    : null;
}
