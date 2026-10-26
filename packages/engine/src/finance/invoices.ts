import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { currencySchema, mulDivHalfUp } from '@vs/shared';
import { audit } from '../audit';
import { cairoToday, parseInput, type EngineContext, type Tx } from '../internal';
import { dateSchema } from '../schedule/setup';
import { loadFinanceSettings } from './settings';
import { ensureBookingParty } from './parties';

/**
 * Invoices, proformas and credit notes (invoicing F1, docs/invoicing-plan.md § 3.3).
 *
 * - A proforma «فاتورة مبدئية» has no number, is referenced by booking ref, and can be edited or
 *   deleted. Issuing a proforma copies it into an invoice; the proforma stays as it was.
 * - An invoice gets its number when issued, from a counter taken under a row lock in the same
 *   transaction, so numbers have no gaps. After that the database refuses every change except
 *   its status and the amounts paid and credited.
 * - A mistake is corrected by a credit note (full or by line), never by editing.
 * - A booking is on at most one open invoice: it can be invoiced again only once its earlier
 *   invoice is fully credited.
 *
 * Rounding: tax is computed per line, half-up, once (inclusive: amount × bps ÷ (10000 + bps)).
 * Totals are sums of the rounded lines. An invoice is in its bookings' currency.
 */

const minor = z
  .union([z.bigint(), z.number().int(), z.string().regex(/^-?\d+$/)])
  .transform(BigInt);
const fxRateSchema = z
  .string()
  .regex(/^[0-9]+(\.[0-9]{1,6})?$/, 'A decimal rate with at most 6 decimals')
  .refine((v) => Number(v) > 0, 'Must be above zero');

const manualLine = z.object({
  descriptionAr: z.string().trim().min(1).max(300),
  descriptionEn: z.string().trim().min(1).max(300),
  quantity: z.number().int().min(1).max(10_000).default(1),
  unitAmount: minor,
  taxRateId: z.uuid().nullable().optional(),
});

const INVOICEABLE = ['confirmed', 'completed', 'cancelled'] as const;
const PROFORMA_OK = ['requested', 'held', 'offered', 'confirmed', 'completed'] as const;

