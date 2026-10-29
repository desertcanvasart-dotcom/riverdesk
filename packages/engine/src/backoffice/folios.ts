import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import { cairoToday, parseInput, type EngineContext, type Tx } from '../internal';
import { assertInScope, type CheckinScope } from './checkin';

/**
 * Extras on board (Batch E1, docs/folio-plan.md): the price list, each vessel's folio currency,
 * and the folio of each booking cabin. The on-board staff post charges from the Check-in screen;
 * a mistake is undone by a void line, never by editing. Closing and payment come in E2.
 */

export const EXTRA_CATEGORIES = [
  'bar',
  'minibar',
  'restaurant',
  'laundry',
  'spa',
  'excursion',
  'gratuity',
  'communication',
  'shop',
  'other',
] as const;
export type ExtraCategory = (typeof EXTRA_CATEGORIES)[number];

const currency = z.string().regex(/^[A-Z]{3}$/);
const minor = z
  .union([z.bigint(), z.number().int(), z.string().regex(/^\d+$/)])
  .transform(BigInt)
  .refine((v) => v >= 0n, 'Must not be negative');

export interface ExtraItem {
  id: string;
  vesselId: string | null;
  category: ExtraCategory;
  nameAr: string;
  nameEn: string;
  price: bigint;
  currency: string;
  taxRateId: string | null;
  active: boolean;
  sortOrder: number;
}

const itemColumns = [
  'id',
  'vessel_id as vesselId',
  'category',
  'name_ar as nameAr',
  'name_en as nameEn',
  'price',
  'currency',
  'tax_rate_id as taxRateId',
  'active',
  'sort_order as sortOrder',
] as const;

const items = (tx: Tx) =>
  tx
    .selectFrom('extra_item')
    .select(itemColumns)
    // Categories in the price list's own order (bar first, other last), not alphabetically.
    .orderBy(sql`array_position(${sql.val(EXTRA_CATEGORIES)}::text[], category)`)
    .orderBy('sort_order')
    .orderBy('name_en')
    .$castTo<ExtraItem>();

/** The price list, each vessel's folio settings and the tax lines an item may carry. */
export async function getExtrasSettings(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => ({
    vessels: await tx
      .selectFrom('vessel')
      .select(['id', 'name', 'folio_enabled as folioEnabled', 'folio_currency as folioCurrency'])
      .orderBy('name')
      .execute(),
    items: await items(tx).execute(),
    taxRates: await tx
      .selectFrom('tax_rate')
      .select(['id', 'name_ar as nameAr', 'name_en as nameEn', 'rate_bps as rateBps', 'active'])
      .orderBy('sort_order')
      .execute(),
  }));
}

export const saveExtraItemInput = z.object({
  /** Omitted: a new item. */
  id: z.uuid().optional(),
  /** Null: sold on every vessel. */
  vesselId: z.uuid().nullable().default(null),
  category: z.enum(EXTRA_CATEGORIES),
  nameAr: z.string().trim().min(1).max(80),
  nameEn: z.string().trim().min(1).max(80),
  price: minor,
  currency,
  taxRateId: z.uuid().nullable().default(null),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

/** Creates or updates an item of the price list. Charges already posted keep their own price. */
export async function saveExtraItem(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof saveExtraItemInput>,
): Promise<ExtraItem> {
  const data = parseInput(saveExtraItemInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const values = {
      vessel_id: data.vesselId,
      category: data.category,
      name_ar: data.nameAr,
      name_en: data.nameEn,
      price: data.price,
      currency: data.currency,
      tax_rate_id: data.taxRateId,
      active: data.active,
      sort_order: data.sortOrder,
    };
    const before = data.id
      ? await tx
          .selectFrom('extra_item')
          .selectAll()
          .where('id', '=', data.id)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    if (data.id && !before) throw new DomainError('NOT_FOUND', { message: 'Item not found' });
    const row = data.id
      ? await tx
          .updateTable('extra_item')
          .set(values)
          .where('id', '=', data.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await tx
          .insertInto('extra_item')
          .values({ operator_id: ctx.operatorId, ...values })
          .returningAll()
          .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: data.id ? 'extra_item.updated' : 'extra_item.created',
      entity: 'extra_item',
      entityId: row.id,
      before,
      after: row,
    });
    return (await items(tx).where('id', '=', row.id).executeTakeFirstOrThrow()) as ExtraItem;
  });
}

export const updateVesselFolioInput = z.object({
  vesselId: z.uuid(),
  folioEnabled: z.boolean().optional(),
  folioCurrency: currency.optional(),
});

