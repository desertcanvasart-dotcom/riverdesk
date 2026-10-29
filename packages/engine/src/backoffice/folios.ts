import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { convertBack, money } from '@vs/shared';
import { audit } from '../audit';
import { invoiceTotals, issueInvoiceInTx, lineTax } from '../finance/invoices';
import { billsAgency, ensureBookingParty } from '../finance/parties';
import { receiveForInvoice } from '../finance/receipts';
import { loadFinanceSettings } from '../finance/settings';
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
  status: 'open' | 'closed' | 'void';
  total: bigint;
  charges: number;
  /** Once closed: the invoice number and what is still to pay on it. */
  invoiceNumber: string | null;
  balance: bigint | null;
}

export interface FolioCabin {
  bookingCabinId: string;
  ref: string;
  cabin: string | null;
  guests: string[];
  /** The cabin's cruise ends where this departure arrives: time to close its folio. */
  leaving: boolean;
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
    const { rows } = await sql<
      FolioCabin & {
        folioId: string | null;
        status: string | null;
        invoiceNumber: string | null;
        balance: bigint | null;
      }
    >`
      select bc.id as "bookingCabinId", b.ref, cab.number as cabin,
             coalesce((select array_agg(g.first_name || ' ' || g.last_name order by g.lead desc, g.created_at)
                       from vs.guest g where g.booking_cabin_id = bc.id), '{}') as guests,
             (s.disembark_date = l.arrive_date and s.disembark_port_id = l.to_port_id) as leaving,
             f.id as "folioId", f.status, i.number as "invoiceNumber",
             (i.total - i.amount_credited - i.amount_paid)::bigint as balance
      from vs.booking_line bl
      join vs.leg l on l.id = bl.leg_id
      join vs.booking b on b.id = bl.booking_id and b.status = 'confirmed'
      join vs.sailing s on s.id = b.sailing_id
      join vs.booking_cabin bc on bc.id = bl.booking_cabin_id
      left join vs.cabin cab on cab.id = bl.assigned_cabin_id
      left join vs.folio f on f.booking_cabin_id = bc.id
      left join vs.invoice i on i.id = f.invoice_id
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
      leaving: r.leaving,
      folio: r.folioId
        ? {
            id: r.folioId,
            status: r.status as FolioSummary['status'],
            total: totals.get(r.folioId)?.total ?? 0n,
            charges: totals.get(r.folioId)?.charges ?? 0,
            invoiceNumber: r.invoiceNumber,
            balance: r.balance === null ? null : BigInt(r.balance),
          }
        : null,
    }));
    // Closing in another currency than the base needs a rate: offer the last one used.
    const { base_currency: baseCurrency } = await loadFinanceSettings(tx);
    const lastRate =
      baseCurrency === vessel.currency
        ? null
        : ((
            await tx
              .selectFrom('invoice')
              .select('fx_rate')
              .where('currency', '=', vessel.currency)
              .where('base_currency', '=', baseCurrency)
              .where('fx_rate', 'is not', null)
              .orderBy('issued_at', 'desc')
              .executeTakeFirst()
          )?.fx_rate ?? null);
    return {
      vesselId: vessel.id,
      enabled: vessel.enabled,
      currency: vessel.currency,
      baseCurrency,
      lastRate,
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
    /** Set once closed: the invoice it issued and what is still to pay on it. */
    invoice: {
      id: string;
      number: string;
      status: string;
      total: bigint;
      /** total − credited − paid. */
      balance: bigint;
      party: string;
    } | null;
  } | null;
  currency: string;
  /** The booking's agency, and whether its contract has it pay its guests' extras. */
  agency: { name: string; allowed: boolean } | null;
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
  const contract = await tx
    .selectFrom('booking_cabin as bc')
    .innerJoin('booking as b', 'b.id', 'bc.booking_id')
    .innerJoin('channel as ch', 'ch.id', 'b.channel_id')
    .innerJoin('channel_contract as cc', 'cc.id', 'b.contract_id')
    .select(['ch.name', 'ch.type', 'cc.payment_mode', 'cc.folio_to_agency'])
    .where('bc.id', '=', bookingCabinId)
    .executeTakeFirstOrThrow();
  const agency =
    contract.type === 'back_office'
      ? null
      : {
          name: contract.name,
          allowed:
            contract.folio_to_agency &&
            billsAgency({ channel_type: contract.type, payment_mode: contract.payment_mode }),
        };
  const row = await tx
    .selectFrom('folio as f')
    .leftJoin('invoice as i', 'i.id', 'f.invoice_id')
    .leftJoin('billing_party as p', 'p.id', 'i.billing_party_id')
    .select([
      'f.id',
      'f.status',
      'f.currency',
      'f.bill_to as billTo',
      'f.opened_at as openedAt',
      'i.id as invoiceId',
      'i.number',
      'i.status as invoiceStatus',
      'i.total as invoiceTotal',
      'i.amount_paid as paid',
      'i.amount_credited as credited',
      'p.name as party',
    ])
    .where('f.booking_cabin_id', '=', bookingCabinId)
    .executeTakeFirst();
  if (!row) return { folio: null, currency, agency, charges: [], total: 0n, byCategory: {} };
  const folio = {
    id: row.id,
    status: row.status as FolioSummary['status'],
    currency: row.currency,
    billTo: row.billTo as 'guest' | 'agency',
    openedAt: row.openedAt,
    invoice: row.invoiceId
      ? {
          id: row.invoiceId,
          number: row.number!,
          status: row.invoiceStatus!,
          total: row.invoiceTotal!,
          balance: row.invoiceTotal! - row.credited! - row.paid!,
          party: row.party!,
        }
      : null,
  };
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
    folio,
    currency: folio.currency,
    agency,
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

const CATEGORY_NAMES: Record<ExtraCategory, [en: string, ar: string]> = {
  bar: ['Bar', 'البار'],
  minibar: ['Minibar', 'الميني بار'],
  restaurant: ['Restaurant', 'المطعم'],
  laundry: ['Laundry', 'المغسلة'],
  spa: ['Spa', 'السبا'],
  excursion: ['Excursions', 'الرحلات'],
  gratuity: ['Tips', 'الإكراميات'],
  communication: ['Phone and Wi-Fi', 'الهاتف والإنترنت'],
  shop: ['Shop', 'المتجر'],
  other: ['Other', 'أخرى'],
};

/**
 * The guest party a folio bills when the guest pays: the booking's own guest party when the
 * booking is billed to its guest, else one made for the cabin's first guest (reused by the
 * booking's later folios).
 */
async function folioGuestParty(tx: Tx, ctx: EngineContext, bookingCabinId: string) {
  const booking = await tx
    .selectFrom('booking_cabin as bc')
    .innerJoin('booking as b', 'b.id', 'bc.booking_id')
    .innerJoin('channel as ch', 'ch.id', 'b.channel_id')
    .innerJoin('channel_contract as cc', 'cc.id', 'b.contract_id')
    .select(['b.id', 'b.ref', 'b.channel_id', 'ch.type as channel_type', 'cc.payment_mode'])
    .where('bc.id', '=', bookingCabinId)
    .executeTakeFirstOrThrow();
  if (!billsAgency(booking))
    return (await ensureBookingParty(tx, ctx, booking, { fallbackToRef: true })).id;
  const earlier = await tx
    .selectFrom('folio as f')
    .innerJoin('invoice as i', 'i.id', 'f.invoice_id')
    .innerJoin('billing_party as p', 'p.id', 'i.billing_party_id')
    .select('p.id')
    .where('f.booking_id', '=', booking.id)
    .where('p.kind', '=', 'guest')
    .executeTakeFirst();
  if (earlier) return earlier.id;
  const guest = await tx
    .selectFrom('guest')
    .select(['first_name', 'last_name', 'phone', 'nationality'])
    .where('booking_cabin_id', '=', bookingCabinId)
    .orderBy('lead', 'desc')
    .orderBy('created_at')
    .executeTakeFirst();
  const created = await tx
    .insertInto('billing_party')
    .values({
      operator_id: ctx.operatorId,
      kind: 'guest',
      name: guest ? `${guest.first_name} ${guest.last_name}` : booking.ref,
      phone: guest?.phone ?? null,
      country: guest?.nationality ?? null,
      eta_party_type: guest ? (guest.nationality && guest.nationality !== 'EG' ? 'F' : 'P') : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await audit(tx, ctx.operatorId, ctx.actor, {
    action: 'billing_party.created',
    entity: 'billing_party',
    entityId: created.id,
    after: { kind: 'guest', booking: booking.ref, for: 'folio' },
  });
  return created.id;
}

const fxRate = z
  .string()
  .regex(/^[0-9]+(\.[0-9]{1,6})?$/, 'A decimal rate with at most 6 decimals')
  .refine((v) => Number(v) > 0, 'Must be above zero');

export const closeFolioInput = folioInput.extend({
  /** Who pays: the guest at reception, or the agency where its contract allows it. */
  billTo: z.enum(['guest', 'agency']).default('guest'),
  /** 1 unit of the folio currency in the base currency, when they differ. */
  fxRate: fxRate.optional(),
});

/**
 * Closes a folio. With something to bill it issues an invoice: one `extra` line per category,
 * day and tax line (a void counts on its charge's day), not tied to the booking, so the
 * booking's own invoice is never blocked. Due today when the guest pays; on the agency's terms
 * otherwise. A folio with nothing left to bill is closed as void.
 */
export async function closeFolio(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof closeFolioInput>,
  scope: CheckinScope,
): Promise<FolioDetail> {
  const data = parseInput(closeFolioInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const aboard = await cabinAboard(tx, data.legId, data.bookingCabinId, scope);
    const folio = await tx
      .selectFrom('folio as f')
      .innerJoin('booking as b', 'b.id', 'f.booking_id')
      .select(['f.id', 'f.status', 'f.currency', 'b.ref'])
      .where('f.booking_cabin_id', '=', data.bookingCabinId)
      .forUpdate('f')
      .executeTakeFirst();
    const cabinNo = await tx
      .selectFrom('booking_line as bl')
      .innerJoin('cabin', 'cabin.id', 'bl.assigned_cabin_id')
      .select('cabin.number')
      .where('bl.booking_cabin_id', '=', data.bookingCabinId)
      .where('bl.leg_id', '=', data.legId)
      .executeTakeFirst();
    if (!folio) throw new DomainError('NOT_FOUND', { message: 'Nothing is charged to this cabin' });
    if (folio.status !== 'open')
      throw new DomainError('INVALID_STATE', { message: 'This folio is already closed' });
    const staffId = ctx.actor.type === 'staff' ? ctx.actor.id : null;

    const charges = await tx
      .selectFrom('folio_charge')
      .selectAll()
      .where('folio_id', '=', folio.id)
      .orderBy('charged_on')
      .orderBy('posted_at')
      .execute();
    const dayOf = new Map(charges.map((c) => [c.id, c.charged_on]));
    const groups = new Map<string, (typeof charges)[number] & { net: bigint; day: string }>();
    for (const c of charges) {
      const day = c.voids_charge_id ? (dayOf.get(c.voids_charge_id) ?? c.charged_on) : c.charged_on;
      const key = `${day}|${c.category}|${c.tax_rate_id ?? ''}|${c.tax_bps ?? ''}|${c.tax_inclusive ?? ''}`;
      const group = groups.get(key);
      if (group) group.net += c.amount;
      else groups.set(key, { ...c, net: c.amount, day });
    }
    const lines = [...groups.values()].filter((g) => g.net !== 0n);
    const total = lines.reduce((sum, g) => sum + g.net, 0n);

    if (total === 0n) {
      await tx
        .updateTable('folio')
        .set({ status: 'void', closed_at: sql<Date>`now()`, closed_by: staffId })
        .where('id', '=', folio.id)
        .execute();
      await audit(tx, ctx.operatorId, ctx.actor, {
        action: 'folio.voided',
        entity: 'folio',
        entityId: folio.id,
      });
      return folioDetail(tx, data.bookingCabinId, aboard.currency);
    }

    let partyId: string;
    if (data.billTo === 'agency') {
      const detail = await folioDetail(tx, data.bookingCabinId, aboard.currency);
      if (!detail.agency?.allowed)
        throw new DomainError('INVALID_STATE', {
          message: "This booking's agency does not pay its guests' extras; the guest pays",
        });
      const booking = await tx
        .selectFrom('booking as b')
        .innerJoin('channel as ch', 'ch.id', 'b.channel_id')
        .innerJoin('channel_contract as cc', 'cc.id', 'b.contract_id')
        .select(['b.id', 'b.ref', 'b.channel_id', 'ch.type as channel_type', 'cc.payment_mode'])
        .where('b.id', '=', aboard.bookingId)
        .executeTakeFirstOrThrow();
      partyId = (await ensureBookingParty(tx, ctx, booking)).id;
    } else partyId = await folioGuestParty(tx, ctx, data.bookingCabinId);

    const settings = await loadFinanceSettings(tx);
    if (!settings.invoice_currencies.includes(folio.currency))
      throw new DomainError('VALIDATION_FAILED', {
        message: `${folio.currency} is not one of the company's invoice currencies (Invoices → Settings)`,
      });
    const today = await cairoToday(tx);
    const cabin = cabinNo?.number ?? folio.ref;
    const invoice = await tx
      .insertInto('invoice')
      .values({
        operator_id: ctx.operatorId,
        type: 'invoice',
        billing_party_id: partyId,
        currency: folio.currency,
        base_currency: settings.base_currency,
        locale: 'both',
        due_date: data.billTo === 'guest' ? today : null,
        notes: `Extras on board — cabin ${cabin}, booking ${folio.ref}`,
        created_by: staffId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Dates and refs read left to right inside Arabic text (Unicode isolates, invisible).
    const iso = (text: string) => `⁦${text}⁩`;
    const rows = lines.map((g, seq) => {
      const [en, ar] = CATEGORY_NAMES[g.category as ExtraCategory];
      return {
        operator_id: ctx.operatorId,
        invoice_id: invoice.id,
        seq,
        kind: 'extra',
        booking_id: null,
        booking_cabin_id: null,
        description_ar: `${ar} — ${iso(g.day)} — كابينة ${iso(cabin)}`,
        description_en: `${en} — ${g.day} — cabin ${cabin}`,
        quantity: 1,
        unit_amount: g.net,
        amount: g.net,
        tax_rate_id: g.tax_rate_id,
        tax_name_ar: g.tax_name_ar,
        tax_name_en: g.tax_name_en,
        tax_bps: g.tax_bps,
        tax_inclusive: g.tax_inclusive,
        tax_amount: g.tax_bps === null ? 0n : lineTax(g.net, g.tax_bps, g.tax_inclusive!),
      };
    });
    await tx.insertInto('invoice_line').values(rows).execute();
    const totals = invoiceTotals(rows);
    await tx
      .updateTable('invoice')
      .set({ subtotal: totals.subtotal, tax_total: totals.taxTotal, total: totals.total })
      .where('id', '=', invoice.id)
      .execute();
    const issued = await issueInvoiceInTx(tx, ctx, {
      invoiceId: invoice.id,
      ...(data.fxRate ? { fxRate: data.fxRate } : {}),
    });
    await tx
      .updateTable('folio')
      .set({
        status: 'closed',
        bill_to: data.billTo,
        closed_at: sql<Date>`now()`,
        closed_by: staffId,
        invoice_id: invoice.id,
      })
      .where('id', '=', folio.id)
      .execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'folio.closed',
      entity: 'folio',
      entityId: folio.id,
      after: { invoice: issued.number, total: issued.total, billTo: data.billTo },
    });
    return folioDetail(tx, data.bookingCabinId, aboard.currency);
  });
}