export const createInvoiceDraftInput = z
  .object({
    type: z.enum(['proforma', 'invoice']),
    bookingIds: z.array(z.uuid()).max(200).default([]),
    /** Required when there are no bookings: whom a manual invoice is for. */
    billingPartyId: z.uuid().optional(),
    currency: currencySchema.optional(),
    manualLines: z.array(manualLine).max(100).default([]),
    locale: z.enum(['ar', 'en', 'both']).default('ar'),
    dueDate: dateSchema.optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.bookingIds.length > 0 || (v.billingPartyId && v.currency), {
    message: 'Choose bookings, or a billing party and a currency for a manual invoice',
  })
  .refine((v) => v.bookingIds.length > 0 || v.manualLines.length > 0, {
    message: 'An invoice needs at least one line',
  });

interface DraftLine {
  kind: 'cabin' | 'fee' | 'penalty' | 'commission' | 'manual';
  booking_id: string | null;
  booking_cabin_id: string | null;
  description_ar: string;
  description_en: string;
  quantity: number;
  unit_amount: bigint;
  tax_rate_id: string | null;
}

interface TaxRow {
  id: string;
  name_ar: string;
  name_en: string;
  rate_bps: number;
  inclusive: boolean;
}

/** Tax on one line, rounded half-up once. Exported for the rounding tests. */
export function lineTax(amount: bigint, bps: number, inclusive: boolean): bigint {
  if (bps === 0) return 0n;
  return inclusive
    ? mulDivHalfUp(amount, BigInt(bps), BigInt(10_000 + bps))
    : mulDivHalfUp(amount, BigInt(bps), 10_000n);
}

/** Subtotal (before tax), tax and total of lines. */
export function invoiceTotals(
  lines: { amount: bigint; tax_amount: bigint; tax_inclusive: boolean | null }[],
) {
  let subtotal = 0n;
  let taxTotal = 0n;
  for (const line of lines) {
    subtotal += line.tax_inclusive ? line.amount - line.tax_amount : line.amount;
    taxTotal += line.tax_amount;
  }
  return { subtotal, taxTotal, total: subtotal + taxTotal };
}

interface QuoteLine {
  cabin: number;
  kind: string;
  amount: string;
  inTotal: boolean;
}

/** The lines a booking puts on an invoice, from its frozen quote (never re-priced). */
async function bookingLines(
  tx: Tx,
  booking: {
    id: string;
    ref: string;
    status: string;
    quote_id: string;
    sailing_id: string;
    fees: bigint;
    penalty_amount: bigint | null;
  },
  agency: boolean,
  defaultTax: string | null,
): Promise<DraftLine[]> {
  const base = { booking_id: booking.id, quantity: 1, tax_rate_id: defaultTax };
  const sailing = await tx
    .selectFrom('sailing')
    .select(['embark_date', 'disembark_date', 'nights'])
    .where('id', '=', booking.sailing_id)
    .executeTakeFirstOrThrow();
  const trip = `${sailing.embark_date} → ${sailing.disembark_date}`;
  // Dates and refs read left to right inside Arabic text (Unicode isolates, invisible).
  const iso = (text: string) => `\u2066${text}\u2069`;
  const lines: DraftLine[] = [];
  if (booking.status === 'cancelled') {
    if ((booking.penalty_amount ?? 0n) > 0n)
      lines.push({
        ...base,
        kind: 'penalty',
        booking_cabin_id: null,
        description_ar: `غرامة إلغاء — حجز ${iso(booking.ref)}`,
        description_en: `Cancellation penalty — booking ${booking.ref}`,
        unit_amount: booking.penalty_amount!,
      });
  } else {
    const quote = await tx
      .selectFrom('quote')
      .select('lines')
      .where('id', '=', booking.quote_id)
      .executeTakeFirstOrThrow();
    const quoteLines = quote.lines as unknown as QuoteLine[];
    const cabins = await tx
      .selectFrom('booking_cabin as bc')
      .innerJoin('cabin_category as c', 'c.id', 'bc.category_id')
      .select(['bc.id', 'bc.seq', 'bc.adults', 'bc.child_ages', 'c.name_ar', 'c.name_en'])
      .where('bc.booking_id', '=', booking.id)
      .where('bc.status', '=', 'active')
      .orderBy('bc.seq')
      .execute();
    for (const cabin of cabins) {
      const amount = quoteLines
        .filter((l) => l.cabin === cabin.seq && l.inTotal)
        .reduce((s, l) => s + BigInt(l.amount), 0n);
      const children = cabin.child_ages.length;
      const guestsEn = `${cabin.adults} adult${cabin.adults === 1 ? '' : 's'}${children ? `, ${children} child${children === 1 ? '' : 'ren'}` : ''}`;
      const guestsAr = `${cabin.adults} بالغ${children ? `، ${children} طفل` : ''}`;
      lines.push({
        ...base,
        kind: 'cabin',
        booking_cabin_id: cabin.id,
        description_ar: `كابينة ${cabin.name_ar} (${guestsAr}) — ${sailing.nights} ليالٍ ${iso(trip)} — حجز ${iso(booking.ref)}`,
        description_en: `${cabin.name_en} cabin (${guestsEn}) — ${sailing.nights} nights ${trip} — booking ${booking.ref}`,
        unit_amount: amount,
      });
    }
    // Contracts priced gross with commission: the invoice shows the gross and deducts the
    // commission, so its total is what the agency owes.
    const commission = quoteLines
      .filter((l) => l.kind === 'commission')
      .reduce((s, l) => s + BigInt(l.amount), 0n);
    if (agency && commission > 0n)
      lines.push({
        ...base,
        kind: 'commission',
        booking_cabin_id: null,
        description_ar: `خصم عمولة الوكيل — حجز ${iso(booking.ref)}`,
        description_en: `Agency commission deducted — booking ${booking.ref}`,
        unit_amount: -commission,
      });
  }
  if (booking.fees > 0n)
    lines.push({
      ...base,
      kind: 'fee',
      booking_cabin_id: null,
      description_ar: `رسوم تعديل — حجز ${iso(booking.ref)}`,
      description_en: `Amendment fees — booking ${booking.ref}`,
      unit_amount: booking.fees,
    });
  return lines;
}

/** Writes lines with their tax snapshots and returns the invoice totals. */
async function writeLines(tx: Tx, operatorId: string, invoiceId: string, lines: DraftLine[]) {
  const taxIds = [...new Set(lines.map((l) => l.tax_rate_id).filter((id): id is string => !!id))];
  const taxes = new Map<string, TaxRow>();
  if (taxIds.length) {
    const rows = await tx
      .selectFrom('tax_rate')
      .select(['id', 'name_ar', 'name_en', 'rate_bps', 'inclusive', 'active'])
      .where('id', 'in', taxIds)
      .execute();
    for (const row of rows) {
      if (!row.active)
        throw new DomainError('VALIDATION_FAILED', {
          message: `Tax ${row.name_en} is no longer active`,
        });
      taxes.set(row.id, row);
    }
    const missing = taxIds.find((id) => !taxes.has(id));
    if (missing)
      throw new DomainError('NOT_FOUND', {
        message: 'Tax not found',
        details: { taxRateId: missing },
      });
  }
  await tx.deleteFrom('invoice_line').where('invoice_id', '=', invoiceId).execute();
  const rows = lines.map((line, seq) => {
    const tax = line.tax_rate_id ? taxes.get(line.tax_rate_id)! : null;
    const amount = BigInt(line.quantity) * line.unit_amount;
    return {
      operator_id: operatorId,
      invoice_id: invoiceId,
      seq,
      kind: line.kind,
      booking_id: line.booking_id,
      booking_cabin_id: line.booking_cabin_id,
      description_ar: line.description_ar,
      description_en: line.description_en,
      quantity: line.quantity,
      unit_amount: line.unit_amount,
      amount,
      tax_rate_id: tax?.id ?? null,
      tax_name_ar: tax?.name_ar ?? null,
      tax_name_en: tax?.name_en ?? null,
      tax_bps: tax?.rate_bps ?? null,
      tax_inclusive: tax?.inclusive ?? null,
      tax_amount: tax ? lineTax(amount, tax.rate_bps, tax.inclusive) : 0n,
    };
  });
  if (rows.length) await tx.insertInto('invoice_line').values(rows).execute();
  const totals = invoiceTotals(rows);
  await tx
    .updateTable('invoice')
    .set({ subtotal: totals.subtotal, tax_total: totals.taxTotal, total: totals.total })
    .where('id', '=', invoiceId)
    .execute();
  return totals;
}

/**
 * Bookings already on an open invoice (a draft or issued invoice not fully credited), other than
 * `exceptInvoiceId`. Callers hold the booking row locks.
 */
async function bookingsOnOpenInvoices(tx: Tx, bookingIds: string[], exceptInvoiceId?: string) {
  if (!bookingIds.length) return [];
  let query = tx
    .selectFrom('invoice_line as l')
    .innerJoin('invoice as i', 'i.id', 'l.invoice_id')
    .innerJoin('booking as b', 'b.id', 'l.booking_id')
    .select(['b.ref', 'i.number', 'i.status'])
    .distinct()
    .where('l.booking_id', 'in', bookingIds)
    .where('i.type', '=', 'invoice')
    .where('i.status', '<>', 'cancelled')
    .where((eb) =>
      eb.or([eb('i.status', '=', 'draft'), eb('i.amount_credited', '<', eb.ref('i.total'))]),
    );
  if (exceptInvoiceId) query = query.where('i.id', '<>', exceptInvoiceId);
  return query.execute();
}

async function lockBookings(tx: Tx, bookingIds: string[]) {
  const bookings = await tx
    .selectFrom('booking as b')
    .innerJoin('channel as ch', 'ch.id', 'b.channel_id')
    .innerJoin('channel_contract as cc', 'cc.id', 'b.contract_id')
    .select([
      'b.id',
      'b.ref',
      'b.status',
      'b.currency',
      'b.quote_id',
      'b.sailing_id',
      'b.fees',
      'b.penalty_amount',
      'b.channel_id',
      'ch.type as channel_type',
      'cc.payment_mode',
      'cc.credit_terms_days',
    ])
    .where('b.id', 'in', bookingIds)
    .orderBy('b.id')
    .forUpdate('b')
    .execute();
  if (bookings.length !== new Set(bookingIds).size)
    throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
  return bookings;
}

/** Creates a proforma or a draft invoice from bookings and/or manual lines. */
export async function createInvoiceDraft(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createInvoiceDraftInput>,
) {
  const data = parseInput(createInvoiceDraftInput, input);
  const bookingIds = [...new Set(data.bookingIds)];
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const settings = await loadFinanceSettings(tx);
    const defaultTax = await tx
      .selectFrom('tax_rate')
      .select('id')
      .where('is_default', '=', true)
      .where('active', '=', true)
      .executeTakeFirst();
    const bookings = bookingIds.length ? await lockBookings(tx, bookingIds) : [];
    const allowed: readonly string[] = data.type === 'proforma' ? PROFORMA_OK : INVOICEABLE;
    for (const b of bookings) {
      if (!allowed.includes(b.status))
        throw new DomainError('INVALID_STATE', {
          message: `Booking ${b.ref} is ${b.status}; it cannot go on ${data.type === 'proforma' ? 'a proforma' : 'an invoice'}`,
          details: { ref: b.ref, status: b.status },
        });
    }
    const currencies = new Set(bookings.map((b) => b.currency));
    if (currencies.size > 1 || (data.currency && bookings.length && !currencies.has(data.currency)))
      throw new DomainError('VALIDATION_FAILED', {
        message: 'All bookings on one invoice must be in the same currency',
      });
    const currency = bookings[0]?.currency ?? data.currency!;
    if (!settings.invoice_currencies.includes(currency))
      throw new DomainError('VALIDATION_FAILED', {
        message: `${currency} is not one of the company's invoice currencies`,
      });

    // Every booking must bill the same party.
    let partyId = data.billingPartyId ?? null;
    let agency = false;
    for (const b of bookings) {
      const party = await ensureBookingParty(tx, ctx, b);
      if (partyId && partyId !== party.id)
        throw new DomainError('VALIDATION_FAILED', {
          message: 'All bookings on one invoice must be billed to the same party',
          details: { ref: b.ref },
        });
      partyId = party.id;
      agency = party.kind === 'agency';
    }
    if (!bookings.length) {
      const party = await tx
        .selectFrom('billing_party')
        .select('id')
        .where('id', '=', partyId!)
        .executeTakeFirst();
      if (!party) throw new DomainError('NOT_FOUND', { message: 'Billing party not found' });
    }

    if (data.type === 'invoice') {
      const open = await bookingsOnOpenInvoices(tx, bookingIds);
      if (open.length)
        throw new DomainError('INVALID_STATE', {
          message: `Booking ${open[0]!.ref} is already on ${open[0]!.number ?? 'a draft invoice'}; credit it first`,
          details: { refs: open.map((o) => o.ref) },
        });
    }

    const lines: DraftLine[] = [];
    for (const b of bookings)
      lines.push(...(await bookingLines(tx, b, agency, defaultTax?.id ?? null)));
    for (const m of data.manualLines)
      lines.push({
        kind: 'manual',
        booking_id: null,
        booking_cabin_id: null,
        description_ar: m.descriptionAr,
        description_en: m.descriptionEn,
        quantity: m.quantity,
        unit_amount: m.unitAmount,
        tax_rate_id: m.taxRateId ?? null,
      });
    if (!lines.length)
      throw new DomainError('VALIDATION_FAILED', {
        message: 'Nothing to invoice on these bookings',
      });

    const invoice = await tx
      .insertInto('invoice')
      .values({
        operator_id: ctx.operatorId,
        type: data.type,
        billing_party_id: partyId!,
        currency,
        base_currency: settings.base_currency,
        locale: data.locale,
        due_date: data.dueDate ?? null,
        notes: data.notes ?? null,
        created_by: ctx.actor.type === 'staff' ? ctx.actor.id : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const totals = await writeLines(tx, ctx.operatorId, invoice.id, lines);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: `${data.type}.created`,
      entity: 'invoice',
      entityId: invoice.id,
      after: {
        bookings: bookings.map((b) => b.ref),
        currency,
        total: totals.total,
        lines: lines.length,
      },
    });
    return { invoiceId: invoice.id, ...totals };
  });
}