/**
 * Turns folios on or off for a vessel and sets its folio currency. The currency cannot change
 * while the vessel has open folios, since their charges are in the old one.
 */
export async function updateVesselFolio(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateVesselFolioInput>,
) {
  const data = parseInput(updateVesselFolioInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('vessel')
      .select(['folio_enabled', 'folio_currency'])
      .where('id', '=', data.vesselId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Vessel not found' });
    if (data.folioCurrency && data.folioCurrency !== before.folio_currency) {
      const open = await tx
        .selectFrom('folio')
        .select('id')
        .where('vessel_id', '=', data.vesselId)
        .where('status', '=', 'open')
        .executeTakeFirst();
      if (open)
        throw new DomainError('INVALID_STATE', {
          message: 'Close the open folios before changing the currency',
          details: { field: 'folioCurrency' },
        });
    }
    const after = await tx
      .updateTable('vessel')
      .set({
        folio_enabled: data.folioEnabled ?? before.folio_enabled,
        folio_currency: data.folioCurrency ?? before.folio_currency,
      })
      .where('id', '=', data.vesselId)
      .returning(['id', 'name', 'folio_enabled as folioEnabled', 'folio_currency as folioCurrency'])
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'vessel.folio_updated',
      entity: 'vessel',
      entityId: data.vesselId,
      before: { folioEnabled: before.folio_enabled, folioCurrency: before.folio_currency },
      after: { folioEnabled: after.folioEnabled, folioCurrency: after.folioCurrency },
    });
    return after;
  });
}

export interface FolioSummary {
  id: string;
  status: 'open' | 'closed' | 'settled' | 'void';
  total: bigint;
  charges: number;
}

export interface FolioCabin {
  bookingCabinId: string;
  ref: string;
  cabin: string | null;
  guests: string[];
  folio: FolioSummary | null;
}

/**
 * Everyone aboard one departure, cabin by cabin, with their folio (if one is open yet), and the
 * items the vessel sells in its folio currency. `enabled` is false when the vessel keeps no folios.
 */
export async function departureFolios(
  db: VsDatabase,
  ctx: EngineContext,
  legId: string,
  scope: CheckinScope,
) {
  const id = parseInput(z.uuid(), legId);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await assertInScope(tx, id, scope);
    const vessel = await tx
      .selectFrom('leg')
      .innerJoin('vessel', 'vessel.id', 'leg.vessel_id')
      .select(['vessel.id', 'vessel.folio_enabled as enabled', 'vessel.folio_currency as currency'])
      .where('leg.id', '=', id)
      .executeTakeFirstOrThrow();
    const { rows } = await sql<FolioCabin & { folioId: string | null; status: string | null }>`
      select bc.id as "bookingCabinId", b.ref, cab.number as cabin,
             coalesce((select array_agg(g.first_name || ' ' || g.last_name order by g.lead desc, g.created_at)
                       from vs.guest g where g.booking_cabin_id = bc.id), '{}') as guests,
             f.id as "folioId", f.status
      from vs.booking_line bl
      join vs.booking b on b.id = bl.booking_id and b.status = 'confirmed'
      join vs.booking_cabin bc on bc.id = bl.booking_cabin_id
      left join vs.cabin cab on cab.id = bl.assigned_cabin_id
      left join vs.folio f on f.booking_cabin_id = bc.id
      where bl.leg_id = ${id} and bl.status = 'confirmed'
      order by cab.number nulls last, b.ref, bc.seq`.execute(tx);
    const folioIds = rows.flatMap((r) => (r.folioId ? [r.folioId] : []));
    const totals = new Map(
      folioIds.length === 0
        ? []
        : (
            await tx
              .selectFrom('folio_charge')
              .select([
                'folio_id',
                sql<bigint>`sum(amount)::bigint`.as('total'),
                sql<number>`count(*) filter (where voids_charge_id is null
                  and not exists (select from vs.folio_charge v where v.voids_charge_id = folio_charge.id))::int`.as(
                  'charges',
                ),
              ])
              .where('folio_id', 'in', folioIds)
              .groupBy('folio_id')
              .execute()
          ).map((t) => [t.folio_id, t]),
    );
    const cabins: FolioCabin[] = rows.map((r) => ({
      bookingCabinId: r.bookingCabinId,
      ref: r.ref,
      cabin: r.cabin,
      guests: r.guests,
      folio: r.folioId
        ? {
            id: r.folioId,
            status: r.status as FolioSummary['status'],
            total: totals.get(r.folioId)?.total ?? 0n,
            charges: totals.get(r.folioId)?.charges ?? 0,
          }
        : null,
    }));
    return {
      enabled: vessel.enabled,
      currency: vessel.currency,
      items: (await items(tx)
        .where('active', '=', true)
        .where('currency', '=', vessel.currency)
        .where((eb) => eb.or([eb('vessel_id', 'is', null), eb('vessel_id', '=', vessel.id)]))
        .execute()) as ExtraItem[],
      cabins,
      total: cabins.reduce((sum, c) => sum + (c.folio?.total ?? 0n), 0n),
    };
  });
}

