import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import {
  applyAmendment,
  calculateRefund,
  cancelBooking,
  createChannel,
  createContract,
  createInvoiceDraft,
  deleteInvoiceDraft,
  getCreditExposure,
  getInvoice,
  issueInvoice,
  quoteAmendment,
  recordPayment,
  recordReceipt,
  recordRefund,
  reversePayment,
  staffBook,
  todayInCairo,
} from '../src/index';
import { bookingWorld, lead, type BookingWorld } from './helpers/booking-world';

const codeOf = async (promise: Promise<unknown>): Promise<ErrorCode | 'ok'> =>
  promise.then(
    () => 'ok' as const,
    (e: unknown) => (isDomainError(e) ? e.code : Promise.reject(e)),
  );
const booking = async (id: string) =>
  (
    await owner().query<{
      status: string;
      payment_status: string;
      total: string;
      net_total: string;
      amount_paid: string;
    }>(
      `select status, payment_status, total::text, net_total::text, amount_paid::text from vs.booking where id = $1`,
      [id],
    )
  ).rows[0]!;

/** Gaps found by the review of 14 November 2026 (docs/decisions.md, "Review fixes, batch 2"). */
describe('money fixes', () => {
  let w: BookingWorld;
  let today: string;
  let sailingId: string;
  let agent: string;
  let n = 0;
  const usd = { fxRate: '50', fxSource: 'CBE' };
  const book = (channelId: string) =>
    staffBook(w.db, w.ctx, {
      channelId,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: `money-book-${++n}`,
    });

  beforeAll(async () => {
    w = await bookingWorld();
    today = await todayInCairo(w.db);
    sailingId = await w.sailing('LXR-4', 21);
    agent = (
      await createChannel(w.db, w.ctx, {
        code: 'commission-agent',
        name: 'Commission Agent',
        type: 'agent',
        creditAllowed: true,
        creditLimit: 100_000_000,
        creditCurrency: 'USD',
      })
    ).id;
    await createContract(w.db, w.ctx, {
      channelId: agent,
      vesselId: w.demo.vesselId,
      allocation: 'pool',
      paymentMode: 'credit',
      priceAdjustment: 'commission',
      adjustmentBps: 1000,
      validFrom: w.M,
      categoryIds: Object.values(w.demo.categories),
      ratePlanIds: w.ratePlanIds,
    });
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('an agency on commission owes the net: exposure counts it, and paying its invoice makes the booking paid', async () => {
    const a = await book(agent);
    const before = await booking(a.bookingId);
    const net = BigInt(before.net_total);
    expect(net).toBeLessThan(BigInt(before.total));
    expect((await getCreditExposure(w.db, w.ctx, { channelId: agent })).uninvoiced).toBe(net);

    const draft = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [a.bookingId],
    });
    const issued = await issueInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId, ...usd });
    expect(issued.total).toBe(net);
    const { party } = await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId });
    await recordReceipt(w.db, w.ctx, {
      billingPartyId: party.id,
      amount: net,
      currency: 'USD',
      method: 'bank_transfer',
      reference: 'NET-1',
      receivedOn: today,
      allocations: [{ invoiceId: issued.invoiceId, amount: net }],
    });
    expect(await booking(a.bookingId)).toMatchObject({
      amount_paid: String(net),
      payment_status: 'paid',
    });
  });

  it('a guest paying the vessel still owes the full price', async () => {
    const b = await book(w.channels.backOffice);
    const total = BigInt((await booking(b.bookingId)).total);
    const pay = (amount: bigint) =>
      recordPayment(w.db, w.ctx, {
        bookingId: b.bookingId,
        method: 'cash',
        amount,
        currency: 'USD',
        reference: `GUEST-${++n}`,
        receivedOn: today,
      });
    await pay(total - 100n);
    expect((await booking(b.bookingId)).payment_status).not.toBe('paid');
    await pay(100n);
    expect((await booking(b.bookingId)).payment_status).toBe('paid');
  });

  it('a draft invoice is refused at issue once its booking was amended; made again, it bills the new price', async () => {
    const a = await book(w.agents.credit);
    const stale = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [a.bookingId],
    });
    const quoted = await quoteAmendment(w.db, w.ctx, {
      bookingId: a.bookingId,
      cabins: [{ categoryId: w.demo.categories.SUP, adults: 2, childAges: [] }],
    });
    await applyAmendment(w.db, w.ctx, {
      bookingId: a.bookingId,
      revision: 1,
      amendmentQuoteId: quoted.quote.id,
    });
    const refused = await issueInvoice(w.db, w.ctx, { invoiceId: stale.invoiceId, ...usd }).catch(
      (e: unknown) => e,
    );
    expect(isDomainError(refused, 'INVALID_STATE') && refused.details).toMatchObject({
      reason: 'draft_stale',
    });
    await deleteInvoiceDraft(w.db, w.ctx, { invoiceId: stale.invoiceId });
    const fresh = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [a.bookingId],
    });
    expect(fresh.total).not.toBe(stale.total);
    const issued = await issueInvoice(w.db, w.ctx, { invoiceId: fresh.invoiceId, ...usd });
    expect(issued.total).toBe(fresh.total);
  });

  it('a draft invoice is refused at issue once its booking was cancelled', async () => {
    const a = await book(w.agents.credit);
    const stale = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [a.bookingId],
    });
    await cancelBooking(w.db, w.ctx, { bookingId: a.bookingId, reason: 'Guest cancelled' });
    expect(await codeOf(issueInvoice(w.db, w.ctx, { invoiceId: stale.invoiceId, ...usd }))).toBe(
      'INVALID_STATE',
    );
  });

  it('a payment that was refunded cannot also be reversed', async () => {
    const b = await book(w.channels.backOffice);
    const total = BigInt((await booking(b.bookingId)).total);
    const paid = await recordPayment(w.db, w.ctx, {
      bookingId: b.bookingId,
      method: 'bank_transfer',
      amount: total,
      currency: 'USD',
      reference: 'FULL-1',
      receivedOn: today,
    });
    expect((await booking(b.bookingId)).status).toBe('confirmed');
    await cancelBooking(w.db, w.ctx, { bookingId: b.bookingId, reason: 'Guest cancelled' });
    const due = await calculateRefund(w.db, w.ctx, { bookingId: b.bookingId });
    expect(due.refundable).toBeGreaterThan(0n);
    await recordRefund(w.db, w.ctx, {
      bookingId: b.bookingId,
      method: 'bank_transfer',
      amount: due.refundable,
      currency: 'USD',
      reference: 'REFUND-1',
      refundedOn: today,
    });
    const refused = await reversePayment(w.db, w.ctx, {
      paymentId: paid.paymentId,
      reason: 'Entered twice',
    }).catch((e: unknown) => e);
    expect(isDomainError(refused, 'INVALID_STATE') && refused.details).toMatchObject({
      reason: 'refunded',
    });
    expect(BigInt((await booking(b.bookingId)).amount_paid)).toBeGreaterThanOrEqual(0n);
  });
});
