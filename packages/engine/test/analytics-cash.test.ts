import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { addDays, type BusinessDate } from '@vs/shared';
import {
  cashReport,
  createInvoiceDraft,
  getInvoice,
  issueInvoice,
  recordPayment,
  recordReceipt,
  recordRefund,
  cancelBooking,
  staffBook,
  todayInCairo,
} from '../src/index';
import { bookingWorld, lead, type BookingWorld } from './helpers/booking-world';

describe('analytics A2.1: cash', () => {
  let w: BookingWorld;
  let today: BusinessDate;
  let sailingId: string;
  let n = 0;
  const book = (channelId: string) =>
    staffBook(w.db, w.ctx, {
      channelId,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: `cash-book-${++n}`,
    });
  const booking = async (id: string) =>
    (
      await owner().query<{ deposit: string; balance_due: string | null; total: string }>(
        `select deposit_amount::text as deposit, balance_due_date::text as balance_due, (total + fees)::text as total
         from vs.booking where id = $1`,
        [id],
      )
    ).rows[0]!;

  beforeAll(async () => {
    w = await bookingWorld();
    today = (await todayInCairo(w.db)) as BusinessDate;
    sailingId = await w.sailing('LXR-4', 63);
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('adds up cash in, what is still due by when, and money held for coming sailings', async () => {
    // A direct guest pays the deposit; the rest falls due on the balance date.
    const direct = await book(w.channels.backOffice);
    const d = await booking(direct.bookingId);
    await recordPayment(w.db, w.ctx, {
      bookingId: direct.bookingId,
      method: 'cash',
      amount: BigInt(d.deposit),
      currency: 'USD',
      reference: 'CASH-1',
      receivedOn: today,
      requestKey: 'cash-pay-1',
    });
    // An agency: one booking invoiced, due in 10 days; one not invoiced yet.
    const invoiced = await book(w.agents.credit);
    const notInvoiced = await book(w.agents.credit);
    const draft = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [invoiced.bookingId],
      dueDate: addDays(today, 10),
    });
    const issued = await issueInvoice(w.db, w.ctx, {
      invoiceId: draft.invoiceId,
      fxRate: '50',
      fxSource: 'CBE',
    });
    const { party } = await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId });
    await recordReceipt(w.db, w.ctx, {
      billingPartyId: party.id,
      amount: 30_000n,
      currency: 'USD',
      method: 'agency_remittance',
      reference: 'SWIFT-CASH',
      receivedOn: today,
      allocations: [{ invoiceId: issued.invoiceId, amount: 20_000n }],
    });
    // A cancelled direct booking refunded: money out.
    const gone = await book(w.channels.backOffice);
    const g = await booking(gone.bookingId);
    await recordPayment(w.db, w.ctx, {
      bookingId: gone.bookingId,
      method: 'bank_transfer',
      amount: BigInt(g.total),
      currency: 'USD',
      reference: 'TRF-GONE',
      receivedOn: today,
      requestKey: 'cash-pay-2',
    });
    await cancelBooking(w.db, w.ctx, { bookingId: gone.bookingId, reason: 'Changed plans' });
    await recordRefund(w.db, w.ctx, {
      bookingId: gone.bookingId,
      method: 'bank_transfer',
      amount: 1_000n,
      currency: 'USD',
      reference: 'RFD-GONE',
      refundedOn: today,
      requestKey: 'cash-refund-1',
    });

    const report = await cashReport(w.db, w.ctx, {
      from: today,
      to: addDays(today, 90),
      grain: 'month',
    });
    const received = BigInt(d.deposit) + 30_000n + BigInt(g.total);
    const thisMonth = report.cashIn.find((r) => r.period === `${today.slice(0, 7)}-01`)!;
    expect(thisMonth).toMatchObject({
      currency: 'USD',
      received,
      refunded: 1_000n,
      reversed: 0n,
      net: received - 1_000n,
    });
    // What fell due over the 90 days includes the invoice and the direct guest's balance.
    const due = report.cashIn.reduce((s, r) => s + r.due, 0n);
    expect(due).toBe(issued.total + BigInt(d.total));
    expect(report.byMethod.map((m) => m.method).sort()).toEqual(
      ['agency_remittance', 'bank_transfer', 'cash'].sort(),
    );

    const usd = report.forecast.find((f) => f.currency === 'USD')!;
    expect(usd.buckets.weeks1_4).toBe(issued.total - 20_000n);
    expect(usd.uninvoicedCredit).toBe(notInvoiced.total);
    // The direct guest's balance falls due before the sailing (63 days out): within 12 weeks.
    expect(usd.buckets.weeks5_8 + usd.buckets.weeks9_12 + usd.buckets.later).toBe(
      BigInt(d.total) - BigInt(d.deposit),
    );
    expect(usd.total).toBe(
      issued.total - 20_000n + notInvoiced.total + BigInt(d.total) - BigInt(d.deposit),
    );

    const month = (
      await owner().query<{ m: string }>(
        `select to_char(embark_date, 'YYYY-MM') as m from vs.sailing where id = $1`,
        [sailingId],
      )
    ).rows[0]!.m;
    const held = report.held.find((h) => h.month === month && h.currency === 'USD')!;
    // Paid on bookings still to sail: the deposit and the agency's payment on its invoice.
    expect(held.paid).toBe(BigInt(d.deposit) + 20_000n);
    expect(held.bookings).toBe(2);
    expect(report.unapplied).toContainEqual({ currency: 'USD', amount: 10_000n });

    // A vessel filter keeps party money out (it belongs to no vessel).
    const vessel = await cashReport(w.db, w.ctx, {
      from: today,
      to: today,
      grain: 'day',
      vesselId: w.demo.vesselId,
    });
    expect(vessel.cashIn[0]!.received).toBe(BigInt(d.deposit) + BigInt(g.total));
    expect(vessel.unapplied).toEqual([]);
  });
});