export interface FolioCharge {
  id: string;
  category: ExtraCategory;
  descriptionAr: string;
  descriptionEn: string;
  guestName: string | null;
  quantity: number;
  unitAmount: bigint;
  amount: bigint;
  chargedOn: string;
  note: string | null;
  postedBy: string | null;
  postedAt: Date;
  /** Set when the charge was voided; the void line itself is not listed. */
  voided: { reason: string; by: string | null; at: Date } | null;
}

export interface FolioDetail {
  folio: {
    id: string;
    status: FolioSummary['status'];
    currency: string;
    billTo: 'guest' | 'agency';
    openedAt: Date;
  } | null;
  currency: string;
  charges: FolioCharge[];
  total: bigint;
  byCategory: Partial<Record<ExtraCategory, bigint>>;
}

/** Asserts the booking cabin is aboard this departure (and in scope); returns its vessel. */
async function cabinAboard(tx: Tx, legId: string, bookingCabinId: string, scope: CheckinScope) {
  await assertInScope(tx, legId, scope);
  const row = await tx
    .selectFrom('booking_line as bl')
    .innerJoin('booking as b', 'b.id', 'bl.booking_id')
    .innerJoin('leg as l', 'l.id', 'bl.leg_id')
    .innerJoin('vessel as v', 'v.id', 'l.vessel_id')
    .select([
      'b.id as bookingId',
      'v.id as vesselId',
      'v.folio_enabled as enabled',
      'v.folio_currency as currency',
    ])
    .where('bl.leg_id', '=', legId)
    .where('bl.booking_cabin_id', '=', bookingCabinId)
    .where('bl.status', '=', 'confirmed')
    .where('b.status', '=', 'confirmed')
    .executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', { message: 'This cabin is not aboard here' });
  return row;
}

async function folioDetail(tx: Tx, bookingCabinId: string, currency: string): Promise<FolioDetail> {
  const folio = await tx
    .selectFrom('folio')
    .select(['id', 'status', 'currency', 'bill_to as billTo', 'opened_at as openedAt'])
    .where('booking_cabin_id', '=', bookingCabinId)
    .executeTakeFirst();
  if (!folio) return { folio: null, currency, charges: [], total: 0n, byCategory: {} };
  const lines = await tx
    .selectFrom('folio_charge as c')
    .leftJoin('staff_user as s', 's.id', 'c.posted_by')
    .select([
      'c.id',
      'c.category',
      'c.description_ar as descriptionAr',
      'c.description_en as descriptionEn',
      'c.guest_name as guestName',
      'c.quantity',
      'c.unit_amount as unitAmount',
      'c.amount',
      'c.charged_on as chargedOn',
      'c.note',
      's.display_name as postedBy',
      'c.posted_at as postedAt',
      'c.voids_charge_id as voidsChargeId',
      'c.void_reason as voidReason',
    ])
    .where('c.folio_id', '=', folio.id)
    .orderBy('c.posted_at')
    .orderBy('c.id')
    .execute();
  const voids = new Map(lines.filter((l) => l.voidsChargeId).map((l) => [l.voidsChargeId!, l]));
  const byCategory: FolioDetail['byCategory'] = {};
  let total = 0n;
  for (const l of lines) {
    total += l.amount;
    const k = l.category as ExtraCategory;
    byCategory[k] = (byCategory[k] ?? 0n) + l.amount;
  }
  for (const k of Object.keys(byCategory) as ExtraCategory[])
    if (byCategory[k] === 0n) delete byCategory[k];
  return {
    folio: {
      ...folio,
      status: folio.status as FolioSummary['status'],
      billTo: folio.billTo as 'guest' | 'agency',
    },
    currency: folio.currency,
    charges: lines
      .filter((l) => !l.voidsChargeId)
      .map((l) => {
        const v = voids.get(l.id);
        return {
          id: l.id,
          category: l.category as ExtraCategory,
          descriptionAr: l.descriptionAr,
          descriptionEn: l.descriptionEn,
          guestName: l.guestName,
          quantity: l.quantity,
          unitAmount: l.unitAmount,
          amount: l.amount,
          chargedOn: l.chargedOn,
          note: l.note,
          postedBy: l.postedBy,
          postedAt: l.postedAt,
          voided: v ? { reason: v.voidReason!, by: v.postedBy, at: v.postedAt } : null,
        };
      }),
    total,
    byCategory,
  };
}

