import { sql } from 'kysely';
import type { VsDatabase } from '@vs/db';
import { audit } from './audit';

/** `onboard`: the vessel's reception and purser, limited to one vessel's departures. */
export type StaffRole = 'owner' | 'reservations' | 'finance' | 'read_only' | 'onboard';

export interface StaffContext {
  staffUserId: string;
  operatorId: string;
  role: StaffRole;
  /** The one vessel an on-board login may see; null for every other role. */
  vesselId: string | null;
}

type StaffRow = {
  staff_user_id: string;
  operator_id: string;
  role: StaffRole;
  vessel_id: string | null;
};
const toContext = (row: StaffRow | undefined): StaffContext | null =>
  row
    ? {
        staffUserId: row.staff_user_id,
        operatorId: row.operator_id,
        role: row.role,
        vesselId: row.vessel_id,
      }
    : null;

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
    sql<StaffRow>`
      select staff_user_id, operator_id, role, vessel_id from vs.resolve_staff(${authUserId}::uuid)`.execute(
      tx,
    ),
  );
  return toContext(rows[0]);
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
  const claim = async () => {
    const { rows } = await db.withLookupTx((tx) =>
      sql<StaffRow>`
        select staff_user_id, operator_id, role, vessel_id from vs.claim_staff_invitation(${authUserId}::uuid, ${verifiedEmail})`.execute(
        tx,
      ),
    );
    return toContext(rows[0]);
  };
  // A first sign-in loads several parts of a page at once, and each may claim. The losers wait
  // for the winner's lock, then find the invitation already taken; asking once more returns the
  // link the winner made (or still null when there was no invitation).
  return (await claim()) ?? (await claim());
}

export interface StaffProfile {
  staffUserId: string;
  displayName: string;
  email: string;
  role: StaffRole;
  locale: 'ar' | 'en';
  operatorName: string;
}

export async function getStaffProfile(
  db: VsDatabase,
  ctx: { operatorId: string; actor: import('@vs/shared').Actor },
  staffUserId: string,
): Promise<StaffProfile> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const row = await tx
      .selectFrom('staff_user as s')
      .innerJoin('operator as o', 'o.id', 's.operator_id')
      .select([
        's.id',
        's.display_name',
        's.email',
        's.role',
        's.locale',
        'o.name as operator_name',
      ])
      .where('s.id', '=', staffUserId)
      .executeTakeFirstOrThrow();
    return {
      staffUserId: row.id,
      displayName: row.display_name,
      email: row.email,
      role: row.role as StaffRole,
      locale: row.locale === 'en' ? 'en' : 'ar',
      operatorName: row.operator_name,
    };
  });
}

/** A staff member's own language preference (audited). */
export async function setStaffLocale(
  db: VsDatabase,
  ctx: { operatorId: string; actor: import('@vs/shared').Actor },
  staffUserId: string,
  locale: 'ar' | 'en',
) {
  await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await tx.updateTable('staff_user').set({ locale }).where('id', '=', staffUserId).execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'staff.locale_set',
      entity: 'staff_user',
      entityId: staffUserId,
      after: { locale },
    });
  });
}