export const updateInvoiceDraftInput = z.object({
  invoiceId: z.uuid(),
  manualLines: z.array(manualLine).max(100).optional(),
  locale: z.enum(['ar', 'en', 'both']).optional(),
  dueDate: dateSchema.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

async function lockDraft(tx: Tx, invoiceId: string) {
  const invoice = await tx
    .selectFrom('invoice')
    .selectAll()
    .where('id', '=', invoiceId)
    .forUpdate()
    .executeTakeFirst();
  if (!invoice) throw new DomainError('NOT_FOUND', { message: 'Invoice not found' });
  if (invoice.status !== 'draft')
    throw new DomainError('INVALID_STATE', {
      message: `${invoice.number} is issued; correct it with a credit note`,
    });
  return invoice;
}

/** Edits a proforma or draft invoice: its manual lines (booking lines stay), language, dates, note. */
export async function updateInvoiceDraft(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateInvoiceDraftInput>,
) {
  const data = parseInput(updateInvoiceDraftInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const invoice = await lockDraft(tx, data.invoiceId);
    const set: Record<string, unknown> = {};
    if (data.locale !== undefined) set.locale = data.locale;
    if (data.dueDate !== undefined) set.due_date = data.dueDate;
    if (data.notes !== undefined) set.notes = data.notes || null;
    if (Object.keys(set).length)
      await tx.updateTable('invoice').set(set).where('id', '=', invoice.id).execute();
    let totals = { subtotal: invoice.subtotal, taxTotal: invoice.tax_total, total: invoice.total };
    if (data.manualLines) {
      const kept = await tx
        .selectFrom('invoice_line')
        .select([
          'kind',
          'booking_id',
          'booking_cabin_id',
          'description_ar',
          'description_en',
          'quantity',
          'unit_amount',
          'tax_rate_id',
        ])
        .where('invoice_id', '=', invoice.id)
        .where('kind', '<>', 'manual')
        .orderBy('seq')
        .execute();
      const lines: DraftLine[] = [
        ...(kept as DraftLine[]),
        ...data.manualLines.map((m) => ({
          kind: 'manual' as const,
          booking_id: null,
          booking_cabin_id: null,
          description_ar: m.descriptionAr,
          description_en: m.descriptionEn,
          quantity: m.quantity,
          unit_amount: m.unitAmount,
          tax_rate_id: m.taxRateId ?? null,
        })),
      ];
      if (!lines.length)
        throw new DomainError('VALIDATION_FAILED', {
          message: 'An invoice needs at least one line',
        });
      totals = await writeLines(tx, ctx.operatorId, invoice.id, lines);
    }
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: `${invoice.type}.updated`,
      entity: 'invoice',
      entityId: invoice.id,
      before: { total: invoice.total, locale: invoice.locale, due_date: invoice.due_date },
      after: { total: totals.total, ...set },
    });
    return { invoiceId: invoice.id, ...totals };
  });
}

