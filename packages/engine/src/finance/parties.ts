import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import { parseInput, type EngineContext, type Tx } from '../internal';

/**
 * Billing parties (invoicing F1): whom an invoice is issued to.
 *
 * - Credit and channel-collected bookings bill the agency: one party per channel, created the
 *   first time it is needed and editable afterwards.
 * - Direct bookings (the back-office channel) and agency bookings the guest pays the vessel for
 *   (vessel_prepaid) bill the guest: one party per booking, from the lead guest.
 */

interface BookingForParty {
  id: string;
  ref: string;
  channel_id: string;
  channel_type: string;
  payment_mode: string;
}

export function billsAgency(booking: { channel_type: string; payment_mode: string }): boolean {
  return booking.channel_type !== 'back_office' && booking.payment_mode !== 'vessel_prepaid';
}

/** The party a booking is billed to, created if it does not exist yet. */
export async function ensureBookingParty(
  tx: Tx,
  ctx: EngineContext,
  booking: BookingForParty,
  options: { fallbackToRef?: boolean } = {},
): Promise<{ id: string; kind: 'agency' | 'guest' }> {
  if (billsAgency(booking)) {
    const existing = await tx
      .selectFrom('billing_party')
      .select('id')
      .where('kind', '=', 'agency')
      .where('channel_id', '=', booking.channel_id)
      .executeTakeFirst();
    if (existing) return { id: existing.id, kind: 'agency' };
    const channel = await tx
      .selectFrom('channel')
      .select('name')
      .where('id', '=', booking.channel_id)
      .executeTakeFirstOrThrow();
    const created = await tx
      .insertInto('billing_party')
      .values({
        operator_id: ctx.operatorId,
        kind: 'agency',
        channel_id: booking.channel_id,
        name: channel.name,
      })
      .onConflict((oc) =>
        oc.columns(['operator_id', 'channel_id']).where('kind', '=', 'agency').doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    if (created) {
      await audit(tx, ctx.operatorId, ctx.actor, {
        action: 'billing_party.created',
        entity: 'billing_party',
        entityId: created.id,
        after: { kind: 'agency', channel_id: booking.channel_id, name: channel.name },
      });
      return { id: created.id, kind: 'agency' };
    }
    return ensureBookingParty(tx, ctx, booking, options);
  }
  // A guest party is reused across a booking's invoices and receipts: found through either.
  const paid = await tx
    .selectFrom('receipt as r')
    .innerJoin('billing_party as p', 'p.id', 'r.billing_party_id')
    .select('p.id')
    .where('r.booking_id', '=', booking.id)
    .where('p.kind', '=', 'guest')
    .orderBy('r.created_at')
    .executeTakeFirst();
  if (paid) return { id: paid.id, kind: 'guest' };
  const earlier = await tx
    .selectFrom('invoice_line as l')
    .innerJoin('invoice as i', 'i.id', 'l.invoice_id')
    .innerJoin('billing_party as p', 'p.id', 'i.billing_party_id')
    .select('p.id')
    .where('l.booking_id', '=', booking.id)
    .where('p.kind', '=', 'guest')
    .orderBy('i.created_at')
    .executeTakeFirst();
  if (earlier) return { id: earlier.id, kind: 'guest' };
  const lead = await tx
    .selectFrom('guest')
    .select(['first_name', 'last_name', 'phone', 'nationality'])
    .where('booking_id', '=', booking.id)
    .orderBy('lead', 'desc')
    .orderBy('created_at')
    .executeTakeFirst();
  if (!lead && !options.fallbackToRef)
    throw new DomainError('VALIDATION_FAILED', {
      message: `Booking ${booking.ref} has no guest to bill; add the lead guest first`,
    });
  // A payment can come before the guests are entered: the party is named after the booking
  // until someone renames it.
  const created = await tx
    .insertInto('billing_party')
    .values({
      operator_id: ctx.operatorId,
      kind: 'guest',
      name: lead ? `${lead.first_name} ${lead.last_name}` : booking.ref,
      phone: lead?.phone ?? null,
      country: lead?.nationality ?? null,
      eta_party_type: lead ? (lead.nationality && lead.nationality !== 'EG' ? 'F' : 'P') : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await audit(tx, ctx.operatorId, ctx.actor, {
    action: 'billing_party.created',
    entity: 'billing_party',
    entityId: created.id,
    after: { kind: 'guest', booking: booking.ref },
  });
  return { id: created.id, kind: 'guest' };
}

export const listBillingPartiesInput = z.object({
  kind: z.enum(['agency', 'guest']).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

export async function listBillingParties(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof listBillingPartiesInput> = {},
) {
  const data = parseInput(listBillingPartiesInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    let query = tx.selectFrom('billing_party').selectAll().orderBy('name').limit(data.limit);
    if (data.kind) query = query.where('kind', '=', data.kind);
    if (data.search)
      query = query.where('name', 'ilike', `%${data.search.replace(/[%_\\]/g, '\\$&')}%`);
    return query.execute();
  });
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value ? value : null));

export const updateBillingPartyInput = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  legalNameAr: text(200).optional(),
  legalNameEn: text(200).optional(),
  address: text(400).optional(),
  taxRegistrationNo: text(40).optional(),
  commercialRegistrationNo: text(40).optional(),
  email: z
    .union([z.email(), z.literal('')])
    .nullable()
    .transform((value) => (value ? value.toLowerCase() : null))
    .optional(),
  phone: text(30).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
  etaPartyType: z.enum(['B', 'P', 'F']).nullable().optional(),
});

const COLUMNS = {
  name: 'name',
  legalNameAr: 'legal_name_ar',
  legalNameEn: 'legal_name_en',
  address: 'address',
  taxRegistrationNo: 'tax_registration_no',
  commercialRegistrationNo: 'commercial_registration_no',
  email: 'email',
  phone: 'phone',
  country: 'country',
  etaPartyType: 'eta_party_type',
} as const;

/** Edits a party. Issued invoices keep the details they were issued with. */
export async function updateBillingParty(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateBillingPartyInput>,
) {
  const { id, ...data } = parseInput(updateBillingPartyInput, input);
  const set = Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [COLUMNS[key as keyof typeof COLUMNS], value]),
  );
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('billing_party')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Billing party not found' });
    if (!Object.keys(set).length) return before;
    const after = await tx
      .updateTable('billing_party')
      .set(set)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'billing_party.updated',
      entity: 'billing_party',
      entityId: id,
      before,
      after,
    });
    return after;
  });
}