export const folioInput = z.object({ legId: z.uuid(), bookingCabinId: z.uuid() });

/** One cabin's folio with every charge (voided ones marked), on a departure it is aboard. */
export async function getFolio(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof folioInput>,
  scope: CheckinScope,
): Promise<FolioDetail> {
  const data = parseInput(folioInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const aboard = await cabinAboard(tx, data.legId, data.bookingCabinId, scope);
    return folioDetail(tx, data.bookingCabinId, aboard.currency);
  });
}

export const postChargeInput = z
  .object({
    legId: z.uuid(),
    bookingCabinId: z.uuid(),
    /** An item of the price list, or a manual charge (`manual`). */
    itemId: z.uuid().optional(),
    manual: z
      .object({
        category: z.enum(EXTRA_CATEGORIES),
        description: z.string().trim().min(1).max(200),
        unitAmount: minor,
      })
      .optional(),
    quantity: z.number().int().min(1).max(99).default(1),
    guestName: z.string().trim().min(1).max(200).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .refine((v) => !!v.itemId !== !!v.manual, 'Give an item or a manual charge');

/**
 * Posts a charge to a cabin aboard this departure, opening its folio on the first charge. The
 * charge keeps a copy of the item's name, price and tax, so later price changes never touch it.
 */
export async function postCharge(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof postChargeInput>,
  scope: CheckinScope,
): Promise<FolioDetail> {
  const data = parseInput(postChargeInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const aboard = await cabinAboard(tx, data.legId, data.bookingCabinId, scope);
    if (!aboard.enabled)
      throw new DomainError('INVALID_STATE', { message: 'This vessel keeps no folios' });
    const staffId = ctx.actor.type === 'staff' ? ctx.actor.id : null;

    let line: {
      extra_item_id: string | null;
      category: ExtraCategory;
      description_ar: string;
      description_en: string;
      unit_amount: bigint;
      tax_rate_id: string | null;
      tax_name_ar: string | null;
      tax_name_en: string | null;
      tax_bps: number | null;
      tax_inclusive: boolean | null;
    };
    if (data.itemId) {
      const item = await tx
        .selectFrom('extra_item as i')
        .leftJoin('tax_rate as t', 't.id', 'i.tax_rate_id')
        .select([
          'i.id',
          'i.vessel_id',
          'i.category',
          'i.name_ar',
          'i.name_en',
          'i.price',
          'i.currency',
          'i.active',
          'i.tax_rate_id',
          't.name_ar as tax_name_ar',
          't.name_en as tax_name_en',
          't.rate_bps as tax_bps',
          't.inclusive as tax_inclusive',
        ])
        .where('i.id', '=', data.itemId)
        .executeTakeFirst();
      if (!item || !item.active || (item.vessel_id && item.vessel_id !== aboard.vesselId))
        throw new DomainError('NOT_FOUND', { message: 'This item is not sold on this vessel' });
      if (item.currency !== aboard.currency)
        throw new DomainError('INVALID_STATE', {
          message: `This item is priced in ${item.currency}, the folio in ${aboard.currency}`,
        });
      line = {
        extra_item_id: item.id,
        category: item.category as ExtraCategory,
        description_ar: item.name_ar,
        description_en: item.name_en,
        unit_amount: item.price,
        tax_rate_id: item.tax_rate_id,
        tax_name_ar: item.tax_name_ar,
        tax_name_en: item.tax_name_en,
        tax_bps: item.tax_bps,
        tax_inclusive: item.tax_inclusive,
      };
    } else {
      // A manual charge takes the company's default tax, like a manual invoice line.
      const tax = await tx
        .selectFrom('tax_rate')
        .select(['id', 'name_ar', 'name_en', 'rate_bps', 'inclusive'])
        .where('is_default', '=', true)
        .where('active', '=', true)
        .executeTakeFirst();
      line = {
        extra_item_id: null,
        category: data.manual!.category,
        description_ar: data.manual!.description,
        description_en: data.manual!.description,
        unit_amount: data.manual!.unitAmount,
        tax_rate_id: tax?.id ?? null,
        tax_name_ar: tax?.name_ar ?? null,
        tax_name_en: tax?.name_en ?? null,
        tax_bps: tax?.rate_bps ?? null,
        tax_inclusive: tax?.inclusive ?? null,
      };
    }

    // One folio per booking cabin; two phones posting the first charge at once meet here.
    await tx
      .insertInto('folio')
      .values({
        operator_id: ctx.operatorId,
        booking_id: aboard.bookingId,
        booking_cabin_id: data.bookingCabinId,
        vessel_id: aboard.vesselId,
        currency: aboard.currency,
        opened_by: staffId,
      })
      .onConflict((oc) => oc.column('booking_cabin_id').doNothing())
      .execute();
    const folio = await tx
      .selectFrom('folio')
      .select(['id', 'status', 'currency'])
      .where('booking_cabin_id', '=', data.bookingCabinId)
      .executeTakeFirstOrThrow();
    if (folio.status !== 'open')
      throw new DomainError('INVALID_STATE', { message: 'This folio is closed' });
    if (folio.currency !== aboard.currency)
      throw new DomainError('INVALID_STATE', {
        message: `This folio is in ${folio.currency}, the vessel now bills in ${aboard.currency}`,
      });

    const charge = await tx
      .insertInto('folio_charge')
      .values({
        operator_id: ctx.operatorId,
        folio_id: folio.id,
        guest_name: data.guestName ?? null,
        quantity: data.quantity,
        amount: line.unit_amount * BigInt(data.quantity),
        currency: folio.currency,
        charged_on: await cairoToday(tx),
        note: data.note || null,
        posted_by: staffId,
        ...line,
      })
      .returning(['id', 'amount'])
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'folio.charge_posted',
      entity: 'folio',
      entityId: folio.id,
      after: {
        chargeId: charge.id,
        description: line.description_en,
        quantity: data.quantity,
        amount: charge.amount,
        currency: folio.currency,
      },
    });
    return folioDetail(tx, data.bookingCabinId, aboard.currency);
  });
}