/** Deletes a proforma or a draft invoice. Issued invoices are never deleted. */
export async function deleteInvoiceDraft(
  db: VsDatabase,
  ctx: EngineContext,
  input: { invoiceId: string },
) {
  const { invoiceId } = parseInput(z.object({ invoiceId: z.uuid() }), input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const invoice = await lockDraft(tx, invoiceId);
    await tx.deleteFrom('invoice').where('id', '=', invoice.id).execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: `${invoice.type}.deleted`,
      entity: 'invoice',
      entityId: invoice.id,
      before: { total: invoice.total, currency: invoice.currency },
    });
    return { deleted: true };
  });
}

/**
 * The next number in a series, gap-free: the counter row is created or bumped under its row lock
 * in the caller's transaction, so concurrent issues queue behind each other and a rollback gives
 * the number back.
 */
async function nextNumber(
  tx: Tx,
  operatorId: string,
  series: 'invoice' | 'credit_note',
  year: number,
  first: number,
) {
  const { rows } = await sql<{ last_seq: number }>`
    insert into vs.document_counter (operator_id, series, year, last_seq)
    values (${operatorId}, ${series}, ${year}, ${first})
    on conflict (operator_id, series, year)
      do update set last_seq = vs.document_counter.last_seq + 1
    returning last_seq`.execute(tx);
  return rows[0]!.last_seq;
}

