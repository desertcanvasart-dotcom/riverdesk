import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import {
  allocateReceipt,
  cancelBooking,
  createInvoiceDraft,
  getInvoice,
  getPartyAccount,
  getReceipt,
  getReceiptAttachment,
  issueCreditNote,
  issueInvoice,
  listReceipts,
  recordPartyRefund,
  recordPayment,
  recordReceipt,
  recordRefund,
  reversePayment,
  reverseReceipt,
  setReceiptAttachment,
  staffBook,
  todayInCairo,
  unallocateReceipt,
} from '../src/index';
import { bookingWorld, lead, type BookingWorld } from './helpers/booking-world';

const codeOf = async (promise: Promise<unknown>): Promise<ErrorCode | 'ok'> =>
  promise.then(
    () => 'ok' as const,
    (e: unknown) => (isDomainError(e) ? e.code : Promise.reject(e)),
  );

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('invoicing F3: receipts and allocations', () => {
  let w: BookingWorld;
  let today: string;
  let sailings: string[];
  let n = 0;
  const book = (channelId: string, sailing = 0) =>
    staffBook(w.db, w.ctx, {
      channelId,
      sailingId: sailings[sailing]!,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: `receipt-book-${++n}`,
    });
  const usd = { fxRate: '48.5', fxSource: 'CBE' };
  const invoiceFor = async (bookingIds: string[]) => {
    const draft = await createInvoiceDraft(w.db, w.ctx, { type: 'invoice', bookingIds });
    return issueInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId, ...usd });
  };
  const booking = async (id: string) =>
    (
      await owner().query<{ amount_paid: string; payment_status: string }>(
        `select amount_paid::text, payment_status from vs.booking where id = $1`,
        [id],
      )
    ).rows[0]!;
  const pay = (bookingId: string, amount: bigint, extra: Record<string, unknown> = {}) =>
    recordPayment(w.db, w.ctx, {
      bookingId,
      method: 'bank_transfer',
      amount,
      currency: 'USD',
      reference: `TRF-${++n}`,
      receivedOn: today,
      requestKey: `receipt-pay-${n}`,
      ...extra,
    });

  beforeAll(async () => {
    w = await bookingWorld();
    today = (await todayInCairo(w.db)) as string;
    sailings = [await w.sailing('LXR-4', 21), await w.sailing('LXR-4', 14)];
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('records a receipt with every booking payment; issuing an invoice applies the deposit', async () => {
    const a = await book(w.channels.backOffice);
    const { rows } = await owner().query<{ deposit: string }>(
      `select deposit_amount::text as deposit from vs.booking where id = $1`,
      [a.bookingId],
    );
    const first = BigInt(rows[0]!.deposit) || 10_000n;
    const deposit = await pay(a.bookingId, first, { method: 'card_office' });
    const receipt = await getReceipt(w.db, w.ctx, { receiptId: deposit.receiptId });
    expect(receipt.receipt).toMatchObject({
      kind: 'receipt',
      booking_id: a.bookingId,
      amount: first,
      method: 'card',
    });
    expect(receipt.party).toMatchObject({ kind: 'guest', name: 'Mona Hassan' });
    expect(deposit.allocated).toBe(0n);

    const issued = await invoiceFor([a.bookingId]);
    expect(issued.amountPaid).toBe(first);
    let invoice = await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId });
    expect(invoice.invoice).toMatchObject({ status: 'partially_paid', amount_paid: first });
    expect(invoice.party.id).toBe(receipt.party.id);
    expect(invoice.payments).toEqual([
      expect.objectContaining({ receiptId: deposit.receiptId, invoiceAmount: first }),
    ]);

    // The balance and a little more: the invoice is paid, the excess stays with the booking.
    const balance = await pay(a.bookingId, a.total - first + 500n);
    expect(balance.allocated).toBe(a.total - first);
    invoice = await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId });
    expect(invoice.invoice).toMatchObject({ status: 'paid', amount_paid: a.total });
    const account = await getPartyAccount(w.db, w.ctx, { billingPartyId: receipt.party.id });
    expect(account.credit).toEqual([
      expect.objectContaining({ currency: 'USD', credit: 500n, free: 0n }),
    ]);
    expect(account.openInvoices).toEqual([]);
  });

  it('spreads an agency remittance over an invoice, oldest sailing first, and keeps the rest as credit', async () => {
    const later = await book(w.agents.credit, 0);
    const sooner = await book(w.agents.credit, 1);
    const other = await book(w.agents.credit, 0);
    const first = await invoiceFor([later.bookingId, sooner.bookingId]);
    const second = await invoiceFor([other.bookingId]);
    const party = (await getInvoice(w.db, w.ctx, { invoiceId: first.invoiceId })).party;

    const part = sooner.total + 1_000n;
    const recorded = await recordReceipt(w.db, w.ctx, {
      billingPartyId: party.id,
      amount: part + 20_000n,
      currency: 'USD',
      method: 'agency_remittance',
      reference: 'SWIFT-1',
      receivedOn: today,
      allocations: [{ invoiceId: first.invoiceId, amount: part }],
      requestKey: 'remit-1',
    });
    expect(recorded.credit).toBe(20_000n);
    // The sooner sailing is paid in full, the later one gets the rest.
    expect(await booking(sooner.bookingId)).toEqual({
      amount_paid: sooner.total.toString(),
      payment_status: 'paid',
    });
    expect((await booking(later.bookingId)).amount_paid).toBe('1000');
    const read = await getReceipt(w.db, w.ctx, { receiptId: recorded.receiptId });
    expect(read.allocations.map((x) => [x.booking_id, x.invoice_amount])).toEqual([
      [sooner.bookingId, sooner.total],
      [later.bookingId, 1_000n],
    ]);
    expect(read.left).toBe(20_000n);
    expect((await getInvoice(w.db, w.ctx, { invoiceId: first.invoiceId })).invoice.status).toBe(
      'partially_paid',
    );

    // The rest of the credit goes on the second invoice; never more than is left or is open.
    expect(
      await codeOf(
        allocateReceipt(w.db, w.ctx, {
          receiptId: recorded.receiptId,
          invoiceId: second.invoiceId,
          amount: 20_001n,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    await allocateReceipt(w.db, w.ctx, {
      receiptId: recorded.receiptId,
      invoiceId: second.invoiceId,
      amount: 20_000n,
    });
    expect((await booking(other.bookingId)).amount_paid).toBe('20000');
    let account = await getPartyAccount(w.db, w.ctx, { billingPartyId: party.id });
    expect(account.credit.find((c) => c.currency === 'USD')).toMatchObject({
      credit: 0n,
      free: 0n,
    });
    expect(account.openInvoices.map((i) => i.id).sort()).toEqual(
      [first.invoiceId, second.invoiceId].sort(),
    );

    // Taking it back off writes the opposite booking entries; the money is credit again.
    await unallocateReceipt(w.db, w.ctx, {
      receiptId: recorded.receiptId,
      invoiceId: second.invoiceId,
    });
    expect((await booking(other.bookingId)).amount_paid).toBe('0');
    const { rows } = await owner().query<{ kind: string; booking_amount: string }>(
      `select kind, booking_amount::text from vs.payment where booking_id = $1 order by created_at`,
      [other.bookingId],
    );
    expect(rows).toEqual([
      { kind: 'payment', booking_amount: '20000' },
      { kind: 'unallocated', booking_amount: '-20000' },
    ]);
    account = await getPartyAccount(w.db, w.ctx, { billingPartyId: party.id });
    expect(account.credit.find((c) => c.currency === 'USD')).toMatchObject({
      credit: 20_000n,
      free: 20_000n,
    });
    expect(
      await listReceipts(w.db, w.ctx, { billingPartyId: party.id, unallocated: true }),
    ).toEqual([expect.objectContaining({ id: recorded.receiptId, left: 20_000n })]);

    // Its booking payments are undone on the receipt, not from the booking.
    const written = await owner().query<{ id: string }>(
      `select id from vs.payment where booking_id = $1 and kind = 'payment'`,
      [sooner.bookingId],
    );
    expect(
      await codeOf(reversePayment(w.db, w.ctx, { paymentId: written.rows[0]!.id, reason: 'x' })),
    ).toBe('INVALID_STATE');
  });

  it('converts a receipt in another currency at the typed rate, piece by piece', async () => {
    const a = await book(w.agents.credit, 0);
    const b = await book(w.agents.credit, 1);
    const issued = await invoiceFor([a.bookingId, b.bookingId]);
    const party = (await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId })).party;
    const recorded = await recordReceipt(w.db, w.ctx, {
      billingPartyId: party.id,
      amount: 100_001n,
      currency: 'EUR',
      method: 'bank_transfer',
      reference: 'EUR-1',
      receivedOn: today,
    });
    // An EUR receipt on a USD invoice needs a rate.
    expect(
      await codeOf(
        allocateReceipt(w.db, w.ctx, {
          receiptId: recorded.receiptId,
          invoiceId: issued.invoiceId,
          amount: 100_001n,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const result = await allocateReceipt(w.db, w.ctx, {
      receiptId: recorded.receiptId,
      invoiceId: issued.invoiceId,
      amount: 100_001n,
      fxRate: '1.0851',
    });
    expect(result.invoiceAmount).toBe(108_511n); // 1000.01 EUR × 1.0851 = 1085.11 USD
    const pieces = (await getReceipt(w.db, w.ctx, { receiptId: recorded.receiptId })).allocations;
    expect(pieces.reduce((s, p) => s + p.amount, 0n)).toBe(100_001n);
    expect(pieces.reduce((s, p) => s + p.invoice_amount, 0n)).toBe(108_511n);
    const { rows } = await owner().query<{ currency: string; fx_rate: string; amount: string }>(
      `select currency, fx_rate, amount::text from vs.payment where receipt_id = $1 order by created_at`,
      [recorded.receiptId],
    );
    expect(rows.every((r) => r.currency === 'EUR' && r.fx_rate === '1.0851')).toBe(true);
  });

  it('takes the excess back off an invoice when a credit note leaves it overpaid', async () => {
    const a = await book(w.agents.credit, 0);
    const issued = await invoiceFor([a.bookingId]);
    const { party, lines } = await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId });
    const recorded = await recordReceipt(w.db, w.ctx, {
      billingPartyId: party.id,
      amount: issued.total,
      currency: 'USD',
      method: 'agency_remittance',
      reference: 'SWIFT-2',
      receivedOn: today,
      allocations: [{ invoiceId: issued.invoiceId, amount: issued.total }],
    });
    expect((await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId })).invoice.status).toBe(
      'paid',
    );
    const before = (await getPartyAccount(w.db, w.ctx, { billingPartyId: party.id })).credit.find(
      (c) => c.currency === 'USD',
    )!;

    const partial = await issueCreditNote(w.db, w.ctx, {
      invoiceId: issued.invoiceId,
      reason: 'Discount agreed',
      lines: [{ lineId: lines[0]!.id, amount: 3_000n }],
    });
    expect(partial).toMatchObject({
      invoiceStatus: 'paid',
      invoiceAmountPaid: issued.total - 3_000n,
    });
    expect((await booking(a.bookingId)).amount_paid).toBe((issued.total - 3_000n).toString());
    let credit = (await getPartyAccount(w.db, w.ctx, { billingPartyId: party.id })).credit.find(
      (c) => c.currency === 'USD',
    )!;
    expect(credit.free - before.free).toBe(3_000n);

    const rest = await issueCreditNote(w.db, w.ctx, {
      invoiceId: issued.invoiceId,
      reason: 'Cancelled',
      lines: [{ lineId: lines[0]!.id, amount: issued.total - 3_000n }],
    });
    expect(rest).toMatchObject({ invoiceStatus: 'cancelled', invoiceAmountPaid: 0n });
    credit = (await getPartyAccount(w.db, w.ctx, { billingPartyId: party.id })).credit.find(
      (c) => c.currency === 'USD',
    )!;
    expect(credit.free - before.free).toBe(issued.total);
    expect((await getReceipt(w.db, w.ctx, { receiptId: recorded.receiptId })).left).toBe(
      issued.total,
    );

    // Paying the credit back: at most the free credit, linked to the credit note.
    expect(
      await codeOf(
        recordPartyRefund(w.db, w.ctx, {
          billingPartyId: party.id,
          amount: credit.free + 1n,
          currency: 'USD',
          method: 'bank_transfer',
          reference: 'REF-1',
          refundedOn: today,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const refund = await recordPartyRefund(w.db, w.ctx, {
      billingPartyId: party.id,
      amount: issued.total,
      currency: 'USD',
      method: 'bank_transfer',
      reference: 'REF-1',
      refundedOn: today,
      creditNoteId: rest.creditNoteId,
    });
    expect(refund.credit).toBe(credit.free - issued.total);
  });

  it('keeps a cancelled direct booking’s money for its penalty invoice and refunds the rest', async () => {
    const a = await book(w.channels.backOffice);
    await pay(a.bookingId, a.total);
    const issued = await invoiceFor([a.bookingId]);
    expect((await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId })).invoice.status).toBe(
      'paid',
    );
    await cancelBooking(w.db, w.ctx, { bookingId: a.bookingId, reason: 'Guest cancelled' });
    const { rows } = await owner().query<{ penalty: string }>(
      `select (coalesce(penalty_amount, 0) + fees)::text as penalty from vs.booking where id = $1`,
      [a.bookingId],
    );
    const kept = BigInt(rows[0]!.penalty);
    expect(kept > 0n && kept < a.total).toBe(true);

    // The money still pays the invoice: credit it before refunding.
    const refundOf = (amount: bigint, creditNoteId?: string) =>
      recordRefund(w.db, w.ctx, {
        bookingId: a.bookingId,
        method: 'bank_transfer',
        amount,
        currency: 'USD',
        reference: `RFD-${++n}`,
        refundedOn: today,
        creditNoteId,
        requestKey: `receipt-refund-${n}`,
      });
    expect(await codeOf(refundOf(a.total - kept))).toBe('VALIDATION_FAILED');
    const note = await issueCreditNote(w.db, w.ctx, {
      invoiceId: issued.invoiceId,
      reason: 'Booking cancelled',
    });
    expect(note).toMatchObject({ invoiceStatus: 'cancelled', invoiceAmountPaid: 0n });
    // The penalty invoice takes its part of the booking's money when issued.
    const penalty = await invoiceFor([a.bookingId]);
    expect(penalty.total).toBe(kept);
    expect(penalty.amountPaid).toBe(kept);
    const refunded = await refundOf(a.total - kept, note.creditNoteId);
    const refundReceipt = await getReceipt(w.db, w.ctx, { receiptId: refunded.receiptId });
    expect(refundReceipt.receipt).toMatchObject({
      kind: 'refund',
      amount: -(a.total - kept),
      credit_note_id: note.creditNoteId,
    });
    const account = await getPartyAccount(w.db, w.ctx, {
      billingPartyId: refundReceipt.party.id,
    });
    expect(account.credit.find((c) => c.currency === 'USD')).toMatchObject({ credit: 0n });
    expect(await booking(a.bookingId)).toMatchObject({ payment_status: 'refunded' });
  });

  it('reverses a receipt: off its invoices first, then the opposite entries', async () => {
    // A booking payment reversed from the booking takes it off the invoice.
    const a = await book(w.channels.backOffice);
    const paid = await pay(a.bookingId, a.total);
    const issued = await invoiceFor([a.bookingId]);
    await reversePayment(w.db, w.ctx, { paymentId: paid.paymentId, reason: 'Bounced' });
    expect((await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId })).invoice).toMatchObject({
      status: 'issued',
      amount_paid: 0n,
    });
    expect(await booking(a.bookingId)).toMatchObject({ amount_paid: '0' });
    const read = await getReceipt(w.db, w.ctx, { receiptId: paid.receiptId });
    expect(read.reversedBy).not.toBeNull();
    expect(
      await codeOf(reverseReceipt(w.db, w.ctx, { receiptId: paid.receiptId, reason: 'again' })),
    ).toBe('INVALID_STATE');

    // A party receipt reversed: its booking payments are taken back, its credit is gone.
    const b = await book(w.agents.credit);
    const second = await invoiceFor([b.bookingId]);
    const party = (await getInvoice(w.db, w.ctx, { invoiceId: second.invoiceId })).party;
    const remit = await recordReceipt(w.db, w.ctx, {
      billingPartyId: party.id,
      amount: second.total + 700n,
      currency: 'USD',
      method: 'agency_remittance',
      reference: 'SWIFT-3',
      receivedOn: today,
      allocations: [{ invoiceId: second.invoiceId, amount: second.total }],
    });
    const before = (await getPartyAccount(w.db, w.ctx, { billingPartyId: party.id })).credit.find(
      (c) => c.currency === 'USD',
    )!;
    await reverseReceipt(w.db, w.ctx, { receiptId: remit.receiptId, reason: 'Wrong agency' });
    expect(await booking(b.bookingId)).toMatchObject({
      amount_paid: '0',
      payment_status: 'unpaid',
    });
    expect((await getInvoice(w.db, w.ctx, { invoiceId: second.invoiceId })).invoice.status).toBe(
      'issued',
    );
    const after = (await getPartyAccount(w.db, w.ctx, { billingPartyId: party.id })).credit.find(
      (c) => c.currency === 'USD',
    )!;
    expect(before.free - after.free).toBe(700n);
    expect(
      await codeOf(
        allocateReceipt(w.db, w.ctx, {
          receiptId: remit.receiptId,
          invoiceId: second.invoiceId,
          amount: 1n,
        }),
      ),
    ).toBe('INVALID_STATE');
  });

  it('stores a photo or PDF of the receipt; the receipt itself never changes', async () => {
    const a = await book(w.channels.backOffice);
    const paid = await pay(a.bookingId, 5_000n);
    expect(
      await codeOf(
        setReceiptAttachment(w.db, w.ctx, {
          receiptId: paid.receiptId,
          attachment: { base64: Buffer.from('not an image').toString('base64'), name: 'x.txt' },
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    await setReceiptAttachment(w.db, w.ctx, {
      receiptId: paid.receiptId,
      attachment: { base64: PNG.toString('base64'), name: 'transfer.png' },
    });
    const file = await getReceiptAttachment(w.db, w.ctx, { receiptId: paid.receiptId });
    expect(file).toMatchObject({ contentType: 'image/png', filename: 'transfer.png' });
    expect(Buffer.compare(file.content, PNG)).toBe(0);

    const changed = await owner()
      .query(`update vs.receipt set amount = amount + 1 where id = $1`, [paid.receiptId])
      .then(
        () => 'ok',
        (e: { code?: string }) => e.code,
      );
    expect(changed).toBe('42501');
  });
});
