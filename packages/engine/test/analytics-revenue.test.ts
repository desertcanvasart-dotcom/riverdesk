import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { type BusinessDate } from '@vs/shared';
import {
  cancelBooking,
  createChannel,
  createContract,
  createInvoiceDraft,
  getInvoice,
  issueCreditNote,
  issueInvoice,
  recordPayment,
  recordRefund,
  revenueReport,
  staffBook,
  todayInCairo,
} from '../src/index';
import { bookingWorld, lead, type BookingWorld } from './helpers/booking-world';

describe('analytics A2.2: revenue, leakage, currency exposure, base currency', () => {
  let w: BookingWorld;
  let today: BusinessDate;
  let sailingId: string;
  let embark: BusinessDate;
  let agency: string;
  let n = 0;
  const book = (channelId: string) =>
    staffBook(w.db, w.ctx, {
      channelId,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: `revenue-book-${++n}`,
    });
  const row = async (id: string) =>
    (
      await owner().query<{ total: string; net: string; penalty: string | null; fees: string }>(
        `select total::text, net_total::text as net, penalty_amount::text as penalty, fees::text
         from vs.booking where id = $1`,
        [id],
      )
    ).rows[0]!;

  beforeAll(async () => {
    w = await bookingWorld();
    today = (await todayInCairo(w.db)) as BusinessDate;
    sailingId = await w.sailing('LXR-4', 35);
    embark = (
      await owner().query<{ d: string }>(
        `select embark_date::text as d from vs.sailing where id = $1`,
        [sailingId],
      )
    ).rows[0]!.d as BusinessDate;
    agency = (
      await createChannel(w.db, w.ctx, {
        code: 'revenue-agent',
        name: 'Revenue Agent',
        type: 'agent',
        creditAllowed: true,
        creditLimit: 100_000_000,
        creditCurrency: 'USD',
      })
    ).id;
    await createContract(w.db, w.ctx, {
      channelId: agency,
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

  it('adds up booked, commission, invoiced and what leaks, per channel, with an EGP view', async () => {
    // An agency booking on commission, invoiced at 50 EGP per USD, with a 10 USD discount.
    const a = await book(agency);
    const draft = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [a.bookingId],
    });
    const issued = await issueInvoice(w.db, w.ctx, {
      invoiceId: draft.invoiceId,
      fxRate: '50',
      fxSource: 'CBE',
    });
    const { lines } = await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId });
    await issueCreditNote(w.db, w.ctx, {
      invoiceId: issued.invoiceId,
      reason: 'Discount',
      lines: [{ lineId: lines[0]!.id, amount: 1_000n }],
    });
    // A direct guest who paid, cancelled and was refunded what was not kept.
    const c = await book(w.channels.backOffice);
    const cBefore = await row(c.bookingId);
    await recordPayment(w.db, w.ctx, {
      bookingId: c.bookingId,
      method: 'cash',
      amount: BigInt(cBefore.total),
      currency: 'USD',
      reference: 'REV-PAY',
      receivedOn: today,
      requestKey: 'revenue-pay',
    });
    await cancelBooking(w.db, w.ctx, { bookingId: c.bookingId, reason: 'Changed plans' });
    const cAfter = await row(c.bookingId);
    const kept = BigInt(cAfter.penalty ?? '0') + BigInt(cAfter.fees);
    expect(kept > 0n).toBe(true);
    await recordRefund(w.db, w.ctx, {
      bookingId: c.bookingId,
      method: 'cash',
      amount: BigInt(cBefore.total) - kept,
      currency: 'USD',
      reference: 'REV-RFD',
      refundedOn: today,
      requestKey: 'revenue-refund',
    });

    const report = await revenueReport(w.db, w.ctx, {
      basis: 'sailing',
      from: embark,
      to: embark,
      groupBy: 'channel',
    });
    const aRow = await row(a.bookingId);
    const commission = BigInt(aRow.total) - BigInt(aRow.net);
    expect(commission).toBeGreaterThan(0n);
    const agencyRow = report.rows.find((r) => r.group === 'Revenue Agent')!;
    expect(agencyRow).toMatchObject({
      month: embark.slice(0, 7),
      currency: 'USD',
      bookings: 1,
      booked: BigInt(aRow.total),
      commission,
      net: BigInt(aRow.net),
      // Invoiced gross (commission lines left out), less the discount.
      invoiced: BigInt(aRow.total) - 1_000n,
      uninvoiced: 1_000n,
    });
    const direct = report.rows.find((r) => r.group !== 'Revenue Agent')!;
    expect(direct).toMatchObject({ bookings: 1, booked: kept, commission: 0n, invoiced: 0n });

    const leak = report.leakage.find((l) => l.currency === 'USD')!;
    expect(leak).toEqual({
      currency: 'USD',
      commission,
      refunds: BigInt(cBefore.total) - kept,
      penaltiesKept: BigInt(cAfter.penalty ?? '0'),
      amendmentFees: BigInt(cAfter.fees),
      discounts: 1_000n,
    });

    // EGP: invoiced at the invoice's rate, the rest at the latest rate typed (also 50).
    expect(report.base.currency).toBe('EGP');
    expect(report.base.invoiced).toBe((BigInt(aRow.total) - 1_000n) * 50n);
    expect(report.base.booked).toBe((BigInt(aRow.total) + kept) * 50n);
    expect(report.base.rates).toEqual(
      expect.arrayContaining([
        { currency: 'USD', rate: '50', date: null, source: 'invoices' },
        expect.objectContaining({ currency: 'USD', rate: '50', source: 'latest' }),
      ]),
    );
    expect(report.base.missing).toEqual([]);

    // Exposure: the agency booking is still to sail, unpaid, and its invoice is open.
    const exposure = report.exposure.find((e) => e.currency === 'USD')!;
    expect(exposure.futureBookings).toBeGreaterThanOrEqual(1);
    expect(exposure.futureDue).toBe(exposure.futureBooked - exposure.futurePaid);
    expect(exposure.openInvoices).toBeGreaterThanOrEqual(issued.total - 1_000n);

    // By booking date: the same two bookings, this month.
    const booked = await revenueReport(w.db, w.ctx, {
      basis: 'booked',
      from: today,
      to: today,
      groupBy: 'market',
    });
    expect(booked.rows.find((r) => r.group === 'international')!.bookings).toBeGreaterThanOrEqual(
      2,
    );
  });
});