export const payFolioInput = folioInput.extend({
  amount: minor.refine((v) => v > 0n, 'Must be positive'),
  currency,
  method: z.enum(['cash', 'card']),
  /** When paid in another currency: 1 unit of the folio currency in it (1 USD = 48.50 EGP). */
  fxRate: fxRate.optional(),
  reference: z.string().trim().min(1).max(200).optional(),
});

/**
 * Payment at reception for a closed folio billed to the guest: a receipt from the guest,
 * allocated to the folio's invoice at once. Part payments are allowed; never more than is due.
 */
export async function payFolio(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof payFolioInput>,
  scope: CheckinScope,
): Promise<FolioDetail> {
  const data = parseInput(payFolioInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const aboard = await cabinAboard(tx, data.legId, data.bookingCabinId, scope);
    const folio = await tx
      .selectFrom('folio as f')
      .innerJoin('invoice as i', 'i.id', 'f.invoice_id')
      .select([
        'f.id',
        'f.bill_to',
        'f.currency',
        'i.id as invoiceId',
        'i.number',
        'i.billing_party_id',
      ])
      .where('f.booking_cabin_id', '=', data.bookingCabinId)
      .where('f.status', '=', 'closed')
      .executeTakeFirst();
    if (!folio) throw new DomainError('INVALID_STATE', { message: 'Close the folio first' });
    if (folio.bill_to !== 'guest')
      throw new DomainError('INVALID_STATE', {
        message: 'This folio is billed to the agency; it is paid with the agency’s invoices',
      });
    // The reception thinks in "1 USD = 48.50 EGP"; the allocation keeps the inverse rate for the
    // record and the amount converted exactly from the reception's rate.
    const other = data.currency !== folio.currency;
    if (other !== !!data.fxRate)
      throw new DomainError('VALIDATION_FAILED', {
        message: other
          ? `A rate 1 ${folio.currency} = ? ${data.currency} is needed`
          : 'No rate for a payment in the folio currency',
        details: { field: 'fxRate' },
      });
    const paid = await receiveForInvoice(tx, ctx, {
      invoiceId: folio.invoiceId,
      billingPartyId: folio.billing_party_id,
      amount: data.amount,
      currency: data.currency,
      method: data.method,
      reference: data.reference ?? `Folio ${folio.number}`,
      receivedOn: await cairoToday(tx),
      ...(other
        ? {
            fxRate: (1 / Number(data.fxRate)).toFixed(6),
            invoiceAmount: convertBack(
              money(data.amount, data.currency),
              data.fxRate!,
              folio.currency,
            ).amount,
            note: `1 ${folio.currency} = ${data.fxRate} ${data.currency}`,
          }
        : {}),
    });
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'folio.paid',
      entity: 'folio',
      entityId: folio.id,
      after: {
        receiptId: paid.receiptId,
        amount: data.amount,
        currency: data.currency,
        method: data.method,
      },
    });
    return folioDetail(tx, data.bookingCabinId, aboard.currency);
  });
}

