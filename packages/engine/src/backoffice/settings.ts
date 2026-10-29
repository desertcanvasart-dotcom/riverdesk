import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import { parseInput, type EngineContext, type Tx } from '../internal';

/**
 * Company settings in the back office: staff and invitations (one login per company; a new
 * person is invited by email and claims it at first sign-in), operator details and defaults.
 */

const role = z.enum(['owner', 'manager', 'reservations', 'finance', 'read_only', 'onboard']);

/** An on-board login belongs to exactly one vessel; no other role has one. */
function vesselFor(role: string, vesselId: string | null | undefined): string | null {
  if (role !== 'onboard') return null;
  if (!vesselId)
    throw new DomainError('VALIDATION_FAILED', {
      message: 'An on-board login needs its vessel',
      details: { field: 'vesselId' },
    });
  return vesselId;
}

export async function listStaff(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const staff = await tx
      .selectFrom('staff_user')
      .select([
        'id',
        'display_name as displayName',
        'email',
        'role',
        'vessel_id as vesselId',
        'active',
        'created_at as createdAt',
      ])
      .orderBy('active', 'desc')
      .orderBy('display_name')
      .execute();
    const invitations = await tx
      .selectFrom('staff_invitation')
      .select([
        'id',
        'email',
        'display_name as displayName',
        'role',
        'vessel_id as vesselId',
        'expires_at as expiresAt',
      ])
      .where('accepted_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .orderBy('created_at', 'desc')
      .execute();
    return { staff, invitations };
  });
}

export const inviteStaffInput = z.object({
  email: z.email().max(200),
  displayName: z.string().trim().min(1).max(200),
  role,
  /** Required for an on-board login: the vessel it may see. */
  vesselId: z.uuid().nullish(),
});

/** The person signs in with this email (verified) and becomes staff with this role. */
export async function inviteStaff(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof inviteStaffInput>,
) {
  const data = parseInput(inviteStaffInput, input);
  const email = data.email.toLowerCase();
  const vesselId = vesselFor(data.role, data.vesselId);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const existing = await tx
      .selectFrom('staff_user')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();
    if (existing)
      throw new DomainError('INVALID_STATE', { message: 'This person is already staff' });
    // One open invitation per email across the platform: the unique index answers for every
    // company without this one being able to see the others.
    const invitation = await sql<{ id: string }>`
      insert into vs.staff_invitation (operator_id, email, display_name, role, vessel_id)
      values (${ctx.operatorId}, ${email}, ${data.displayName}, ${data.role}, ${vesselId})
      on conflict do nothing
      returning id`.execute(tx);
    const row = invitation.rows[0];
    if (!row)
      throw new DomainError('INVALID_STATE', {
        message: 'This email already has an open invitation',
      });
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'staff_invitation.created',
      entity: 'staff_invitation',
      entityId: row.id,
      after: { email, role: data.role, vesselId },
    });
    return { invitationId: row.id };
  });
}

export const revokeInvitationInput = z.object({ invitationId: z.uuid() });

export async function revokeInvitation(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof revokeInvitationInput>,
) {
  const data = parseInput(revokeInvitationInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const revoked = await tx
      .updateTable('staff_invitation')
      .set({ expires_at: sql<Date>`now()` })
      .where('id', '=', data.invitationId)
      .where('accepted_at', 'is', null)
      .returning(['id', 'email'])
      .executeTakeFirst();
    if (!revoked) throw new DomainError('NOT_FOUND', { message: 'Open invitation not found' });
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'staff_invitation.revoked',
      entity: 'staff_invitation',
      entityId: revoked.id,
      after: { email: revoked.email },
    });
    return { revoked: true };
  });
}

export const updateStaffInput = z.object({
  staffUserId: z.uuid(),
  role: role.optional(),
  vesselId: z.uuid().nullish(),
  active: z.boolean().optional(),
});

async function activeOwners(tx: Tx) {
  // Locks every active owner, so two demotions at once cannot both pass the check.
  const { rows } = await sql<{ id: string }>`
    select id from vs.staff_user where role = 'owner' and active for update`.execute(tx);
  return rows.length;
}