function formatNumber(prefix: string, year: number, seq: number, digits: number) {
  return `${prefix}-${year}-${String(seq).padStart(digits, '0')}`;
}

/** The company as issuer, as it reads now (frozen onto an invoice when issued). */
export async function issuerSnapshot(tx: Tx) {
  const settings = await loadFinanceSettings(tx);
  const operator = await tx.selectFrom('operator').select('name').executeTakeFirstOrThrow();
  const brand = await tx.selectFrom('operator_branding').selectAll().executeTakeFirst();
  return {
    settings,
    snapshot: {
      name: operator.name,
      legalNameAr: settings.legal_name_ar,
      legalNameEn: settings.legal_name_en,
      addressAr: settings.address_ar ?? brand?.address_ar ?? null,
      addressEn: settings.address_en ?? brand?.address_en ?? null,
      taxRegistrationNo: settings.tax_registration_no,
      commercialRegistrationNo: settings.commercial_registration_no,
      phone: brand?.phone ?? null,
      email: brand?.email ?? null,
      website: brand?.website ?? null,
      bankDetailsAr: settings.bank_details_ar,
      bankDetailsEn: settings.bank_details_en,
      noteAr: settings.invoice_note_ar,
      noteEn: settings.invoice_note_en,
      etaFooter: settings.eta_footer,
    },
  };
}

/** The billing party as it reads now (frozen onto an invoice when issued). */
export async function partySnapshot(tx: Tx, partyId: string) {
  const party = await tx
    .selectFrom('billing_party')
    .selectAll()
    .where('id', '=', partyId)
    .executeTakeFirstOrThrow();
  return {
    kind: party.kind,
    name: party.name,
    legalNameAr: party.legal_name_ar,
    legalNameEn: party.legal_name_en,
    address: party.address,
    taxRegistrationNo: party.tax_registration_no,
    commercialRegistrationNo: party.commercial_registration_no,
    email: party.email,
    phone: party.phone,
    country: party.country,
  };
}

export const issueInvoiceInput = z.object({
  /** A draft invoice, or a proforma (copied into a new invoice that is issued). */
  invoiceId: z.uuid(),
  /** Required when the invoice currency differs from the company's base currency. */
  fxRate: fxRateSchema.optional(),
  fxSource: z.string().trim().min(1).max(100).optional(),
  fxDate: dateSchema.optional(),
});

