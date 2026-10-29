import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { convert, convertBack, currencySchema, money } from '@vs/shared';
import { audit } from '../audit';
import { insertPayment, withRequestKey } from '../booking/common';
import { cairoToday, parseInput, type EngineContext, type Tx } from '../internal';
import { dateSchema } from '../schedule/setup';
import { ensureBookingParty } from './parties';

/**
 * Receipts and allocations (invoicing F3, docs/invoicing-plan.md § 3.4).
 *
 * - A receipt is money received from (or paid back to) a billing party. Receipts and allocations
 *   are append-only: a mistake is undone by a new, opposite row.
 * - A receipt recorded from a booking (`booking_id` set) is that booking's money. It has one
 *   booking payment, and it pays only that booking's share of its invoices; what is left stays
 *   with the booking (refunded, or used by its next invoice).
 * - A receipt recorded from a party (an agency's remittance) is the party's credit until it is
 *   allocated. Allocating it to an invoice spreads it over the invoice's bookings, oldest sailing
 *   first, and writes a booking payment for each, so booking statuses stay right; taking it back
 *   off writes an `unallocated` entry. For these receipts a booking's payments always equal its
 *   allocations.
 * - Issuing an invoice allocates its bookings' unused money to it; a credit note that leaves an
 *   invoice paid beyond what it still bills takes the excess back off it.
 * - Credit balance of a party, per currency = receipts − allocations.
 */

export const RECEIPT_METHODS = [
  'bank_transfer',
  'cash',
  'card',
  'agency_remittance',
  'platform',
] as const;
export type ReceiptMethod = (typeof RECEIPT_METHODS)[number];

/** Booking ledger method → receipt method (§ 6; "collected by the platform" stays its own). */
export function receiptMethodFor(paymentMethod: string): ReceiptMethod {
  switch (paymentMethod) {
    case 'cash':
      return 'cash';
    case 'bank_transfer':
      return 'bank_transfer';
    case 'card_office':
    case 'gateway':
      return 'card';
    case 'agent_remittance':
      return 'agency_remittance';
    default:
      return 'platform';
  }
}

/** Receipt method → the booking ledger method of the payments it writes. */
function paymentMethodFor(method: string): string {
  switch (method) {
    case 'cash':
      return 'cash';
    case 'bank_transfer':
      return 'bank_transfer';
    case 'card':
      return 'card_office';
    case 'agency_remittance':
      return 'agent_remittance';
    default:
      return 'channel';
  }
}

const positiveMinor = z
  .union([z.bigint(), z.number().int(), z.string().regex(/^\d+$/)])
  .transform(BigInt)
  .refine((v) => v > 0n, 'Must be positive');
const fxRateSchema = z
  .string()
  .regex(/^[0-9]+(\.[0-9]{1,6})?$/, 'A decimal rate with at most 6 decimals')
  .refine((v) => Number(v) > 0, 'Must be above zero');

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const attachmentSchema = z.object({
  /** The file, base64 (no data: prefix). */
  base64: z
    .string()
    .min(1)
    .max(Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 4),
  name: z.string().trim().min(1).max(200),
});

function attachmentType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'application/pdf' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

function readAttachment(input: z.infer<typeof attachmentSchema>) {
  const bytes = Buffer.from(input.base64, 'base64');
  const type = attachmentType(bytes);
  if (!type || bytes.length > ATTACHMENT_MAX_BYTES)
    throw new DomainError('VALIDATION_FAILED', {
      message: !type
        ? 'The attachment must be a PNG or JPEG image or a PDF'
        : 'The attachment must be 5 MB or less',
      details: { field: 'attachment', bytes: bytes.length },
    });
  return { attachment: bytes, attachment_type: type, attachment_name: input.name };
}

const staffId = (ctx: EngineContext) => (ctx.actor.type === 'staff' ? ctx.actor.id : null);

// ---------------------------------------------------------------------------
// Shares and balances
// ---------------------------------------------------------------------------

/** What a line bills, tax included. */
const GROSS = sql<bigint>`case when l.tax_inclusive is not false then l.amount else l.amount + l.tax_amount end`;

interface Share {
  bookingId: string | null;
  /** What the invoice still bills for this booking (or its manual lines): lines − credit notes. */
  share: bigint;
  allocated: bigint;
  embarkDate: string | null;
  ref: string | null;
}

/** Per booking on an invoice (null: its manual lines), oldest sailing first, manual lines last. */
export async function invoiceShares(tx: Tx, invoiceId: string): Promise<Share[]> {
  const { rows } = await sql<{
    booking_id: string | null;
    share: string;
    allocated: string;
    embark_date: string | null;
    ref: string | null;
  }>`
    with billed as (
      select l.booking_id, sum(${GROSS}) as amount from vs.invoice_line l
      where l.invoice_id = ${invoiceId} group by l.booking_id
      union all
      select l.booking_id, -sum(${GROSS}) from vs.invoice_line l
      join vs.invoice cn on cn.id = l.invoice_id
      where cn.credits_invoice_id = ${invoiceId} and cn.status <> 'draft' group by l.booking_id
    ), allocated as (
      select a.booking_id, sum(a.invoice_amount) as amount from vs.allocation a
      where a.invoice_id = ${invoiceId} group by a.booking_id
    ), keys as (
      select booking_id from billed union select booking_id from allocated
    )
    select k.booking_id,
           coalesce((select sum(amount) from billed x where x.booking_id is not distinct from k.booking_id), 0)::text as share,
           coalesce((select amount from allocated x where x.booking_id is not distinct from k.booking_id), 0)::text as allocated,
           s.embark_date::text as embark_date, b.ref
    from keys k
    left join vs.booking b on b.id = k.booking_id
    left join vs.sailing s on s.id = b.sailing_id
    order by k.booking_id is null, s.embark_date, b.ref`.execute(tx);
  return rows.map((r) => ({
    bookingId: r.booking_id,
    share: BigInt(r.share),
    allocated: BigInt(r.allocated),
    embarkDate: r.embark_date,
    ref: r.ref,
  }));
}