/**
 * Before a booking or some of its cabins are cancelled: a folio still open with charges must be
 * closed first (so nothing charged is lost); one with nothing left on it is closed as void.
 */
export async function settleFoliosBeforeCancel(
  tx: Tx,
  ctx: EngineContext,
  bookingId: string,
  bookingCabinIds?: string[],
) {
  let query = tx
    .selectFrom('folio as f')
    .leftJoin('folio_charge as c', 'c.folio_id', 'f.id')
    .select(['f.id', sql<bigint>`coalesce(sum(c.amount), 0)::bigint`.as('total')])
    .where('f.booking_id', '=', bookingId)
    .where('f.status', '=', 'open')
    .groupBy('f.id');
  if (bookingCabinIds) {
    if (!bookingCabinIds.length) return;
    query = query.where('f.booking_cabin_id', 'in', bookingCabinIds);
  }
  for (const folio of await query.execute()) {
    if (folio.total !== 0n)
      throw new DomainError('INVALID_STATE', {
        message: 'A cabin has extras on its folio; close the folio (Check-in → Folios) first',
        details: { folioId: folio.id },
      });
    await tx
      .updateTable('folio')
      .set({
        status: 'void',
        closed_at: sql<Date>`now()`,
        closed_by: ctx.actor.type === 'staff' ? ctx.actor.id : null,
      })
      .where('id', '=', folio.id)
      .execute();
  }
}