/** Change a role or deactivate someone; the company always keeps at least one active owner. */
export async function updateStaff(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateStaffInput>,
) {
  const data = parseInput(updateStaffInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('staff_user')
      .select(['id', 'role', 'vessel_id', 'active'])
      .where('id', '=', data.staffUserId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Staff member not found' });
    // One click on one's own row could take away the right to undo it; another owner does it.
    if (ctx.actor.type === 'staff' && ctx.actor.id === before.id) {
      throw new DomainError('INVALID_STATE', {
        message: 'Your own role and access are changed by another owner',
      });
    }
    const nextRole = data.role ?? before.role;
    const after = {
      role: nextRole,
      vessel_id: vesselFor(nextRole, data.vesselId ?? before.vessel_id),
      active: data.active ?? before.active,
    };
    const losesOwner =
      before.role === 'owner' && before.active && (after.role !== 'owner' || !after.active);
    if (losesOwner && (await activeOwners(tx)) <= 1) {
      throw new DomainError('INVALID_STATE', {
        message: 'The company needs at least one active owner',
      });
    }
    await tx.updateTable('staff_user').set(after).where('id', '=', before.id).execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'staff.updated',
      entity: 'staff_user',
      entityId: before.id,
      before: { role: before.role, vesselId: before.vessel_id, active: before.active },
      after: { role: after.role, vesselId: after.vessel_id, active: after.active },
    });
    return {
      staffUserId: before.id,
      role: after.role,
      vesselId: after.vessel_id,
      active: after.active,
    };
  });
}

export async function getOperatorSettings(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const operator = await tx
      .selectFrom('operator')
      .select(['name', 'slug', 'default_locale as defaultLocale'])
      .executeTakeFirstOrThrow();
    const settings = await tx
      .selectFrom('operator_setting')
      .select([
        'booking_ref_prefix as bookingRefPrefix',
        'checkout_hold_minutes as checkoutHoldMinutes',
        'option_hold_hours as optionHoldHours',
        'offer_hold_hours as offerHoldHours',
        'payment_hold_hours as paymentHoldHours',
        'request_sla_hours as requestSlaHours',
        'request_grace_hours as requestGraceHours',
        'assignment_cutoff_days as assignmentCutoffDays',
        'allotment_release_days as allotmentReleaseDays',
        'passport_retention_days as passportRetentionDays',
        'emergency_phone as emergencyPhone',
        'ops_email as opsEmail',
        'voucher_note_en as voucherNoteEn',
        'voucher_note_ar as voucherNoteAr',
      ])
      .executeTakeFirstOrThrow();
    return { ...operator, ...settings };
  });
}

const positive = z.number().int().min(1).max(10_000);
export const updateOperatorSettingsInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    defaultLocale: z.enum(['ar', 'en']),
    checkoutHoldMinutes: positive,
    optionHoldHours: positive,
    offerHoldHours: positive,
    paymentHoldHours: positive,
    requestSlaHours: positive,
    requestGraceHours: z.number().int().min(0).max(240),
    assignmentCutoffDays: z.number().int().min(0).max(60),
    allotmentReleaseDays: z.number().int().min(0).max(365),
    passportRetentionDays: z.number().int().min(1).max(3650),
    emergencyPhone: z.string().trim().max(50).nullable(),
    opsEmail: z.union([z.email(), z.literal('')]).nullable(),
    voucherNoteEn: z.string().trim().max(2000).nullable(),
    voucherNoteAr: z.string().trim().max(2000).nullable(),
  })
  .partial();

/** Defaults apply to new holds, requests and contracts; existing ones keep their own times. */
export async function updateOperatorSettings(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateOperatorSettingsInput>,
) {
  const data = parseInput(updateOperatorSettingsInput, input);
  const before = await getOperatorSettings(db, ctx);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    if (data.name !== undefined || data.defaultLocale !== undefined) {
      await tx
        .updateTable('operator')
        .set({
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.defaultLocale !== undefined ? { default_locale: data.defaultLocale } : {}),
        })
        .where('id', '=', ctx.operatorId)
        .execute();
    }
    const columns = {
      checkout_hold_minutes: data.checkoutHoldMinutes,
      option_hold_hours: data.optionHoldHours,
      offer_hold_hours: data.offerHoldHours,
      payment_hold_hours: data.paymentHoldHours,
      request_sla_hours: data.requestSlaHours,
      request_grace_hours: data.requestGraceHours,
      assignment_cutoff_days: data.assignmentCutoffDays,
      allotment_release_days: data.allotmentReleaseDays,
      passport_retention_days: data.passportRetentionDays,
      emergency_phone: data.emergencyPhone === '' ? null : data.emergencyPhone,
      ops_email: data.opsEmail === '' ? null : data.opsEmail,
      voucher_note_en: data.voucherNoteEn === '' ? null : data.voucherNoteEn,
      voucher_note_ar: data.voucherNoteAr === '' ? null : data.voucherNoteAr,
    };
    const set = Object.fromEntries(Object.entries(columns).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length > 0) {
      await tx
        .updateTable('operator_setting')
        .set(set)
        .where('operator_id', '=', ctx.operatorId)
        .execute();
    }
    const changed = Object.fromEntries(
      Object.entries(data).filter(([key, value]) => before[key as keyof typeof before] !== value),
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'operator.settings_updated',
      entity: 'operator',
      entityId: ctx.operatorId,
      before: Object.fromEntries(
        Object.keys(changed).map((key) => [key, before[key as keyof typeof before]]),
      ),
      after: changed,
    });
    return { updated: Object.keys(changed) };
  });
}