/** amount_paid = its allocations; status follows (a fully credited invoice stays cancelled). */
export async function refreshInvoicePaid(tx: Tx, invoiceId: string) {
  await sql`
    update vs.invoice i set
      amount_paid = coalesce((select sum(a.invoice_amount) from vs.allocation a where a.invoice_id = i.id), 0)
    where i.id = ${invoiceId}`.execute(tx);
  await sql`
    update vs.invoice i set status = case
        when i.amount_paid > 0 and i.amount_paid >= i.total - i.amount_credited then 'paid'
        when i.amount_paid > 0 then 'partially_paid'
        else 'issued' end
    where i.id = ${invoiceId} and i.type = 'invoice' and i.status in ('issued', 'partially_paid', 'paid')`.execute(
    tx,
  );
}

/** A booking's money not on any invoice yet, in the booking currency (paid − allocated). */
async function heldForBooking(tx: Tx, bookingId: string): Promise<bigint> {
  const { rows } = await sql<{ held: string }>`
    select (b.amount_paid - coalesce((select sum(a.invoice_amount) from vs.allocation a where a.booking_id = b.id), 0))::text as held
    from vs.booking b where b.id = ${bookingId}`.execute(tx);
  return BigInt(rows[0]?.held ?? '0');
}

/** What is left of a receipt: in its own currency, and (booking receipts) in the booking's. */
async function receiptRemaining(tx: Tx, receiptId: string) {
  const { rows } = await sql<{ amount: string; invoice_amount: string; paid: string | null }>`
    select (r.amount - coalesce((select sum(a.amount) from vs.allocation a where a.receipt_id = r.id), 0))::text as amount,
           coalesce((select sum(a.invoice_amount) from vs.allocation a where a.receipt_id = r.id), 0)::text as invoice_amount,
           (select sum(p.booking_amount) from vs.payment p where p.receipt_id = r.id)::text as paid
    from vs.receipt r where r.id = ${receiptId}`.execute(tx);
  const row = rows[0]!;
  return {
    amount: BigInt(row.amount),
    /** Booking receipts: its payment in the booking currency, less what is allocated. */
    bookingAmount: row.paid === null ? null : BigInt(row.paid) - BigInt(row.invoice_amount),
  };
}

// ---------------------------------------------------------------------------
// Receipts written by the booking payment flow
// ---------------------------------------------------------------------------

/** The billing party of a booking, created if needed (named after the booking if it has no guest yet). */
export async function bookingPartyId(tx: Tx, ctx: EngineContext, bookingId: string) {
  const booking = await tx
    .selectFrom('booking as b')
    .innerJoin('channel as ch', 'ch.id', 'b.channel_id')
    .innerJoin('channel_contract as cc', 'cc.id', 'b.contract_id')
    .select(['b.id', 'b.ref', 'b.channel_id', 'ch.type as channel_type', 'cc.payment_mode'])
    .where('b.id', '=', bookingId)
    .executeTakeFirstOrThrow();
  return (await ensureBookingParty(tx, ctx, booking, { fallbackToRef: true })).id;
}