export interface GuestFolioData {
  vessel: string;
  ref: string;
  cabin: string | null;
  guests: string[];
  embark: { date: string; port: { nameAr: string; nameEn: string } };
  disembark: { date: string; port: { nameAr: string; nameEn: string } };
  currency: string;
  status: FolioSummary['status'];
  billTo: 'guest' | 'agency';
  agency: string | null;
  /** What is billed: voided charges and their voids are left out. */
  charges: {
    chargedOn: string;
    category: ExtraCategory;
    descriptionAr: string;
    descriptionEn: string;
    guestName: string | null;
    quantity: number;
    unitAmount: bigint;
    amount: bigint;
  }[];
  byCategory: Partial<Record<ExtraCategory, bigint>>;
  total: bigint;
  /** Once closed: its invoice, the tax in it and what was paid at reception. */
  invoice: {
    number: string;
    issueDate: string;
    subtotal: bigint;
    taxTotal: bigint;
    total: bigint;
    balance: bigint;
    payments: {
      receivedOn: string;
      method: string;
      amount: bigint;
      currency: string;
      invoiceAmount: bigint;
    }[];
  } | null;
}

/** The guest's folio: every charge still standing, by day, and the payments made. */
export async function guestFolioData(
  db: VsDatabase,
  ctx: EngineContext,
  folioId: string,
): Promise<GuestFolioData> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<
      Omit<GuestFolioData, 'charges' | 'byCategory' | 'total' | 'invoice' | 'guests'> & {
        bookingCabinId: string;
        invoiceId: string | null;
      }
    >`
      select v.name as vessel, b.ref, f.currency, f.status, f.bill_to as "billTo",
             f.booking_cabin_id as "bookingCabinId", f.invoice_id as "invoiceId",
             case when ch.type = 'back_office' then null else ch.name end as agency,
             (select cab.number from vs.booking_line bl join vs.cabin cab on cab.id = bl.assigned_cabin_id
              where bl.booking_cabin_id = f.booking_cabin_id order by bl.created_at desc limit 1) as cabin,
             jsonb_build_object('date', s.embark_date, 'port',
               jsonb_build_object('nameAr', ep.name_ar, 'nameEn', ep.name_en)) as embark,
             jsonb_build_object('date', s.disembark_date, 'port',
               jsonb_build_object('nameAr', dp.name_ar, 'nameEn', dp.name_en)) as disembark
      from vs.folio f
      join vs.vessel v on v.id = f.vessel_id
      join vs.booking b on b.id = f.booking_id
      join vs.channel ch on ch.id = b.channel_id
      join vs.sailing s on s.id = b.sailing_id
      join vs.port ep on ep.id = s.embark_port_id
      join vs.port dp on dp.id = s.disembark_port_id
      where f.id = ${folioId}`.execute(tx);
    const head = rows[0];
    if (!head) throw new DomainError('NOT_FOUND', { message: 'Folio not found' });
    const guests = (
      await tx
        .selectFrom('guest')
        .select(['first_name', 'last_name'])
        .where('booking_cabin_id', '=', head.bookingCabinId)
        .orderBy('lead', 'desc')
        .orderBy('created_at')
        .execute()
    ).map((g) => `${g.first_name} ${g.last_name}`);
    const lines = await tx
      .selectFrom('folio_charge')
      .selectAll()
      .where('folio_id', '=', folioId)
      .orderBy('charged_on')
      .orderBy('posted_at')
      .execute();
    const voided = new Set(lines.flatMap((l) => (l.voids_charge_id ? [l.voids_charge_id] : [])));
    const charges = lines
      .filter((l) => !l.voids_charge_id && !voided.has(l.id))
      .map((l) => ({
        chargedOn: l.charged_on,
        category: l.category as ExtraCategory,
        descriptionAr: l.description_ar,
        descriptionEn: l.description_en,
        guestName: l.guest_name,
        quantity: l.quantity,
        unitAmount: l.unit_amount,
        amount: l.amount,
      }));
    const byCategory: GuestFolioData['byCategory'] = {};
    for (const c of charges) byCategory[c.category] = (byCategory[c.category] ?? 0n) + c.amount;
    let invoice: GuestFolioData['invoice'] = null;
    if (head.invoiceId) {
      const inv = await tx
        .selectFrom('invoice')
        .select([
          'number',
          'issue_date',
          'subtotal',
          'tax_total',
          'total',
          'amount_paid',
          'amount_credited',
        ])
        .where('id', '=', head.invoiceId)
        .executeTakeFirstOrThrow();
      const payments = await tx
        .selectFrom('allocation as a')
        .innerJoin('receipt as r', 'r.id', 'a.receipt_id')
        .select([
          'r.received_on as receivedOn',
          'r.method',
          sql<bigint>`sum(a.amount)::bigint`.as('amount'),
          'r.currency',
          sql<bigint>`sum(a.invoice_amount)::bigint`.as('invoiceAmount'),
        ])
        .where('a.invoice_id', '=', head.invoiceId)
        .groupBy(['r.id', 'r.received_on', 'r.method', 'r.currency'])
        .having(sql`sum(a.invoice_amount)`, '<>', 0)
        .orderBy('r.received_on')
        .execute();
      invoice = {
        number: inv.number!,
        issueDate: inv.issue_date!,
        subtotal: inv.subtotal,
        taxTotal: inv.tax_total,
        total: inv.total,
        balance: inv.total - inv.amount_credited - inv.amount_paid,
        payments,
      };
    }
    const { bookingCabinId: _b, invoiceId: _i, ...rest } = head;
    return {
      ...rest,
      guests,
      charges,
      byCategory,
      total: charges.reduce((s, c) => s + c.amount, 0n),
      invoice,
    };
  });
}