export const voidChargeInput = z.object({
  legId: z.uuid(),
  bookingCabinId: z.uuid(),
  chargeId: z.uuid(),
  reason: z.string().trim().min(1).max(300),
});

/** Cancels a charge with an opposite line and the reason; the original stays on the folio. */
export async function voidCharge(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof voidChargeInput>,
  scope: CheckinScope,
): Promise<FolioDetail> {
  const data = parseInput(voidChargeInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const aboard = await cabinAboard(tx, data.legId, data.bookingCabinId, scope);
    const charge = await tx
      .selectFrom('folio_charge as c')
      .innerJoin('folio as f', 'f.id', 'c.folio_id')
      .selectAll('c')
      .select('f.status')
      .where('c.id', '=', data.chargeId)
      .where('f.booking_cabin_id', '=', data.bookingCabinId)
      .where('c.voids_charge_id', 'is', null)
      .executeTakeFirst();
    if (!charge) throw new DomainError('NOT_FOUND', { message: 'Charge not found' });
    // Charges cannot be updated, so the lock is on the folio: one void at a time per folio.
    await tx
      .selectFrom('folio')
      .select('id')
      .where('id', '=', charge.folio_id)
      .forUpdate()
      .execute();
    if (charge.status !== 'open')
      throw new DomainError('INVALID_STATE', { message: 'This folio is closed' });
    const already = await tx
      .selectFrom('folio_charge')
      .select('id')
      .where('voids_charge_id', '=', charge.id)
      .executeTakeFirst();
    if (already) throw new DomainError('INVALID_STATE', { message: 'Already voided' });
    await tx
      .insertInto('folio_charge')
      .values({
        operator_id: ctx.operatorId,
        folio_id: charge.folio_id,
        extra_item_id: charge.extra_item_id,
        guest_name: charge.guest_name,
        category: charge.category,
        description_ar: charge.description_ar,
        description_en: charge.description_en,
        quantity: -charge.quantity,
        unit_amount: charge.unit_amount,
        amount: -charge.amount,
        currency: charge.currency,
        tax_rate_id: charge.tax_rate_id,
        tax_name_ar: charge.tax_name_ar,
        tax_name_en: charge.tax_name_en,
        tax_bps: charge.tax_bps,
        tax_inclusive: charge.tax_inclusive,
        charged_on: await cairoToday(tx),
        voids_charge_id: charge.id,
        void_reason: data.reason,
        posted_by: ctx.actor.type === 'staff' ? ctx.actor.id : null,
      })
      .execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'folio.charge_voided',
      entity: 'folio',
      entityId: charge.folio_id,
      after: { chargeId: charge.id, amount: -charge.amount, reason: data.reason },
    });
    return folioDetail(tx, data.bookingCabinId, aboard.currency);
  });
}
