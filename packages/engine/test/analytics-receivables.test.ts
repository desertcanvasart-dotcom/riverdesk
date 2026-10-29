import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, type BusinessDate } from '@vs/shared';
import {
  createInvoiceDraft,
  getInvoice,
  issueInvoice,
  receivablesReport,
  recordReceipt,
  staffBook,
  todayInCairo,
  unallocateReceipt,
} from '../src/index';
import { bookingWorld, lead, type BookingWorld } from './helpers/booking-world';

describe('analytics A2.3: receivables by party', () => {
  let w: BookingWorld;
  let today: BusinessDate;
  let sailingId: string;
  let n = 0;
  const book = () =>
    staffBook(w.db, w.ctx, {
      channelId: w.agents.credit,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: `receivables-book-${++n}`,
    });
  const invoice = async (dueDate: string) => {
    const b = await book();
    const draft = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [b.bookingId],
      dueDate,
    });
    return issueInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId, fxRate: '50' });
  };

  beforeAll(async () => {
    w = await bookingWorld();
    today = (await todayInCairo(w.db)) as BusinessDate;
    sailingId = await w.sailing('LXR-4', 42);
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('ages what each party owes, measures how fast it pays, and shows credit used', async () => {
    // Paid the day it was issued (on time); paid 5 days later, after its due date (late).
    const early = await invoice(addDays(today, 10));
    const late = await invoice(addDays(today, 2));
    const open = await invoice(addDays(today, 20));
    const { party } = await getInvoice(w.db, w.ctx, { invoiceId: early.invoiceId });
    const pay = (invoiceId: string, amount: bigint, receivedOn: string, reference: string) =>
      recordReceipt(w.db, w.ctx, {
        billingPartyId: party.id,
        amount,
        currency: 'USD',
        method: 'agency_remittance',
        reference,
        receivedOn,
        allocations: [{ invoiceId, amount }],
      });
    await pay(early.invoiceId, early.total, today, 'RCV-1');
    await pay(late.invoiceId, late.total, addDays(today, 5), 'RCV-2');
    // Money put on an invoice and taken back off does not count as paying it.
    const undone = await pay(open.invoiceId, 5_000n, today, 'RCV-3');
    await unallocateReceipt(w.db, w.ctx, {
      receiptId: undone.receiptId,
      invoiceId: open.invoiceId,
    });

    const report = await receivablesReport(w.db, w.ctx);
    const row = report.rows.find((r) => r.partyId === party.id && r.currency === 'USD')!;
    expect(row).toMatchObject({
      kind: 'agency',
      open: open.total,
      overdue: 0n,
      unapplied: 5_000n,
      paidInWindow: early.total + late.total,
    });
    expect(row.buckets.current).toBe(open.total);
    const weighted = (5n * late.total * 10n) / (early.total + late.total);
    expect(row.averageDaysToPay).toBe(Number(weighted) / 10);
    const onTime = (early.total * 1000n) / (early.total + late.total);
    expect(row.paidOnTimeShare).toBe(Number(onTime) / 1000);

    const credit = report.credit.find((c) => c.channelId === w.agents.credit)!;
    expect(credit).toMatchObject({
      currency: 'USD',
      limit: 100_000_000n,
      openInvoices: open.total,
      unappliedCredit: 5_000n,
    });
    expect(credit.exposure).toBe(credit.uninvoiced + credit.openInvoices - credit.unappliedCredit);
    expect(credit.remaining).toBe(100_000_000n - credit.exposure);
    expect(credit.usedShare).toBe(Number((credit.exposure * 1000n) / 100_000_000n) / 1000);
    expect(report.since).toBe(addDays(today, -365));
  });
});
