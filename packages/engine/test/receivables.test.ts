import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, type BusinessDate } from '@vs/shared';
import {
  confirmHold,
  createChannel,
  createContract,
  createHold,
  createInvoiceDraft,
  getActionList,
  getAging,
  getCreditExposure,
  getInvoice,
  getStatement,
  issueCreditNote,
  issueInvoice,
  recordPartyRefund,
  recordReceipt,
  requestAgingDocument,
  requestStatementDocument,
  staffBook,
  todayInCairo,
} from '../src/index';
import { bookingWorld, lead, type BookingWorld } from './helpers/booking-world';

describe('invoicing F4: statements, aging, credit limit, Today', () => {
  let w: BookingWorld;
  let today: BusinessDate;
  let sailingId: string;
  let n = 0;
  const usd = { fxRate: '48.5', fxSource: 'CBE' };
  const agency = async (code: string, limit: number, mode: 'warn' | 'block') => {
    const channel = await createChannel(w.db, w.ctx, {
      code,
      name: code,
      type: 'agent',
      creditAllowed: true,
      creditLimit: limit,
      creditCurrency: 'USD',
    });
    await createContract(w.db, w.ctx, {
      channelId: channel.id,
      vesselId: w.demo.vesselId,
      allocation: 'pool',
      paymentMode: 'credit',
      creditLimitMode: mode,
      creditTermsDays: 14,
      validFrom: w.M,
      categoryIds: Object.values(w.demo.categories),
      ratePlanIds: w.ratePlanIds,
    });
    return channel.id;
  };
  const book = (channelId: string) =>
    staffBook(w.db, w.ctx, {
      channelId,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: `receivables-book-${++n}`,
    });
  const invoiceFor = async (bookingIds: string[]) => {
    const draft = await createInvoiceDraft(w.db, w.ctx, { type: 'invoice', bookingIds });
    return issueInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId, ...usd });
  };

  beforeAll(async () => {
    w = await bookingWorld();
    today = (await todayInCairo(w.db)) as BusinessDate;
    sailingId = await w.sailing('LXR-4', 21);
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('states a party’s account with a running balance that matches its open invoices and credit', async () => {
    const channel = await agency('statement-agent', 100_000_000, 'block');
    const a = await book(channel);
    const b = await book(channel);
    const first = await invoiceFor([a.bookingId]);
    const second = await invoiceFor([b.bookingId]);
    const { party, lines } = await getInvoice(w.db, w.ctx, { invoiceId: first.invoiceId });
    const note = await issueCreditNote(w.db, w.ctx, {
      invoiceId: first.invoiceId,
      reason: 'Discount',
      lines: [{ lineId: lines[0]!.id, amount: 1_000n }],
    });
    await recordReceipt(w.db, w.ctx, {
      billingPartyId: party.id,
      amount: second.total + 5_000n,
      currency: 'USD',
      method: 'agency_remittance',
      reference: 'ST-1',
      receivedOn: today,
      allocations: [{ invoiceId: second.invoiceId, amount: second.total }],
    });
    await recordPartyRefund(w.db, w.ctx, {
      billingPartyId: party.id,
      amount: 2_000n,
      currency: 'USD',
      method: 'bank_transfer',
      reference: 'ST-R',
      refundedOn: today,
    });

    const statement = await getStatement(w.db, w.ctx, {
      billingPartyId: party.id,
      from: today,
      to: today,
    });
    const usdBlock = statement.currencies.find((c) => c.currency === 'USD')!;
    expect(usdBlock.opening).toBe(0n);
    expect(usdBlock.rows.map((r) => [r.kind, r.debit, r.credit])).toEqual([
      ['invoice', first.total, 0n],
      ['invoice', second.total, 0n],
      ['credit_note', 0n, 1_000n],
      ['receipt', 0n, second.total + 5_000n],
      ['refund', 2_000n, 0n],
    ]);
    const closing = first.total - 1_000n - 5_000n + 2_000n;
    expect(usdBlock.closing).toBe(closing);
    expect(usdBlock.rows.at(-1)!.balance).toBe(closing);
    expect(usdBlock.rows.find((r) => r.kind === 'credit_note')!.reference).toBe(note.number);
    // Closing balance = open invoice balances − money not yet on an invoice.
    expect(usdBlock.openInvoices - usdBlock.unappliedCredit).toBe(closing);

    // The next period opens where this one closed.
    const later = await getStatement(w.db, w.ctx, {
      billingPartyId: party.id,
      from: addDays(today, 1),
      to: addDays(today, 30),
    });
    expect(later.currencies[0]).toMatchObject({ opening: closing, closing, rows: [] });

    expect(
      await requestStatementDocument(w.db, w.ctx, {
        billingPartyId: party.id,
        from: today,
        to: today,
        format: 'xlsx',
      }),
    ).toHaveProperty('documentId');
  });

  it('ages open invoices by days past due, as of a date', async () => {
    const channel = await agency('aging-agent', 100_000_000, 'block');
    const a = await book(channel);
    const issued = await invoiceFor([a.bookingId]);
    const { party } = await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId });
    const due = issued.dueDate as BusinessDate;
    const rowOn = async (asOf: string) =>
      (await getAging(w.db, w.ctx, { asOf })).rows.find((r) => r.partyId === party.id);

    expect(await rowOn(addDays(today, -1))).toBeUndefined();
    expect((await rowOn(today))!.buckets.current).toBe(issued.total);
    expect((await rowOn(addDays(due, 10)))!.buckets.d1_30).toBe(issued.total);
    expect((await rowOn(addDays(due, 45)))!.buckets.d31_60).toBe(issued.total);
    expect((await rowOn(addDays(due, 120)))!.buckets.d90_plus).toBe(issued.total);

    // Money received and allocated today is off the balance from today on.
    await recordReceipt(w.db, w.ctx, {
      billingPartyId: party.id,
      amount: 10_000n,
      currency: 'USD',
      method: 'bank_transfer',
      reference: 'AG-1',
      receivedOn: today,
      allocations: [{ invoiceId: issued.invoiceId, amount: 6_000n }],
    });
    const after = (await rowOn(addDays(due, 45)))!;
    expect(after).toMatchObject({
      total: issued.total - 6_000n,
      unappliedCredit: 4_000n,
      net: issued.total - 10_000n,
      invoices: 1,
    });
    expect(await requestAgingDocument(w.db, w.ctx, {})).toHaveProperty('documentId');
  });

  it('counts exposure as uninvoiced bookings plus open invoices less unapplied money', async () => {
    const channel = await agency('exposure-agent', 100_000_000, 'block');
    const a = await book(channel);
    let exposure = await getCreditExposure(w.db, w.ctx, { channelId: channel });
    expect(exposure).toMatchObject({ uninvoiced: a.total, openInvoices: 0n, exposure: a.total });
    const issued = await invoiceFor([a.bookingId]);
    exposure = await getCreditExposure(w.db, w.ctx, { channelId: channel });
    expect(exposure).toMatchObject({ uninvoiced: 0n, openInvoices: issued.total });
    const { party } = await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId });
    await recordReceipt(w.db, w.ctx, {
      billingPartyId: party.id,
      amount: issued.total + 7_000n,
      currency: 'USD',
      method: 'agency_remittance',
      reference: 'EX-1',
      receivedOn: today,
      allocations: [{ invoiceId: issued.invoiceId, amount: issued.total }],
    });
    exposure = await getCreditExposure(w.db, w.ctx, { channelId: channel });
    expect(exposure).toMatchObject({
      openInvoices: 0n,
      unappliedCredit: 7_000n,
      exposure: -7_000n,
    });
    expect(exposure.remaining).toBe(100_000_000n + 7_000n);
  });

  it('over the limit: a block contract makes a request, a warn contract confirms and says so', async () => {
    const quoteTotal = async (channelId: string) => {
      const quoteId = await w.quote(channelId, sailingId, [{ cat: 'STD', adults: 2 }]);
      const hold = await createHold(w.db, w.ctx, { channelId, quoteId, kind: 'option' });
      return hold;
    };
    for (const mode of ['block', 'warn'] as const) {
      // A limit just under one booking.
      const channel = await agency(`limit-${mode}`, 1_000, mode);
      const hold = await quoteTotal(channel);
      const result = await confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead });
      if (mode === 'block') {
        expect(result).toMatchObject({ status: 'requested', reason: 'credit_limit' });
      } else {
        expect(result).toMatchObject({
          status: 'confirmed',
          reason: 'credit_limit_warning',
          creditWarning: { limit: 1_000n, currency: 'USD' },
        });
        expect(result.creditWarning!.exposure).toBeGreaterThan(1_000n);
      }
    }
  });

  it('lists invoices due and money not yet allocated on Today', async () => {
    const channel = await agency('today-agent', 100_000_000, 'block');
    const a = await book(channel);
    const draft = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [a.bookingId],
      dueDate: addDays(today, 2),
    });
    const issued = await issueInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId, ...usd });
    const { party } = await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId });
    const remit = await recordReceipt(w.db, w.ctx, {
      billingPartyId: party.id,
      amount: 3_000n,
      currency: 'USD',
      method: 'agency_remittance',
      reference: 'TD-1',
      receivedOn: today,
    });
    const list = await getActionList(w.db, w.ctx);
    expect(list.invoicesDue).toContainEqual(
      expect.objectContaining({ invoiceId: issued.invoiceId, overdue: false, due: issued.total }),
    );
    expect(list.unallocatedReceipts).toContainEqual(
      expect.objectContaining({ receiptId: remit.receiptId, left: 3_000n }),
    );
    expect(Array.isArray(list.uninvoicedSailed)).toBe(true);
  });
});