/** Issues an invoice: today's date (no back-dating), the next number, frozen snapshots. */
export async function issueInvoice(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof issueInvoiceInput>,
) {
  const data = parseInput(issueInvoiceInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    let draft = await lockDraft(tx, data.invoiceId);
    const proformaId = draft.type === 'proforma' ? draft.id : null;
    if (draft.type === 'credit_note')
      throw new DomainError('INVALID_STATE', { message: 'Credit notes are issued when created' });
    const lines = await tx
      .selectFrom('invoice_line')
      .selectAll()
      .where('invoice_id', '=', draft.id)
      .orderBy('seq')
      .execute();
    const bookingIds = [
      ...new Set(lines.map((l) => l.booking_id).filter((id): id is string => !!id)),
    ];
    const bookings = bookingIds.length ? await lockBookings(tx, bookingIds) : [];
    for (const b of bookings) {
      if (!(INVOICEABLE as readonly string[]).includes(b.status))
        throw new DomainError('INVALID_STATE', {
          message: `Booking ${b.ref} is ${b.status}; only confirmed, completed or cancelled bookings are invoiced`,
          details: { ref: b.ref, status: b.status },
        });
    }
    const open = await bookingsOnOpenInvoices(tx, bookingIds, draft.id);
    if (open.length)
      throw new DomainError('INVALID_STATE', {
        message: `Booking ${open[0]!.ref} is already on ${open[0]!.number ?? 'a draft invoice'}; credit it first`,
        details: { refs: open.map((o) => o.ref) },
      });
    if (draft.total <= 0n)
      throw new DomainError('VALIDATION_FAILED', {
        message: 'An invoice total must be above zero',
      });
    const { settings, snapshot } = await issuerSnapshot(tx);
    if (draft.currency !== settings.base_currency && !data.fxRate)
      throw new DomainError('VALIDATION_FAILED', {
        message: `An exchange rate ${draft.currency} → ${settings.base_currency} is required to issue`,
        details: { field: 'fxRate' },
      });
    if (draft.currency === settings.base_currency && data.fxRate)
      throw new DomainError('VALIDATION_FAILED', {
        message: 'No exchange rate for an invoice in the base currency',
      });

    if (proformaId) {
      // The proforma stays as it was; a copy becomes the invoice.
      const copy = await tx
        .insertInto('invoice')
        .values({
          operator_id: ctx.operatorId,
          type: 'invoice',
          billing_party_id: draft.billing_party_id,
          currency: draft.currency,
          base_currency: settings.base_currency,
          locale: draft.locale,
          due_date: draft.due_date,
          notes: draft.notes,
          created_by: ctx.actor.type === 'staff' ? ctx.actor.id : null,
          subtotal: draft.subtotal,
          tax_total: draft.tax_total,
          total: draft.total,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('invoice_line')
        .values(
          lines.map(({ id: _id, created_at: _c, invoice_id: _i, ...line }) => ({
            ...line,
            invoice_id: copy.id,
          })),
        )
        .execute();
      draft = copy;
    }

    const today = await cairoToday(tx);
    const year = Number(today.slice(0, 4));
    const seq = await nextNumber(
      tx,
      ctx.operatorId,
      'invoice',
      year,
      settings.first_invoice_number,
    );
    const number = formatNumber(settings.invoice_prefix, year, seq, settings.number_digits);
    const terms =
      bookings.find((b) => b.credit_terms_days !== null)?.credit_terms_days ??
      settings.default_terms_days;
    const dueDate =
      draft.due_date ??
      (await sql<{ d: string }>`select (${today}::date + ${terms}::int)::text as d`.execute(tx))
        .rows[0]!.d;
    const issued = await tx
      .updateTable('invoice')
      .set({
        status: 'issued',
        series: 'invoice',
        year,
        seq,
        number,
        base_currency: settings.base_currency,
        fx_rate: data.fxRate ?? null,
        fx_source: data.fxRate ? (data.fxSource ?? 'typed') : null,
        fx_date: data.fxRate ? (data.fxDate ?? today) : null,
        issue_date: today,
        due_date: dueDate < today ? today : dueDate,
        party_snapshot: JSON.stringify(await partySnapshot(tx, draft.billing_party_id)),
        issuer_snapshot: JSON.stringify(snapshot),
        issued_by: ctx.actor.type === 'staff' ? ctx.actor.id : null,
        issued_at: sql`now()`,
      })
      .where('id', '=', draft.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'invoice.issued',
      entity: 'invoice',
      entityId: issued.id,
      after: {
        number,
        proformaId,
        total: issued.total,
        currency: issued.currency,
        fx_rate: issued.fx_rate,
        bookings: bookings.map((b) => b.ref),
      },
    });
    return {
      invoiceId: issued.id,
      number,
      issueDate: today,
      dueDate: issued.due_date!,
      total: issued.total,
    };
  });
}

export const creditNoteInput = z.object({
  invoiceId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
  /** Omitted: credit the whole remaining invoice. Otherwise the lines and amounts to credit. */
  lines: z
    .array(z.object({ lineId: z.uuid(), amount: minor.refine((v) => v > 0n, 'Must be positive') }))
    .min(1)
    .max(200)
    .optional(),
});