/** The receipt behind a booking payment, refund or reversal recorded from the booking. */
export async function insertBookingReceipt(
  tx: Tx,
  ctx: EngineContext,
  values: {
    bookingId: string;
    kind: 'receipt' | 'refund' | 'reversal';
    amount: bigint;
    currency: string;
    paymentMethod: string;
    reference: string;
    receivedOn: string;
    note?: string | null;
    reversesReceiptId?: string | null;
    creditNoteId?: string | null;
    billingPartyId?: string;
  },
) {
  const partyId = values.billingPartyId ?? (await bookingPartyId(tx, ctx, values.bookingId));
  return tx
    .insertInto('receipt')
    .values({
      operator_id: ctx.operatorId,
      billing_party_id: partyId,
      booking_id: values.bookingId,
      kind: values.kind,
      received_on: values.receivedOn,
      amount: values.amount,
      currency: values.currency,
      method: receiptMethodFor(values.paymentMethod),
      reference: values.reference,
      note: values.note ? values.note.slice(0, 500) : null,
      reverses_receipt_id: values.reversesReceiptId ?? null,
      credit_note_id: values.creditNoteId ?? null,
      received_by: staffId(ctx),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Open invoices (issued, not fully paid or credited) that bill a booking, oldest first. */
async function openInvoicesOfBooking(tx: Tx, bookingId: string) {
  return tx
    .selectFrom('invoice as i')
    .select(['i.id'])
    .where('i.type', '=', 'invoice')
    .where('i.status', 'in', ['issued', 'partially_paid'])
    .where('i.id', 'in', (eb) =>
      eb.selectFrom('invoice_line').select('invoice_id').where('booking_id', '=', bookingId),
    )
    .orderBy('i.issued_at')
    .execute();
}

/**
 * Puts a booking's unused money on its open invoices (one invoice when `invoiceId` is given):
 * each up to the booking's share, from its own receipts, oldest first. Callers hold the booking
 * row lock. Returns what was allocated, in the booking currency.
 */
export async function allocateBookingMoney(
  tx: Tx,
  ctx: EngineContext,
  bookingId: string,
  reason: 'booking_payment' | 'invoice_issued',
  invoiceId?: string,
): Promise<bigint> {
  let held = await heldForBooking(tx, bookingId);
  if (held <= 0n) return 0n;
  const invoices = invoiceId ? [{ id: invoiceId }] : await openInvoicesOfBooking(tx, bookingId);
  let total = 0n;
  for (const { id } of invoices) {
    if (held <= 0n) break;
    const invoice = await tx
      .selectFrom('invoice')
      .select(['id', 'status', 'type', 'currency'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (invoice.type !== 'invoice' || !['issued', 'partially_paid'].includes(invoice.status))
      continue;
    const share = (await invoiceShares(tx, id)).find((s) => s.bookingId === bookingId);
    let open = share ? share.share - share.allocated : 0n;
    if (open > held) open = held;
    if (open <= 0n) continue;
    const receipts = await tx
      .selectFrom('receipt as r')
      .innerJoin('payment as p', 'p.receipt_id', 'r.id')
      .select(['r.id', 'r.currency', 'p.fx_rate', 'p.booking_amount'])
      .where('r.booking_id', '=', bookingId)
      .where('r.kind', '=', 'receipt')
      .where('p.booking_id', '=', bookingId)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('receipt as x')
              .select('x.id')
              .whereRef('x.reverses_receipt_id', '=', 'r.id'),
          ),
        ),
      )
      .orderBy('r.received_on')
      .orderBy('r.created_at')
      .execute();
    for (const receipt of receipts) {
      if (open <= 0n) break;
      const left = await receiptRemaining(tx, receipt.id);
      const leftInvoice = left.bookingAmount ?? 0n;
      if (leftInvoice <= 0n || left.amount <= 0n) continue;
      const piece = open < leftInvoice ? open : leftInvoice;
      let amount =
        piece === leftInvoice
          ? left.amount
          : receipt.fx_rate
            ? convertBack(money(piece, invoice.currency), receipt.fx_rate, receipt.currency).amount
            : piece;
      if (amount > left.amount) amount = left.amount;
      if (amount <= 0n) continue;
      await tx
        .insertInto('allocation')
        .values({
          operator_id: ctx.operatorId,
          receipt_id: receipt.id,
          invoice_id: id,
          booking_id: bookingId,
          amount,
          invoice_amount: piece,
          fx_rate: receipt.fx_rate,
          reason,
          created_by: staffId(ctx),
        })
        .execute();
      open -= piece;
      held -= piece;
      total += piece;
    }
    await refreshInvoicePaid(tx, id);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Allocating and taking back
// ---------------------------------------------------------------------------

type ReceiptRow = Awaited<ReturnType<typeof lockReceipt>>;

async function lockReceipt(tx: Tx, receiptId: string) {
  const receipt = await tx
    .selectFrom('receipt')
    .select([
      'id',
      'billing_party_id',
      'booking_id',
      'kind',
      'amount',
      'currency',
      'method',
      'reference',
      'received_on',
    ])
    .where('id', '=', receiptId)
    .forUpdate()
    .executeTakeFirst();
  if (!receipt) throw new DomainError('NOT_FOUND', { message: 'Receipt not found' });
  return receipt;
}

async function isReversed(tx: Tx, receiptId: string) {
  return Boolean(
    await tx
      .selectFrom('receipt')
      .select('id')
      .where('reverses_receipt_id', '=', receiptId)
      .executeTakeFirst(),
  );
}

/** Locks the bookings of an invoice (booking rows before invoice rows, like the payment flow). */
async function lockInvoiceBookings(tx: Tx, invoiceId: string) {
  const ids = await tx
    .selectFrom('invoice_line')
    .select('booking_id')
    .distinct()
    .where('invoice_id', '=', invoiceId)
    .where('booking_id', 'is not', null)
    .execute();
  if (ids.length)
    await tx
      .selectFrom('booking')
      .select('id')
      .where(
        'id',
        'in',
        ids.map((r) => r.booking_id!),
      )
      .orderBy('id')
      .forUpdate()
      .execute();
}

/**
 * Allocates `amount` (receipt currency) of a receipt to an invoice, spread over its bookings
 * oldest sailing first, then its manual lines. Callers hold the booking locks, then the receipt.
 */
async function allocateInTx(
  tx: Tx,
  ctx: EngineContext,
  receipt: ReceiptRow,
  invoiceId: string,
  amount: bigint,
  fxRate: string | undefined,
  /** Folio payments: the invoice amount already converted at the reception's rate. */
  invoiceAmount?: bigint,
) {
  const invoice = await tx
    .selectFrom('invoice')
    .select(['id', 'type', 'status', 'number', 'currency', 'billing_party_id'])
    .where('id', '=', invoiceId)
    .forUpdate()
    .executeTakeFirst();
  if (!invoice) throw new DomainError('NOT_FOUND', { message: 'Invoice not found' });
  if (invoice.type !== 'invoice' || !['issued', 'partially_paid'].includes(invoice.status))
    throw new DomainError('INVALID_STATE', {
      message: `${invoice.number ?? 'This invoice'} is not open for payment`,
    });
  if (invoice.billing_party_id !== receipt.billing_party_id)
    throw new DomainError('VALIDATION_FAILED', {
      message: `${invoice.number} is billed to another party`,
    });
  if (receipt.kind !== 'receipt' || receipt.amount <= 0n)
    throw new DomainError('INVALID_STATE', { message: 'Only money received can be allocated' });
  if (await isReversed(tx, receipt.id))
    throw new DomainError('INVALID_STATE', { message: 'The receipt is reversed' });

  const left = await receiptRemaining(tx, receipt.id);
  if (amount > left.amount)
    throw new DomainError('VALIDATION_FAILED', {
      message: 'More than is left of the receipt',
      details: { left: left.amount.toString(), currency: receipt.currency },
    });

  // A booking's own receipt converts at its payment's rate and pays only that booking.
  let rate: string | null = null;
  let invoiceTotal: bigint;
  if (receipt.booking_id) {
    const payment = await tx
      .selectFrom('payment')
      .select(['fx_rate', 'currency'])
      .where('receipt_id', '=', receipt.id)
      .where('booking_id', '=', receipt.booking_id)
      .executeTakeFirstOrThrow();
    rate = payment.fx_rate;
    invoiceTotal =
      amount === left.amount
        ? left.bookingAmount!
        : rate
          ? convert(money(amount, receipt.currency), rate, invoice.currency).amount
          : amount;
  } else if (receipt.currency === invoice.currency) {
    if (fxRate && fxRate !== '1')
      throw new DomainError('VALIDATION_FAILED', {
        message: 'No exchange rate for a receipt in the invoice currency',
      });
    invoiceTotal = amount;
  } else {
    if (!fxRate)
      throw new DomainError('VALIDATION_FAILED', {
        message: `An exchange rate ${receipt.currency} → ${invoice.currency} is required`,
        details: { field: 'fxRate' },
      });
    rate = fxRate;
    invoiceTotal =
      invoiceAmount ?? convert(money(amount, receipt.currency), fxRate, invoice.currency).amount;
  }
  if (invoiceTotal <= 0n)
    throw new DomainError('VALIDATION_FAILED', { message: 'The amount is too small' });

  const shares = (await invoiceShares(tx, invoice.id)).filter(
    (s) => !receipt.booking_id || s.bookingId === receipt.booking_id,
  );
  let remaining = invoiceTotal;
  const pieces: { bookingId: string | null; invoiceAmount: bigint }[] = [];
  for (const s of shares) {
    const open = s.share - s.allocated;
    if (open <= 0n || remaining <= 0n) continue;
    const take = open < remaining ? open : remaining;
    pieces.push({ bookingId: s.bookingId, invoiceAmount: take });
    remaining -= take;
  }
  if (remaining > 0n)
    throw new DomainError('VALIDATION_FAILED', {
      message: receipt.booking_id
        ? `More than booking's open share of ${invoice.number}`
        : `More than is open on ${invoice.number}`,
      details: {
        open: (invoiceTotal - remaining).toString(),
        currency: invoice.currency,
      },
    });

  // Receipt-currency amount of each piece; the last takes the rounding so they add up.
  let used = 0n;
  const rows = pieces.map((piece, index) => {
    const last = index === pieces.length - 1;
    const pieceAmount = last
      ? amount - used
      : rate
        ? convertBack(money(piece.invoiceAmount, invoice.currency), rate, receipt.currency).amount
        : piece.invoiceAmount;
    used += pieceAmount;
    return { ...piece, amount: pieceAmount };
  });
  if (rows.some((r) => r.amount <= 0n))
    throw new DomainError('VALIDATION_FAILED', {
      message: 'The amount is too small to spread over the invoice',
    });

  const written = [];
  for (const row of rows) {
    const allocation = await tx
      .insertInto('allocation')
      .values({
        operator_id: ctx.operatorId,
        receipt_id: receipt.id,
        invoice_id: invoice.id,
        booking_id: row.bookingId,
        amount: row.amount,
        invoice_amount: row.invoiceAmount,
        fx_rate: rate,
        reason: 'allocated',
        created_by: staffId(ctx),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (row.bookingId && !receipt.booking_id)
      await insertPayment(tx, ctx, {
        bookingId: row.bookingId,
        kind: 'payment',
        method: paymentMethodFor(receipt.method),
        amount: row.amount,
        currency: receipt.currency,
        fxRate: rate,
        bookingAmount: row.invoiceAmount,
        reference: receipt.reference,
        receivedOn: receipt.received_on,
        receiptId: receipt.id,
        allocationId: allocation.id,
      });
    written.push({ allocationId: allocation.id, ...row });
  }
  await refreshInvoicePaid(tx, invoice.id);
  await audit(tx, ctx.operatorId, ctx.actor, {
    action: 'receipt.allocated',
    entity: 'receipt',
    entityId: receipt.id,
    after: {
      invoice: invoice.number,
      amount,
      currency: receipt.currency,
      invoice_amount: invoiceTotal,
      fx_rate: rate,
      bookings: written.length,
    },
  });
  return { invoiceId: invoice.id, amount, invoiceAmount: invoiceTotal, pieces: written };
}

/**
 * Takes `invoiceAmount` (or all) of a receipt's allocation to one booking of an invoice back off
 * it. For a party receipt the booking payment it wrote is taken back too (`unallocated`).
 */
async function unallocatePiece(
  tx: Tx,
  ctx: EngineContext,
  receipt: ReceiptRow,
  invoiceId: string,
  bookingId: string | null,
  invoiceAmount: bigint | null,
  reason: 'unallocated' | 'credit_note' | 'reversed',
): Promise<bigint> {
  const { rows } = await sql<{ amount: string; invoice_amount: string; fx_rate: string | null }>`
    select coalesce(sum(amount), 0)::text as amount, coalesce(sum(invoice_amount), 0)::text as invoice_amount,
           max(fx_rate) as fx_rate
    from vs.allocation
    where receipt_id = ${receipt.id} and invoice_id = ${invoiceId} and booking_id is not distinct from ${bookingId}`.execute(
    tx,
  );
  const net = { amount: BigInt(rows[0]!.amount), invoice: BigInt(rows[0]!.invoice_amount) };
  if (net.invoice <= 0n) return 0n;
  const take = invoiceAmount === null || invoiceAmount >= net.invoice ? net.invoice : invoiceAmount;
  const rate = rows[0]!.fx_rate;
  const invoice = await tx
    .selectFrom('invoice')
    .select('currency')
    .where('id', '=', invoiceId)
    .executeTakeFirstOrThrow();
  let amount =
    take === net.invoice
      ? net.amount
      : rate
        ? convertBack(money(take, invoice.currency), rate, receipt.currency).amount
        : take;
  // Never more than is on it, and never nothing (a sub-unit rounding still moves one unit).
  if (amount > net.amount) amount = net.amount;
  if (amount <= 0n) amount = net.amount < 1n ? net.amount : 1n;
  const allocation = await tx
    .insertInto('allocation')
    .values({
      operator_id: ctx.operatorId,
      receipt_id: receipt.id,
      invoice_id: invoiceId,
      booking_id: bookingId,
      amount: -amount,
      invoice_amount: -take,
      fx_rate: rate,
      reason,
      created_by: staffId(ctx),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (bookingId && !receipt.booking_id)
    await insertPayment(tx, ctx, {
      bookingId,
      kind: 'unallocated',
      method: paymentMethodFor(receipt.method),
      amount: -amount,
      currency: receipt.currency,
      fxRate: rate,
      bookingAmount: -take,
      reference: receipt.reference,
      receivedOn: await cairoToday(tx),
      receiptId: receipt.id,
      allocationId: allocation.id,
    });
  return take;
}

/**
 * After a credit note: what an invoice still bills per booking may now be less than was paid
 * against it; the excess is taken back off, newest receipt first, and becomes credit again.
 */
export async function rebalanceInvoice(tx: Tx, ctx: EngineContext, invoiceId: string) {
  for (const s of await invoiceShares(tx, invoiceId)) {
    const floor = s.share > 0n ? s.share : 0n;
    let excess = s.allocated - floor;
    if (excess <= 0n) continue;
    const { rows } = await sql<{ receipt_id: string }>`
      select a.receipt_id from vs.allocation a join vs.receipt r on r.id = a.receipt_id
      where a.invoice_id = ${invoiceId} and a.booking_id is not distinct from ${s.bookingId}
      group by a.receipt_id, r.received_on, r.created_at
      having sum(a.invoice_amount) > 0
      order by r.received_on desc, r.created_at desc`.execute(tx);
    for (const row of rows) {
      if (excess <= 0n) break;
      const receipt = await lockReceipt(tx, row.receipt_id);
      excess -= await unallocatePiece(
        tx,
        ctx,
        receipt,
        invoiceId,
        s.bookingId,
        excess,
        'credit_note',
      );
    }
  }
  await refreshInvoicePaid(tx, invoiceId);
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Request keys are scoped to a channel: an agency's own channel, else the company's back-office
 * channel. A company with neither runs without replay protection.
 */
async function receiptKeyScope(tx: Tx, partyId: string, key: string | undefined) {
  const party = await tx
    .selectFrom('billing_party')
    .select('channel_id')
    .where('id', '=', partyId)
    .executeTakeFirst();
  const scope =
    party?.channel_id ??
    (
      await tx
        .selectFrom('channel')
        .select('id')
        .where('type', '=', 'back_office')
        .executeTakeFirst()
    )?.id;
  return scope ? { scopeId: scope, key } : { scopeId: partyId, key: undefined };
}

export const recordReceiptInput = z.object({
  billingPartyId: z.uuid(),
  amount: positiveMinor,
  currency: currencySchema,
  method: z.enum(RECEIPT_METHODS),
  reference: z.string().trim().min(1).max(200),
  receivedOn: dateSchema,
  note: z.string().trim().max(500).optional(),
  attachment: attachmentSchema.optional(),
  /** Applied in order; what is left stays as the party's credit. */
  allocations: z
    .array(
      z.object({ invoiceId: z.uuid(), amount: positiveMinor, fxRate: fxRateSchema.optional() }),
    )
    .max(100)
    .default([]),
  requestKey: z.string().min(1).max(255).optional(),
});

/** Money received from a party (an agency's remittance, a guest's transfer), optionally allocated. */
export async function recordReceipt(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof recordReceiptInput>,
) {
  const data = parseInput(recordReceiptInput, input);
  const file = data.attachment ? readAttachment(data.attachment) : null;
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    return withRequestKey(
      tx,
      ctx,
      {
        ...(await receiptKeyScope(tx, data.billingPartyId, data.requestKey)),
        action: 'receipt.record',
        input: { ...data, attachment: data.attachment?.name },
      },
      async () => {
        const party = await tx
          .selectFrom('billing_party')
          .select(['id', 'name'])
          .where('id', '=', data.billingPartyId)
          .executeTakeFirst();
        if (!party) throw new DomainError('NOT_FOUND', { message: 'Billing party not found' });
        const allocated = data.allocations.reduce((s, a) => s + a.amount, 0n);
        if (allocated > data.amount)
          throw new DomainError('VALIDATION_FAILED', {
            message: 'The allocations are more than the amount received',
          });
        // Booking rows first (the order the payment flow locks in), then the receipt.
        for (const a of data.allocations) await lockInvoiceBookings(tx, a.invoiceId);
        const created = await tx
          .insertInto('receipt')
          .values({
            operator_id: ctx.operatorId,
            billing_party_id: party.id,
            kind: 'receipt',
            received_on: data.receivedOn,
            amount: data.amount,
            currency: data.currency,
            method: data.method,
            reference: data.reference,
            note: data.note || null,
            received_by: staffId(ctx),
            ...(file ?? {}),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const receipt = await lockReceipt(tx, created.id);
        await audit(tx, ctx.operatorId, ctx.actor, {
          action: 'receipt.recorded',
          entity: 'receipt',
          entityId: receipt.id,
          after: {
            party: party.name,
            amount: data.amount,
            currency: data.currency,
            method: data.method,
            reference: data.reference,
            attachment: file?.attachment_type ?? null,
          },
        });
        for (const a of data.allocations)
          await allocateInTx(tx, ctx, receipt, a.invoiceId, a.amount, a.fxRate);
        return { receiptId: receipt.id, credit: data.amount - allocated };
      },
    );
  });
}

/**
 * Money received for one invoice in the caller's transaction, allocated to it at once (a folio
 * paid at reception). The invoice must have no bookings, so nothing on the booking ledger moves.
 */
export async function receiveForInvoice(
  tx: Tx,
  ctx: EngineContext,
  values: {
    invoiceId: string;
    billingPartyId: string;
    amount: bigint;
    currency: string;
    method: ReceiptMethod;
    reference: string;
    receivedOn: string;
    fxRate?: string;
    /** With fxRate: the invoice amount, converted by the caller (see allocateInTx). */
    invoiceAmount?: bigint;
    note?: string | null;
  },
) {
  const created = await tx
    .insertInto('receipt')
    .values({
      operator_id: ctx.operatorId,
      billing_party_id: values.billingPartyId,
      kind: 'receipt',
      received_on: values.receivedOn,
      amount: values.amount,
      currency: values.currency,
      method: values.method,
      reference: values.reference,
      note: values.note ?? null,
      received_by: staffId(ctx),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const receipt = await lockReceipt(tx, created.id);
  await audit(tx, ctx.operatorId, ctx.actor, {
    action: 'receipt.recorded',
    entity: 'receipt',
    entityId: receipt.id,
    after: {
      amount: values.amount,
      currency: values.currency,
      method: values.method,
      reference: values.reference,
    },
  });
  const allocated = await allocateInTx(
    tx,
    ctx,
    receipt,
    values.invoiceId,
    values.amount,
    values.fxRate,
    values.invoiceAmount,
  );
  return { receiptId: receipt.id, invoiceAmount: allocated.invoiceAmount };
}

export const allocateReceiptInput = z.object({
  receiptId: z.uuid(),
  invoiceId: z.uuid(),
  /** In the receipt currency. */
  amount: positiveMinor,
  /** 1 unit of the receipt currency = fxRate units of the invoice currency, when they differ. */
  fxRate: fxRateSchema.optional(),
});

export async function allocateReceipt(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof allocateReceiptInput>,
) {
  const data = parseInput(allocateReceiptInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await lockInvoiceBookings(tx, data.invoiceId);
    const receipt = await lockReceipt(tx, data.receiptId);
    return allocateInTx(tx, ctx, receipt, data.invoiceId, data.amount, data.fxRate);
  });
}

export const unallocateReceiptInput = z.object({ receiptId: z.uuid(), invoiceId: z.uuid() });

/** Takes a receipt's whole allocation to an invoice back off it; the money is credit again. */
export async function unallocateReceipt(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof unallocateReceiptInput>,
) {
  const data = parseInput(unallocateReceiptInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await lockInvoiceBookings(tx, data.invoiceId);
    const receipt = await lockReceipt(tx, data.receiptId);
    const invoice = await tx
      .selectFrom('invoice')
      .select(['id', 'number'])
      .where('id', '=', data.invoiceId)
      .forUpdate()
      .executeTakeFirst();
    if (!invoice) throw new DomainError('NOT_FOUND', { message: 'Invoice not found' });
    const taken = await unallocateAll(tx, ctx, receipt, invoice.id, 'unallocated');
    if (taken === 0n)
      throw new DomainError('INVALID_STATE', {
        message: `Nothing of this receipt is on ${invoice.number}`,
      });
    await refreshInvoicePaid(tx, invoice.id);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'receipt.unallocated',
      entity: 'receipt',
      entityId: receipt.id,
      after: { invoice: invoice.number, invoice_amount: taken },
    });
    return { invoiceId: invoice.id, invoiceAmount: taken };
  });
}

async function unallocateAll(
  tx: Tx,
  ctx: EngineContext,
  receipt: ReceiptRow,
  invoiceId: string,
  reason: 'unallocated' | 'reversed',
) {
  const { rows } = await sql<{ booking_id: string | null }>`
    select booking_id from vs.allocation where receipt_id = ${receipt.id} and invoice_id = ${invoiceId}
    group by booking_id having sum(invoice_amount) > 0`.execute(tx);
  let taken = 0n;
  for (const row of rows)
    taken += await unallocatePiece(tx, ctx, receipt, invoiceId, row.booking_id, null, reason);
  return taken;
}

/**
 * Reverses a receipt (it never happened): its allocations are taken back, then an opposite
 * receipt is written, with the reversal of its booking payment for a booking's own receipt.
 * Called from reversePayment for payments recorded from a booking.
 */
export async function reverseReceiptInTx(
  tx: Tx,
  ctx: EngineContext,
  receiptId: string,
  reason: string,
) {
  const receipt = await lockReceipt(tx, receiptId);
  if (receipt.kind === 'reversal')
    throw new DomainError('INVALID_STATE', { message: 'A reversal cannot be reversed' });
  if (await isReversed(tx, receipt.id))
    throw new DomainError('INVALID_STATE', { message: 'The receipt is already reversed' });
  const { rows: invoices } = await sql<{ invoice_id: string }>`
    select distinct invoice_id from vs.allocation where receipt_id = ${receipt.id}`.execute(tx);
  for (const { invoice_id } of invoices) {
    await tx.selectFrom('invoice').select('id').where('id', '=', invoice_id).forUpdate().execute();
    await unallocateAll(tx, ctx, receipt, invoice_id, 'reversed');
    await refreshInvoicePaid(tx, invoice_id);
  }
  const today = await cairoToday(tx);
  const reversal = await tx
    .insertInto('receipt')
    .values({
      operator_id: ctx.operatorId,
      billing_party_id: receipt.billing_party_id,
      booking_id: receipt.booking_id,
      kind: 'reversal',
      received_on: today,
      amount: -receipt.amount,
      currency: receipt.currency,
      method: receipt.method,
      reference: `reversal of ${receipt.reference}`.slice(0, 200),
      note: reason.slice(0, 500),
      reverses_receipt_id: receipt.id,
      received_by: staffId(ctx),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const payments = await tx
    .selectFrom('payment')
    .selectAll()
    .where('receipt_id', '=', receipt.id)
    .where('allocation_id', 'is', null)
    .where('kind', '<>', 'reversal')
    .execute();
  const reversals = [];
  for (const p of payments) {
    reversals.push(
      await insertPayment(tx, ctx, {
        bookingId: p.booking_id,
        kind: 'reversal',
        method: p.method,
        amount: -p.amount,
        currency: p.currency,
        fxRate: p.fx_rate,
        bookingAmount: -p.booking_amount,
        reference: `reversal of ${p.reference}`.slice(0, 200),
        receivedOn: today,
        receiptId: reversal.id,
        reversesPaymentId: p.id,
        note: reason,
      }),
    );
  }
  await audit(tx, ctx.operatorId, ctx.actor, {
    action: 'receipt.reversed',
    entity: 'receipt',
    entityId: receipt.id,
    after: { reversal_id: reversal.id, reason, invoices: invoices.length },
  });
  return { reversalId: reversal.id, payments: payments.map((p) => p.id), reversals };
}

export const reverseReceiptInput = z.object({
  receiptId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});

export async function reverseReceipt(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof reverseReceiptInput>,
) {
  const data = parseInput(reverseReceiptInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    // Lock order: the bookings it touches, then the receipt.
    const { rows } = await sql<{ booking_id: string }>`
      select distinct booking_id from vs.payment where receipt_id = ${data.receiptId}
      union select booking_id from vs.allocation where receipt_id = ${data.receiptId} and booking_id is not null`.execute(
      tx,
    );
    if (rows.length)
      await tx
        .selectFrom('booking')
        .select('id')
        .where(
          'id',
          'in',
          rows.map((r) => r.booking_id),
        )
        .orderBy('id')
        .forUpdate()
        .execute();
    const result = await reverseReceiptInTx(tx, ctx, data.receiptId, data.reason);
    return { reversalId: result.reversalId };
  });
}

/** What a party has received and not yet used, per currency (receipts − allocations). */
async function partyCredit(tx: Tx, partyId: string) {
  const { rows } = await sql<{
    currency: string;
    received: string;
    allocated: string;
    free: string;
  }>`
    select r.currency,
           sum(r.amount)::text as received,
           sum(coalesce(a.amount, 0))::text as allocated,
           (coalesce(sum(r.amount) filter (where r.booking_id is null), 0)
             - coalesce(sum(a.amount) filter (where r.booking_id is null), 0))::text as free
    from vs.receipt r
    left join lateral (select sum(x.amount) as amount from vs.allocation x where x.receipt_id = r.id) a on true
    where r.billing_party_id = ${partyId}
    group by r.currency order by r.currency`.execute(tx);
  return rows.map((r) => {
    const received = BigInt(r.received);
    const allocated = BigInt(r.allocated);
    return {
      currency: r.currency,
      received,
      allocated,
      /** Receipts − allocations. */
      credit: received - allocated,
      /** The part not held for a particular booking: what can pay any of its invoices or be refunded. */
      free: BigInt(r.free ?? '0'),
    };
  });
}

export const recordPartyRefundInput = z.object({
  billingPartyId: z.uuid(),
  amount: positiveMinor,
  currency: currencySchema,
  method: z.enum(RECEIPT_METHODS),
  reference: z.string().trim().min(1).max(200),
  refundedOn: dateSchema,
  creditNoteId: z.uuid().optional(),
  note: z.string().trim().max(500).optional(),
  requestKey: z.string().min(1).max(255).optional(),
});

/**
 * Pays a party's credit back (a negative receipt), at most its free credit in that currency. A
 * booking's own money is refunded from the booking (recordRefund), which keeps its refund cap.
 */
export async function recordPartyRefund(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof recordPartyRefundInput>,
) {
  const data = parseInput(recordPartyRefundInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    return withRequestKey(
      tx,
      ctx,
      {
        ...(await receiptKeyScope(tx, data.billingPartyId, data.requestKey)),
        action: 'receipt.refund',
        input: data,
      },
      async () => {
        const party = await tx
          .selectFrom('billing_party')
          .select(['id', 'name'])
          .where('id', '=', data.billingPartyId)
          .forUpdate()
          .executeTakeFirst();
        if (!party) throw new DomainError('NOT_FOUND', { message: 'Billing party not found' });
        if (data.creditNoteId) await assertCreditNote(tx, data.creditNoteId, party.id);
        const free =
          (await partyCredit(tx, party.id)).find((c) => c.currency === data.currency)?.free ?? 0n;
        if (data.amount > free)
          throw new DomainError('VALIDATION_FAILED', {
            message: 'The refund is more than the party’s credit',
            details: { credit: free.toString(), currency: data.currency },
          });
        const refund = await tx
          .insertInto('receipt')
          .values({
            operator_id: ctx.operatorId,
            billing_party_id: party.id,
            kind: 'refund',
            received_on: data.refundedOn,
            amount: -data.amount,
            currency: data.currency,
            method: data.method,
            reference: data.reference,
            note: data.note || null,
            credit_note_id: data.creditNoteId ?? null,
            received_by: staffId(ctx),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await audit(tx, ctx.operatorId, ctx.actor, {
          action: 'receipt.refunded',
          entity: 'receipt',
          entityId: refund.id,
          after: {
            party: party.name,
            amount: -data.amount,
            currency: data.currency,
            credit_note_id: data.creditNoteId ?? null,
          },
        });
        return { receiptId: refund.id, credit: free - data.amount };
      },
    );
  });
}

/** A refund may name the credit note it pays back: it must be one of the party's. */
export async function assertCreditNote(tx: Tx, creditNoteId: string, partyId: string) {
  const note = await tx
    .selectFrom('invoice')
    .select(['type', 'status', 'billing_party_id'])
    .where('id', '=', creditNoteId)
    .executeTakeFirst();
  if (!note || note.type !== 'credit_note' || note.status === 'draft')
    throw new DomainError('NOT_FOUND', { message: 'Credit note not found' });
  if (note.billing_party_id !== partyId)
    throw new DomainError('VALIDATION_FAILED', {
      message: 'The credit note is for another party',
    });
}

export const setReceiptAttachmentInput = z.object({
  receiptId: z.uuid(),
  attachment: attachmentSchema,
});

/** Adds or replaces the photo or PDF of a receipt (the only change a receipt allows). */
export async function setReceiptAttachment(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof setReceiptAttachmentInput>,
) {
  const data = parseInput(setReceiptAttachmentInput, input);
  const file = readAttachment(data.attachment);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('receipt')
      .select(['id', 'attachment_name', 'attachment_type'])
      .where('id', '=', data.receiptId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Receipt not found' });
    await tx.updateTable('receipt').set(file).where('id', '=', before.id).execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'receipt.attachment_set',
      entity: 'receipt',
      entityId: before.id,
      before: { attachment: before.attachment_name },
      after: {
        attachment: file.attachment_name,
        type: file.attachment_type,
        bytes: file.attachment.length,
      },
    });
    return { receiptId: before.id, type: file.attachment_type, bytes: file.attachment.length };
  });
}

/** The attachment's bytes, for the authenticated download route. */
export async function getReceiptAttachment(
  db: VsDatabase,
  ctx: EngineContext,
  input: { receiptId: string },
) {
  const { receiptId } = parseInput(z.object({ receiptId: z.uuid() }), input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const row = await tx
      .selectFrom('receipt')
      .select(['attachment', 'attachment_type', 'attachment_name'])
      .where('id', '=', receiptId)
      .executeTakeFirst();
    if (!row?.attachment) throw new DomainError('NOT_FOUND', { message: 'No attachment' });
    return {
      content: row.attachment,
      contentType: row.attachment_type!,
      filename: row.attachment_name ?? 'attachment',
    };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const listReceiptsInput = z.object({
  billingPartyId: z.uuid().optional(),
  bookingId: z.uuid().optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  /** Only receipts with money left to allocate. */
  unallocated: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

export async function listReceipts(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof listReceiptsInput> = {},
) {
  const data = parseInput(listReceiptsInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    let query = tx
      .selectFrom('receipt as r')
      .innerJoin('billing_party as p', 'p.id', 'r.billing_party_id')
      .leftJoin('booking as b', 'b.id', 'r.booking_id')
      .leftJoin('staff_user as s', 's.id', 'r.received_by')
      .select([
        'r.id',
        'r.kind',
        'r.received_on',
        'r.amount',
        'r.currency',
        'r.method',
        'r.reference',
        'r.note',
        'r.booking_id',
        'r.reverses_receipt_id',
        'r.credit_note_id',
        'r.attachment_type',
        'r.attachment_name',
        'r.created_at',
        'b.ref as booking_ref',
        'p.id as party_id',
        'p.name as party_name',
        'p.kind as party_kind',
        's.display_name as received_by',
        sql<bigint>`coalesce((select sum(a.amount) from vs.allocation a where a.receipt_id = r.id), 0)`.as(
          'allocated',
        ),
        sql<boolean>`exists (select from vs.receipt x where x.reverses_receipt_id = r.id)`.as(
          'reversed',
        ),
      ])
      .orderBy('r.received_on', 'desc')
      .orderBy('r.created_at', 'desc')
      .limit(data.limit);
    if (data.billingPartyId) query = query.where('r.billing_party_id', '=', data.billingPartyId);
    if (data.bookingId) query = query.where('r.booking_id', '=', data.bookingId);
    if (data.from) query = query.where('r.received_on', '>=', data.from);
    if (data.to) query = query.where('r.received_on', '<=', data.to);
    if (data.unallocated)
      query = query
        .where('r.kind', '=', 'receipt')
        .where(
          sql<boolean>`r.amount > coalesce((select sum(a.amount) from vs.allocation a where a.receipt_id = r.id), 0)`,
        )
        .where(
          sql<boolean>`not exists (select from vs.receipt x where x.reverses_receipt_id = r.id)`,
        );
    const rows = await query.execute();
    return rows.map((r) => ({
      ...r,
      allocated: BigInt(r.allocated),
      left: r.kind === 'receipt' && !r.reversed ? r.amount - BigInt(r.allocated) : 0n,
      hasAttachment: r.attachment_type !== null,
    }));
  });
}

export async function getReceipt(db: VsDatabase, ctx: EngineContext, input: { receiptId: string }) {
  const { receiptId } = parseInput(z.object({ receiptId: z.uuid() }), input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const receipt = await tx
      .selectFrom('receipt as r')
      .leftJoin('booking as b', 'b.id', 'r.booking_id')
      .leftJoin('staff_user as s', 's.id', 'r.received_by')
      .leftJoin('invoice as cn', 'cn.id', 'r.credit_note_id')
      .select([
        'r.id',
        'r.billing_party_id',
        'r.booking_id',
        'r.kind',
        'r.received_on',
        'r.amount',
        'r.currency',
        'r.method',
        'r.reference',
        'r.note',
        'r.credit_note_id',
        'r.reverses_receipt_id',
        'r.attachment_type',
        'r.attachment_name',
        'r.created_at',
        'b.ref as booking_ref',
        's.display_name as received_by',
        'cn.number as credit_note_number',
      ])
      .where('r.id', '=', receiptId)
      .executeTakeFirst();
    if (!receipt) throw new DomainError('NOT_FOUND', { message: 'Receipt not found' });
    const party = await tx
      .selectFrom('billing_party')
      .selectAll()
      .where('id', '=', receipt.billing_party_id)
      .executeTakeFirstOrThrow();
    const allocations = await tx
      .selectFrom('allocation as a')
      .innerJoin('invoice as i', 'i.id', 'a.invoice_id')
      .leftJoin('booking as b', 'b.id', 'a.booking_id')
      .select([
        'a.id',
        'a.invoice_id',
        'i.number as invoice_number',
        'i.currency as invoice_currency',
        'a.booking_id',
        'b.ref as booking_ref',
        'a.amount',
        'a.invoice_amount',
        'a.fx_rate',
        'a.reason',
        'a.created_at',
      ])
      .where('a.receipt_id', '=', receiptId)
      .orderBy('a.created_at')
      .execute();
    const reversedBy = await tx
      .selectFrom('receipt')
      .select(['id', 'received_on', 'note'])
      .where('reverses_receipt_id', '=', receiptId)
      .executeTakeFirst();
    const allocated = allocations.reduce((s, a) => s + a.amount, 0n);
    return {
      receipt: { ...receipt, hasAttachment: receipt.attachment_type !== null },
      party,
      allocations,
      reversedBy: reversedBy ?? null,
      allocated,
      left: receipt.kind === 'receipt' && !reversedBy ? receipt.amount - allocated : 0n,
    };
  });
}

export const partyAccountInput = z.object({ billingPartyId: z.uuid() });

/** A party's credit by currency and its open invoices, oldest due first (to allocate a receipt). */
export async function getPartyAccount(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof partyAccountInput>,
) {
  const { billingPartyId } = parseInput(partyAccountInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const party = await tx
      .selectFrom('billing_party')
      .selectAll()
      .where('id', '=', billingPartyId)
      .executeTakeFirst();
    if (!party) throw new DomainError('NOT_FOUND', { message: 'Billing party not found' });
    const openInvoices = await tx
      .selectFrom('invoice')
      .select([
        'id',
        'number',
        'currency',
        'total',
        'amount_credited',
        'amount_paid',
        'issue_date',
        'due_date',
        'status',
        sql<bigint>`total - amount_credited - amount_paid`.as('open'),
      ])
      .where('billing_party_id', '=', billingPartyId)
      .where('type', '=', 'invoice')
      .where('status', 'in', ['issued', 'partially_paid'])
      .orderBy('due_date')
      .orderBy('number')
      .execute();
    const creditNotes = await tx
      .selectFrom('invoice')
      .select(['id', 'number', 'currency', 'total', 'issue_date'])
      .where('billing_party_id', '=', billingPartyId)
      .where('type', '=', 'credit_note')
      .where('status', '<>', 'draft')
      .orderBy('issue_date', 'desc')
      .limit(50)
      .execute();
    return {
      party,
      credit: await partyCredit(tx, billingPartyId),
      openInvoices: openInvoices.map((i) => ({ ...i, open: BigInt(i.open) })),
      creditNotes,
    };
  });
}

/** The receipts paying an invoice, net per receipt (for the invoice page). */
export async function invoiceAllocations(tx: Tx, invoiceId: string) {
  const { rows } = await sql<{
    receipt_id: string;
    received_on: string;
    reference: string;
    method: string;
    currency: string;
    amount: string;
    invoice_amount: string;
    booking_receipt: boolean;
  }>`
    select r.id as receipt_id, r.received_on::text as received_on, r.reference, r.method, r.currency,
           sum(a.amount)::text as amount, sum(a.invoice_amount)::text as invoice_amount,
           (r.booking_id is not null) as booking_receipt
    from vs.allocation a join vs.receipt r on r.id = a.receipt_id
    where a.invoice_id = ${invoiceId}
    group by r.id
    having sum(a.invoice_amount) <> 0
    order by r.received_on, r.created_at`.execute(tx);
  return rows.map((r) => ({
    receiptId: r.receipt_id,
    receivedOn: r.received_on,
    reference: r.reference,
    method: r.method,
    currency: r.currency,
    amount: BigInt(r.amount),
    invoiceAmount: BigInt(r.invoice_amount),
    bookingReceipt: r.booking_receipt,
  }));
}
