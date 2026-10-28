import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BusinessDate } from '@vs/shared';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import {
  createChannel,
  createContract,
  createInvoiceDraft,
  getAccountantExport,
  getFinanceReport,
  getInvoice,
  issueCreditNote,
  issueInvoice,
  listAccountMappings,
  recordReceipt,
  requestAccountantExport,
  requestFinanceReport,
  saveAccountMapping,
  saveTaxRate,
  staffBook,
  todayInCairo,
} from '../src/index';
import { bookingWorld, lead, type BookingWorld } from './helpers/booking-world';

const codeOf = async (promise: Promise<unknown>): Promise<ErrorCode | 'ok'> =>
  promise.then(
    () => 'ok' as const,
    (e: unknown) => (isDomainError(e) ? e.code : Promise.reject(e)),
  );

describe('invoicing F5: finance reports, account codes, accountant exports', () => {
  let w: BookingWorld;
  let today: BusinessDate;
  let sailingId: string;
  let embark: string;
  let channel: string;
  let partyId: string;
  let invoiceTotal: bigint;
  let n = 0;
  const book = () =>
    staffBook(w.db, w.ctx, {
      channelId: channel,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: `reports-book-${++n}`,
    });

  beforeAll(async () => {
    w = await bookingWorld();
    today = (await todayInCairo(w.db)) as BusinessDate;
    sailingId = await w.sailing('LXR-4', 21);
    embark = (
      await w.db.withTenantTx(w.ctx.operatorId, w.ctx.actor, ({ db }) =>
        db
          .selectFrom('sailing')
          .select('embark_date')
          .where('id', '=', sailingId)
          .executeTakeFirstOrThrow(),
      )
    ).embark_date;
    channel = (
      await createChannel(w.db, w.ctx, {
        code: 'reports-agent',
        name: 'Reports Agent',
        type: 'agent',
        creditAllowed: true,
        creditLimit: 100_000_000,
        creditCurrency: 'USD',
      })
    ).id;
    await createContract(w.db, w.ctx, {
      channelId: channel,
      vesselId: w.demo.vesselId,
      allocation: 'pool',
      paymentMode: 'credit',
      priceAdjustment: 'commission',
      adjustmentBps: 1000,
      validFrom: w.M,
      categoryIds: Object.values(w.demo.categories),
      ratePlanIds: w.ratePlanIds,
    });
    // A 14% tax included in booking lines, so the journal has a tax line.
    await saveTaxRate(w.db, w.ctx, {
      nameAr: 'ضريبة القيمة المضافة',
      nameEn: 'VAT',
      rateBps: 1400,
      inclusive: true,
      isDefault: true,
    });
    const a = await book();
    await book(); // booked, not invoiced
    const draft = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [a.bookingId],
    });
    const issued = await issueInvoice(w.db, w.ctx, {
      invoiceId: draft.invoiceId,
      fxRate: '50',
      fxSource: 'CBE',
    });
    invoiceTotal = issued.total;
    const inv = await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId });
    partyId = inv.party.id;
    await issueCreditNote(w.db, w.ctx, {
      invoiceId: issued.invoiceId,
      reason: 'Goodwill',
      lines: [{ lineId: inv.lines[0]!.id, amount: 1_140n }],
    });
    await recordReceipt(w.db, w.ctx, {
      billingPartyId: partyId,
      amount: 20_000n,
      currency: 'USD',
      method: 'bank_transfer',
      reference: 'RPT-1',
      receivedOn: today,
      allocations: [{ invoiceId: issued.invoiceId, amount: 20_000n }],
    });
    await recordReceipt(w.db, w.ctx, {
      billingPartyId: partyId,
      amount: 5_000n,
      currency: 'USD',
      method: 'cash',
      reference: 'RPT-2',
      receivedOn: today,
    });
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  const period = () => ({ from: today, to: today });

  it('reports invoiced revenue before tax by month, vessel, sailing and channel, net of credit notes', async () => {
    const report = await getFinanceReport(w.db, w.ctx, {
      report: 'revenue',
      ...period(),
      channelId: channel,
    });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row).toMatchObject({
      channel: 'Reports Agent',
      embark,
      currency: 'USD',
      credited: 1_000n,
    });
    // Net = invoiced − credited; tax 14% included: 1140 credited = 1000 + 140 tax.
    expect(row.net).toBe((row.invoiced as bigint) - 1_000n);
    expect((row.invoiced as bigint) + (row.tax as bigint) + 1_140n - 1_000n).toBeGreaterThan(0n);
  });

  it('reports production by sailing: booked value, invoiced and not yet invoiced', async () => {
    const report = await getFinanceReport(w.db, w.ctx, {
      report: 'production',
      from: embark as BusinessDate,
      to: embark as BusinessDate,
      channelId: channel,
    });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.bookings).toBe(2);
    // The second booking is not invoiced; the first is, less the credit note.
    expect((row.booked as bigint) - (row.invoiced as bigint)).toBe(row.uninvoiced);
    expect(row.uninvoiced as bigint).toBeGreaterThan((row.booked as bigint) / 2n);
  });

  it('reports collections by month and method, and what is outstanding by party', async () => {
    const collections = await getFinanceReport(w.db, w.ctx, {
      report: 'collections',
      ...period(),
      channelId: channel,
    });
    expect(collections.rows.map((r) => [r.method, r.received, r.net])).toEqual([
      ['bank_transfer', 20_000n, 20_000n],
      ['cash', 5_000n, 5_000n],
    ]);
    const outstanding = await getFinanceReport(w.db, w.ctx, { report: 'outstanding', ...period() });
    const row = outstanding.rows.find((r) => r.party === 'Reports Agent')!;
    expect(row).toMatchObject({
      currency: 'USD',
      invoices: 1,
      open: invoiceTotal - 1_140n - 20_000n,
      unapplied: 5_000n,
      net: invoiceTotal - 1_140n - 25_000n,
    });
  });

  it('keeps account codes per kind, and per vessel, channel or tax', async () => {
    await saveAccountMapping(w.db, w.ctx, { kind: 'receivables', code: '1200' });
    await saveAccountMapping(w.db, w.ctx, {
      kind: 'revenue_vessel',
      refId: w.demo.vesselId,
      code: '4100',
    });
    await saveAccountMapping(w.db, w.ctx, { kind: 'receivables', code: '1210' });
    expect(
      await codeOf(
        saveAccountMapping(w.db, w.ctx, { kind: 'cash', refId: w.demo.vesselId, code: 'x' }),
      ),
    ).toBe('VALIDATION_FAILED');
    const list = await listAccountMappings(w.db, w.ctx);
    expect(list.codes).toEqual(
      expect.arrayContaining([
        { kind: 'receivables', ref_id: null, code: '1210' },
        { kind: 'revenue_vessel', ref_id: w.demo.vesselId, code: '4100' },
      ]),
    );
    await saveAccountMapping(w.db, w.ctx, {
      kind: 'revenue_vessel',
      refId: w.demo.vesselId,
      code: '',
    });
    expect(
      (await listAccountMappings(w.db, w.ctx)).codes.some((c) => c.kind === 'revenue_vessel'),
    ).toBe(false);
    await saveAccountMapping(w.db, w.ctx, {
      kind: 'revenue_vessel',
      refId: w.demo.vesselId,
      code: '4100',
    });
  });

  it('writes a balanced journal, with the codes still to set', async () => {
    const journal = await getAccountantExport(w.db, w.ctx, { content: 'journal', ...period() });
    const byDocument = new Map<string, { debit: bigint; credit: bigint }>();
    for (const row of journal.rows) {
      const doc = byDocument.get(row.document as string) ?? { debit: 0n, credit: 0n };
      doc.debit += row.debit as bigint;
      doc.credit += row.credit as bigint;
      byDocument.set(row.document as string, doc);
    }
    for (const [doc, sums] of byDocument) expect(sums.debit, doc).toBe(sums.credit);
    const accounts = new Set(journal.rows.map((r) => r.account));
    expect([...accounts].sort()).toEqual(
      ['bank', 'cash', 'commission', 'receivables', 'revenue_vessel', 'tax_payable'].sort(),
    );
    expect(journal.rows.find((r) => r.account === 'receivables')!.code).toBe('1210');
    expect(journal.rows.find((r) => r.account === 'revenue_vessel')!.code).toBe('4100');
    // The invoice in USD has a rate to EGP: its entries carry the base amount.
    const receivable = journal.rows.find(
      (r) => r.account === 'receivables' && (r.debit as bigint) > 0n,
    )!;
    expect(receivable.base_debit).toBe((receivable.debit as bigint) * 50n);
    expect(journal.unmapped!.map((u) => u.kind).sort()).toEqual([
      'bank',
      'cash',
      'commission',
      'tax_payable',
    ]);
  });

  it('exports invoices and payments, and queues the files', async () => {
    const invoices = await getAccountantExport(w.db, w.ctx, { content: 'invoices', ...period() });
    expect(invoices.rows.map((r) => r.type).sort()).toEqual(['credit_note', 'invoice']);
    // Credit notes are negative, so the totals add up to net sales.
    expect(invoices.rows.find((r) => r.type === 'credit_note')!.total).toBe(-1_140n);
    const payments = await getAccountantExport(w.db, w.ctx, { content: 'payments', ...period() });
    expect(
      payments.rows.filter((r) => r.party === 'Reports Agent').map((r) => r.reference),
    ).toEqual(['RPT-1', 'RPT-2']);
    expect(
      await requestAccountantExport(w.db, w.ctx, {
        content: 'journal',
        ...period(),
        format: 'csv',
      }),
    ).toHaveProperty('documentId');
    expect(
      await requestFinanceReport(w.db, w.ctx, { report: 'revenue', ...period() }),
    ).toHaveProperty('documentId');
    expect(
      await codeOf(
        getFinanceReport(w.db, w.ctx, { report: 'revenue', from: today, to: '2000-01-01' }),
      ),
    ).toBe('VALIDATION_FAILED');
  });
});