/**
 * Issues a credit note against an issued invoice, in the same currency and at the same rate.
 * Credit note lines carry positive amounts; the invoice's `amount_credited` rises by the credit
 * note total, and a fully credited invoice becomes `cancelled`.
 */
export async function issueCreditNote(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof creditNoteInput>,
) {
  const data = parseInput(creditNoteInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const invoice = await tx
      .selectFrom('invoice')
      .selectAll()
      .where('id', '=', data.invoiceId)
      .forUpdate()
      .executeTakeFirst();
    if (!invoice) throw new DomainError('NOT_FOUND', { message: 'Invoice not found' });
    if (invoice.type !== 'invoice' || invoice.status === 'draft')
      throw new DomainError('INVALID_STATE', { message: 'Only an issued invoice can be credited' });
    const remaining = invoice.total - invoice.amount_credited;
    if (remaining <= 0n)
      throw new DomainError('INVALID_STATE', {
        message: `${invoice.number} is already fully credited`,
      });
    const original = await tx
      .selectFrom('invoice_line')
      .selectAll()
      .where('invoice_id', '=', invoice.id)
      .orderBy('seq')
      .execute();

    let lines: DraftLine[];
    let taxSnapshots: (typeof original)[number][];
    if (!data.lines) {
      if (invoice.amount_credited > 0n)
        throw new DomainError('VALIDATION_FAILED', {
          message: `${invoice.number} is partly credited; choose the lines to credit`,
        });
      taxSnapshots = original;
      lines = original.map((l) => ({
        kind: l.kind as DraftLine['kind'],
        booking_id: l.booking_id,
        booking_cabin_id: l.booking_cabin_id,
        description_ar: l.description_ar,
        description_en: l.description_en,
        quantity: l.quantity,
        unit_amount: l.unit_amount,
        tax_rate_id: l.tax_rate_id,
      }));
    } else {
      const byId = new Map(original.map((l) => [l.id, l]));
      taxSnapshots = [];
      lines = data.lines.map((pick) => {
        const line = byId.get(pick.lineId);
        if (!line) throw new DomainError('NOT_FOUND', { message: 'Invoice line not found' });
        if (line.amount <= 0n || pick.amount > line.amount)
          throw new DomainError('VALIDATION_FAILED', {
            message: `Line ${line.seq + 1} can be credited up to its amount`,
          });
        taxSnapshots.push(line);
        return {
          kind: line.kind as DraftLine['kind'],
          booking_id: line.booking_id,
          booking_cabin_id: line.booking_cabin_id,
          description_ar: line.description_ar,
          description_en: line.description_en,
          quantity: 1,
          unit_amount: pick.amount,
          tax_rate_id: line.tax_rate_id,
        };
      });
    }

    const { settings, snapshot } = await issuerSnapshot(tx);
    const today = await cairoToday(tx);
    const year = Number(today.slice(0, 4));
    const note = await tx
      .insertInto('invoice')
      .values({
        operator_id: ctx.operatorId,
        type: 'credit_note',
        billing_party_id: invoice.billing_party_id,
        credits_invoice_id: invoice.id,
        credit_reason: data.reason,
        currency: invoice.currency,
        base_currency: invoice.base_currency,
        locale: invoice.locale,
        created_by: ctx.actor.type === 'staff' ? ctx.actor.id : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Tax is taken from the original line's snapshot, not today's rate.
    const rows = lines.map((line, seq) => {
      const source = taxSnapshots[seq]!;
      const amount = BigInt(line.quantity) * line.unit_amount;
      return {
        operator_id: ctx.operatorId,
        invoice_id: note.id,
        seq,
        kind: line.kind,
        booking_id: line.booking_id,
        booking_cabin_id: line.booking_cabin_id,
        description_ar: line.description_ar,
        description_en: line.description_en,
        quantity: line.quantity,
        unit_amount: line.unit_amount,
        amount,
        tax_rate_id: source.tax_rate_id,
        tax_name_ar: source.tax_name_ar,
        tax_name_en: source.tax_name_en,
        tax_bps: source.tax_bps,
        tax_inclusive: source.tax_inclusive,
        tax_amount:
          source.tax_bps !== null ? lineTax(amount, source.tax_bps, source.tax_inclusive!) : 0n,
      };
    });
    await tx.insertInto('invoice_line').values(rows).execute();
    const totals = invoiceTotals(rows);
    if (totals.total <= 0n || totals.total > remaining)
      throw new DomainError('VALIDATION_FAILED', {
        message: `A credit note on ${invoice.number} must be above zero and at most ${remaining}`,
        details: { remaining: remaining.toString(), total: totals.total.toString() },
      });
    const seq = await nextNumber(
      tx,
      ctx.operatorId,
      'credit_note',
      year,
      settings.first_credit_note_number,
    );
    const number = formatNumber(settings.credit_note_prefix, year, seq, settings.number_digits);
    await tx
      .updateTable('invoice')
      .set({
        status: 'issued',
        series: 'credit_note',
        year,
        seq,
        number,
        subtotal: totals.subtotal,
        tax_total: totals.taxTotal,
        total: totals.total,
        fx_rate: invoice.fx_rate,
        fx_source: invoice.fx_source,
        fx_date: invoice.fx_date,
        issue_date: today,
        party_snapshot: JSON.stringify(await partySnapshot(tx, invoice.billing_party_id)),
        issuer_snapshot: JSON.stringify(snapshot),
        issued_by: ctx.actor.type === 'staff' ? ctx.actor.id : null,
        issued_at: sql`now()`,
      })
      .where('id', '=', note.id)
      .execute();
    const credited = invoice.amount_credited + totals.total;
    await tx
      .updateTable('invoice')
      .set({
        amount_credited: credited,
        ...(credited === invoice.total ? { status: 'cancelled' } : {}),
      })
      .where('id', '=', invoice.id)
      .execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'credit_note.issued',
      entity: 'invoice',
      entityId: note.id,
      after: { number, credits: invoice.number, reason: data.reason, total: totals.total },
    });
    return {
      creditNoteId: note.id,
      number,
      total: totals.total,
      invoiceStatus: credited === invoice.total ? 'cancelled' : invoice.status,
    };
  });
}