export interface FolioShiftReportData {
  vessel: string;
  date: string;
  currency: string;
  /** Charges posted that day by category (voids posted that day deducted). */
  byCategory: { category: ExtraCategory; charges: number; amount: bigint }[];
  charged: bigint;
  voids: {
    cabin: string | null;
    description: string;
    amount: bigint;
    reason: string;
    by: string | null;
  }[];
  /** Money taken at reception that day for folios, one row per payment. */
  payments: {
    cabin: string | null;
    invoice: string;
    method: string;
    amount: bigint;
    currency: string;
    by: string | null;
    at: Date;
  }[];
  /** Per method and currency: the cash is what the purser hands over. */
  takings: { method: string; currency: string; amount: bigint }[];
  closed: { count: number; total: bigint; toAgency: number };
  open: { count: number; total: bigint };
}

/**
 * The purser's report for one vessel and day: what was charged and voided, what was taken at
 * reception (cash to hand over by currency), folios closed and still open.
 */
export async function folioShiftReportData(
  db: VsDatabase,
  ctx: EngineContext,
  vesselId: string,
  date: string,
): Promise<FolioShiftReportData> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const vessel = await tx
      .selectFrom('vessel')
      .select(['name', 'folio_currency'])
      .where('id', '=', vesselId)
      .executeTakeFirst();
    if (!vessel) throw new DomainError('NOT_FOUND', { message: 'Vessel not found' });
    const cabinOf = sql<string | null>`(select cab.number from vs.booking_line bl
      join vs.cabin cab on cab.id = bl.assigned_cabin_id
      where bl.booking_cabin_id = f.booking_cabin_id order by bl.created_at desc limit 1)`;
    const byCategory = await sql<{ category: ExtraCategory; charges: number; amount: bigint }>`
      select c.category,
             (count(*) filter (where c.voids_charge_id is null) - count(*) filter (where c.voids_charge_id is not null))::int as charges,
             sum(c.amount)::bigint as amount
      from vs.folio_charge c join vs.folio f on f.id = c.folio_id
      where f.vessel_id = ${vesselId} and c.charged_on = ${date}::date
      group by c.category
      order by array_position(${sql.val(EXTRA_CATEGORIES)}::text[], c.category)`.execute(tx);
    const voids = await sql<FolioShiftReportData['voids'][number]>`
      select ${cabinOf} as cabin, c.description_en as description, c.amount, c.void_reason as reason,
             s.display_name as by
      from vs.folio_charge c join vs.folio f on f.id = c.folio_id
      left join vs.staff_user s on s.id = c.posted_by
      where f.vessel_id = ${vesselId} and c.charged_on = ${date}::date and c.voids_charge_id is not null
      order by c.posted_at`.execute(tx);
    const payments = await sql<FolioShiftReportData['payments'][number]>`
      select ${cabinOf} as cabin, i.number as invoice, r.method, r.amount, r.currency,
             s.display_name as by, r.created_at as at
      from vs.receipt r
      join vs.allocation a on a.receipt_id = r.id and a.reason = 'allocated'
      join vs.folio f on f.invoice_id = a.invoice_id
      join vs.invoice i on i.id = f.invoice_id
      left join vs.staff_user s on s.id = r.received_by
      where f.vessel_id = ${vesselId} and r.received_on = ${date}::date and r.kind = 'receipt'
      order by r.created_at`.execute(tx);
    const takings = new Map<string, FolioShiftReportData['takings'][number]>();
    for (const p of payments.rows) {
      const key = `${p.method}|${p.currency}`;
      const t = takings.get(key);
      if (t) t.amount += p.amount;
      else takings.set(key, { method: p.method, currency: p.currency, amount: p.amount });
    }
    const closed = await sql<{ count: number; total: bigint | null; toAgency: number }>`
      select count(*)::int as count, sum(i.total)::bigint as total,
             count(*) filter (where f.bill_to = 'agency')::int as "toAgency"
      from vs.folio f join vs.invoice i on i.id = f.invoice_id
      where f.vessel_id = ${vesselId} and f.status = 'closed'
        and (f.closed_at at time zone 'Africa/Cairo')::date = ${date}::date`.execute(tx);
    const open = await sql<{ count: number; total: bigint | null }>`
      select count(distinct f.id)::int as count, sum(c.amount)::bigint as total
      from vs.folio f left join vs.folio_charge c on c.folio_id = f.id
      where f.vessel_id = ${vesselId} and f.status = 'open'`.execute(tx);
    const categories = byCategory.rows.map((r) => ({ ...r, amount: BigInt(r.amount) }));
    return {
      vessel: vessel.name,
      date,
      currency: vessel.folio_currency,
      byCategory: categories,
      charged: categories.reduce((s, r) => s + r.amount, 0n),
      voids: voids.rows.map((v) => ({ ...v, amount: BigInt(v.amount) })),
      payments: payments.rows.map((p) => ({ ...p, amount: BigInt(p.amount) })),
      takings: [...takings.values()],
      closed: {
        count: closed.rows[0]!.count,
        total: BigInt(closed.rows[0]!.total ?? 0),
        toAgency: closed.rows[0]!.toAgency,
      },
      open: { count: open.rows[0]!.count, total: BigInt(open.rows[0]!.total ?? 0) },
    };
  });
}