export const listInvoicesInput = z.object({
  type: z.enum(['proforma', 'invoice', 'credit_note']).optional(),
  status: z.enum(['draft', 'issued', 'partially_paid', 'paid', 'cancelled']).optional(),
  billingPartyId: z.uuid().optional(),
  bookingId: z.uuid().optional(),
  overdue: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

export async function listInvoices(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof listInvoicesInput> = {},
) {
  const data = parseInput(listInvoicesInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    let query = tx
      .selectFrom('invoice as i')
      .innerJoin('billing_party as p', 'p.id', 'i.billing_party_id')
      .select([
        'i.id',
        'i.type',
        'i.status',
        'i.number',
        'i.currency',
        'i.total',
        'i.amount_paid',
        'i.amount_credited',
        'i.issue_date',
        'i.due_date',
        'i.created_at',
        'p.id as party_id',
        'p.name as party_name',
        'p.kind as party_kind',
        sql<boolean>`i.status in ('issued', 'partially_paid') and i.due_date < (now() at time zone 'Africa/Cairo')::date`.as(
          'overdue',
        ),
      ])
      .orderBy('i.created_at', 'desc')
      .limit(data.limit);
    if (data.type) query = query.where('i.type', '=', data.type);
    if (data.status) query = query.where('i.status', '=', data.status);
    if (data.billingPartyId) query = query.where('i.billing_party_id', '=', data.billingPartyId);
    if (data.bookingId)
      query = query.where('i.id', 'in', (eb) =>
        eb
          .selectFrom('invoice_line')
          .select('invoice_id')
          .where('booking_id', '=', data.bookingId!),
      );
    if (data.overdue)
      query = query
        .where('i.status', 'in', ['issued', 'partially_paid'])
        .where('i.due_date', '<', sql<string>`(now() at time zone 'Africa/Cairo')::date`);
    return query.execute();
  });
}

export async function getInvoice(db: VsDatabase, ctx: EngineContext, input: { invoiceId: string }) {
  const { invoiceId } = parseInput(z.object({ invoiceId: z.uuid() }), input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const invoice = await tx
      .selectFrom('invoice')
      .selectAll()
      .where('id', '=', invoiceId)
      .executeTakeFirst();
    if (!invoice) throw new DomainError('NOT_FOUND', { message: 'Invoice not found' });
    const lines = await tx
      .selectFrom('invoice_line as l')
      .leftJoin('booking as b', 'b.id', 'l.booking_id')
      .selectAll('l')
      .select('b.ref as booking_ref')
      .where('l.invoice_id', '=', invoiceId)
      .orderBy('l.seq')
      .execute();
    const party = await tx
      .selectFrom('billing_party')
      .selectAll()
      .where('id', '=', invoice.billing_party_id)
      .executeTakeFirstOrThrow();
    const creditNotes = await tx
      .selectFrom('invoice')
      .select(['id', 'number', 'total', 'issue_date', 'credit_reason'])
      .where('credits_invoice_id', '=', invoiceId)
      .orderBy('created_at')
      .execute();
    return { invoice, lines, party, creditNotes };
  });
}
