import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner, testConfig } from '@vs/db/testing';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import {
  cancelBooking,
  createChannel,
  createContract,
  createInvoiceDraft,
  deleteInvoiceDraft,
  getFinanceSettings,
  getInvoice,
  invoiceDocumentData,
  invoiceRegisterData,
  requestInvoiceDocument,
  requestInvoiceRegister,
  issueCreditNote,
  issueInvoice,
  lineTax,
  listBillingParties,
  listInvoices,
  openDatabase,
  recordPayment,
  saveTaxRate,
  staffBook,
  todayInCairo,
  updateBillingParty,
  updateFinanceSettings,
  updateInvoiceDraft,
} from '../src/index';
import { bookingWorld, lead, type BookingWorld } from './helpers/booking-world';

const codeOf = async (promise: Promise<unknown>): Promise<ErrorCode | 'ok'> =>
  promise.then(
    () => 'ok' as const,
    (e: unknown) => (isDomainError(e) ? e.code : Promise.reject(e)),
  );
const pgCode = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );

describe('invoicing F1', () => {
  let w: BookingWorld;
  let year: string;
  let sailingId: string;
  let n = 0;
  const book = (channelId: string, cabins = [{ categoryId: '', adults: 2 }]) =>
    staffBook(w.db, w.ctx, {
      channelId,
      sailingId,
      market: 'international',
      cabins: cabins.map((c) => ({ ...c, categoryId: c.categoryId || w.demo.categories.STD })),
      guests: lead,
      requestKey: `invoice-book-${++n}`,
    });
  const usd = { fxRate: '48.5', fxSource: 'CBE', fxDate: undefined };

  beforeAll(async () => {
    w = await bookingWorld();
    year = (await todayInCairo(w.db)).slice(0, 4);
    sailingId = await w.sailing('LXR-4', 21);
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('rounds tax per line, half-up, inclusive or on top', () => {
    expect(lineTax(1140n, 1400, true)).toBe(140n);
    expect(lineTax(1000n, 1400, false)).toBe(140n);
    expect(lineTax(1001n, 1400, true)).toBe(123n); // 122.93 → 123
    expect(lineTax(-1140n, 1400, true)).toBe(-140n);
    expect(lineTax(5000n, 0, true)).toBe(0n);
  });

  it('invoices a credit agency for its bookings, numbered at issue with the typed rate', async () => {
    const a = await book(w.agents.credit, [
      { categoryId: w.demo.categories.STD, adults: 2 },
      { categoryId: w.demo.categories.SUP, adults: 1 },
    ]);
    const b = await book(w.agents.credit);
    const draft = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [a.bookingId, b.bookingId],
      locale: 'both',
    });
    expect(draft.total).toBe(a.total + b.total);
    const { invoice, lines, party } = await getInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId });
    expect(invoice).toMatchObject({
      status: 'draft',
      number: null,
      currency: 'USD',
      base_currency: 'EGP',
    });
    expect(party).toMatchObject({
      kind: 'agency',
      channel_id: w.agents.credit,
      name: 'credit-agent',
    });
    expect(lines.map((l) => [l.kind, l.booking_ref])).toEqual([
      ['cabin', a.ref],
      ['cabin', a.ref],
      ['cabin', b.ref],
    ]);
    expect(lines[0]!.description_en).toContain(a.ref);
    expect(lines[0]!.description_ar).toContain('كابينة');

    // USD against an EGP base needs a rate.
    expect(await codeOf(issueInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId }))).toBe(
      'VALIDATION_FAILED',
    );
    const issued = await issueInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId, ...usd });
    expect(issued.number).toBe(`INV-${year}-00001`);
    const after = (await getInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId })).invoice;
    expect(after).toMatchObject({ status: 'issued', fx_rate: '48.5', fx_source: 'CBE', seq: 1 });
    expect(after.issue_date).toBe(issued.issueDate);
    expect(after.due_date! >= after.issue_date!).toBe(true);
    expect(after.party_snapshot).toMatchObject({ kind: 'agency', name: 'credit-agent' });
    expect(after.issuer_snapshot).toMatchObject({ etaFooter: true });

    // A party edit later does not change the issued invoice.
    await updateBillingParty(w.db, w.ctx, { id: party.id, legalNameEn: 'Credit Agent LLC' });
    const again = (await getInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId })).invoice;
    expect(again.party_snapshot).toMatchObject({ legalNameEn: null });
  });

  it('keeps a booking on one open invoice until it is fully credited', async () => {
    const a = await book(w.agents.credit);
    const first = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [a.bookingId],
    });
    // A second draft while the first is open is refused.
    expect(
      await codeOf(createInvoiceDraft(w.db, w.ctx, { type: 'invoice', bookingIds: [a.bookingId] })),
    ).toBe('INVALID_STATE');
    const issued = await issueInvoice(w.db, w.ctx, { invoiceId: first.invoiceId, ...usd });
    expect(
      await codeOf(createInvoiceDraft(w.db, w.ctx, { type: 'invoice', bookingIds: [a.bookingId] })),
    ).toBe('INVALID_STATE');

    // A partial credit leaves it open.
    const { lines } = await getInvoice(w.db, w.ctx, { invoiceId: first.invoiceId });
    const partial = await issueCreditNote(w.db, w.ctx, {
      invoiceId: first.invoiceId,
      reason: 'Goodwill',
      lines: [{ lineId: lines[0]!.id, amount: 1000n }],
    });
    expect(partial).toMatchObject({
      number: `CN-${year}-00001`,
      total: 1000n,
      invoiceStatus: 'issued',
    });
    expect(
      await codeOf(
        issueCreditNote(w.db, w.ctx, { invoiceId: first.invoiceId, reason: 'All of it' }),
      ),
    ).toBe('VALIDATION_FAILED');
    // Crediting the rest closes it.
    const rest = await issueCreditNote(w.db, w.ctx, {
      invoiceId: first.invoiceId,
      reason: 'Wrong agency',
      lines: [{ lineId: lines[0]!.id, amount: issued.total - 1000n }],
    });
    expect(rest).toMatchObject({ number: `CN-${year}-00002`, invoiceStatus: 'cancelled' });
    const note = await getInvoice(w.db, w.ctx, { invoiceId: rest.creditNoteId });
    expect(note.invoice).toMatchObject({
      type: 'credit_note',
      credits_invoice_id: first.invoiceId,
      fx_rate: '48.5',
    });
    expect(
      await codeOf(issueCreditNote(w.db, w.ctx, { invoiceId: first.invoiceId, reason: 'Again' })),
    ).toBe('INVALID_STATE');
    // Now it can be invoiced again.
    const second = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [a.bookingId],
    });
    expect(second.total).toBe(issued.total);
    await deleteInvoiceDraft(w.db, w.ctx, { invoiceId: second.invoiceId });
  });

  it('bills the guest on a direct booking; a proforma is copied into the invoice', async () => {
    const a = await book(w.channels.backOffice);
    const proforma = await createInvoiceDraft(w.db, w.ctx, {
      type: 'proforma',
      bookingIds: [a.bookingId],
      notes: 'Pay by bank transfer',
    });
    const read = await getInvoice(w.db, w.ctx, { invoiceId: proforma.invoiceId });
    expect(read.party).toMatchObject({ kind: 'guest', name: 'Mona Hassan', channel_id: null });
    await updateInvoiceDraft(w.db, w.ctx, {
      invoiceId: proforma.invoiceId,
      locale: 'en',
      manualLines: [
        { descriptionAr: 'نقل', descriptionEn: 'Airport transfer', unitAmount: 2500n, quantity: 2 },
      ],
    });
    const edited = await getInvoice(w.db, w.ctx, { invoiceId: proforma.invoiceId });
    expect(edited.lines.map((l) => l.kind)).toEqual(['cabin', 'manual']);
    expect(edited.invoice.total).toBe(a.total + 5000n);

    // A direct booking waits for its payment; only a confirmed booking is invoiced.
    expect(await codeOf(issueInvoice(w.db, w.ctx, { invoiceId: proforma.invoiceId, ...usd }))).toBe(
      'INVALID_STATE',
    );
    await recordPayment(w.db, w.ctx, {
      bookingId: a.bookingId,
      method: 'bank_transfer',
      amount: a.total,
      currency: 'USD',
      reference: 'TRF-1',
      receivedOn: (await todayInCairo(w.db)) as string,
      requestKey: `pay-${a.ref}`,
    });
    const issued = await issueInvoice(w.db, w.ctx, { invoiceId: proforma.invoiceId, ...usd });
    expect(issued.invoiceId).not.toBe(proforma.invoiceId);
    expect(issued.total).toBe(a.total + 5000n);
    const kept = await getInvoice(w.db, w.ctx, { invoiceId: proforma.invoiceId });
    expect(kept.invoice).toMatchObject({ type: 'proforma', status: 'draft', number: null });
    const invoice = await getInvoice(w.db, w.ctx, { invoiceId: issued.invoiceId });
    expect(invoice.party.id).toBe(read.party.id);
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.invoice).toMatchObject({ locale: 'en', notes: 'Pay by bank transfer' });
  });

  it('shows the gross and deducts the commission for a commission contract', async () => {
    const channel = await createChannel(w.db, w.ctx, {
      code: 'commission-agent',
      name: 'Commission Agent',
      type: 'agent',
      creditAllowed: true,
      creditLimit: 100_000_000,
      creditCurrency: 'USD',
    });
    await createContract(w.db, w.ctx, {
      channelId: channel.id,
      vesselId: w.demo.vesselId,
      allocation: 'pool',
      paymentMode: 'credit',
      priceAdjustment: 'commission',
      adjustmentBps: 1000,
      creditTermsDays: 30,
      validFrom: w.M,
      categoryIds: Object.values(w.demo.categories),
      ratePlanIds: w.ratePlanIds,
    });
    const a = await book(channel.id);
    const draft = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [a.bookingId],
    });
    const { lines } = await getInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId });
    expect(lines.map((l) => l.kind)).toEqual(['cabin', 'commission']);
    expect(lines[1]!.amount).toBeLessThan(0n);
    const { rows } = await owner().query<{ net_total: string }>(
      `select net_total::text from vs.booking where id = $1`,
      [a.bookingId],
    );
    expect(draft.total).toBe(BigInt(rows[0]!.net_total));
    await deleteInvoiceDraft(w.db, w.ctx, { invoiceId: draft.invoiceId });
  });

  it('invoices only the penalty of a cancelled booking', async () => {
    const a = await book(w.agents.credit);
    expect(
      await codeOf(
        createInvoiceDraft(w.db, w.ctx, { type: 'proforma', bookingIds: [a.bookingId] }),
      ),
    ).toBe('ok');
    await cancelBooking(w.db, w.ctx, {
      bookingId: a.bookingId,
      reason: 'Test',
      requestKey: `cancel-${a.ref}`,
    });
    const { rows } = await owner().query<{ penalty_amount: string | null }>(
      `select penalty_amount::text from vs.booking where id = $1`,
      [a.bookingId],
    );
    const penalty = BigInt(rows[0]!.penalty_amount ?? '0');
    const result = createInvoiceDraft(w.db, w.ctx, { type: 'invoice', bookingIds: [a.bookingId] });
    if (penalty === 0n) {
      expect(await codeOf(result)).toBe('VALIDATION_FAILED');
    } else {
      const draft = await result;
      const { lines } = await getInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId });
      expect(lines.map((l) => [l.kind, l.amount])).toEqual([['penalty', penalty]]);
      await deleteInvoiceDraft(w.db, w.ctx, { invoiceId: draft.invoiceId });
    }
  });

  it('applies the default tax to booking lines and snapshots it', async () => {
    const vat = await saveTaxRate(w.db, w.ctx, {
      nameAr: 'ضريبة القيمة المضافة',
      nameEn: 'VAT',
      rateBps: 1400,
      inclusive: true,
      isDefault: true,
    });
    const a = await book(w.agents.credit);
    const draft = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [a.bookingId],
    });
    expect(draft.total).toBe(a.total);
    expect(draft.taxTotal).toBe(lineTax(a.total, 1400, true));
    expect(draft.subtotal + draft.taxTotal).toBe(a.total);
    await issueInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId, ...usd });
    // Changing the rate later leaves the issued invoice alone.
    await saveTaxRate(w.db, w.ctx, {
      id: vat.id,
      nameAr: 'ضريبة',
      nameEn: 'VAT',
      rateBps: 1000,
      isDefault: false,
    });
    const { lines } = await getInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId });
    expect(lines[0]).toMatchObject({ tax_bps: 1400, tax_name_en: 'VAT', tax_inclusive: true });
  });

  it('refuses any change to an issued invoice in the database itself', async () => {
    const [issued] = await listInvoices(w.db, w.ctx, {
      type: 'invoice',
      status: 'issued',
      limit: 1,
    });
    const id = issued!.id;
    const db = owner();
    expect(
      await pgCode(db.query(`update vs.invoice set total = total + 1 where id = $1`, [id])),
    ).toBe('42501');
    expect(await pgCode(db.query(`update vs.invoice set number = 'X' where id = $1`, [id]))).toBe(
      '42501',
    );
    expect(
      await pgCode(db.query(`update vs.invoice set status = 'draft' where id = $1`, [id])),
    ).toBe('42501');
    expect(await pgCode(db.query(`delete from vs.invoice where id = $1`, [id]))).toBe('42501');
    expect(
      await pgCode(
        db.query(`update vs.invoice_line set amount = amount where invoice_id = $1`, [id]),
      ),
    ).toBe('42501');
    expect(await pgCode(db.query(`delete from vs.invoice_line where invoice_id = $1`, [id]))).toBe(
      '42501',
    );
    expect(
      await pgCode(
        db.query(
          `insert into vs.invoice_line (operator_id, invoice_id, seq, kind, description_ar, description_en, unit_amount, amount)
           select operator_id, id, 99, 'manual', 'x', 'x', 1, 1 from vs.invoice where id = $1`,
          [id],
        ),
      ),
    ).toBe('42501');
    // Status and the paid amount may still move.
    expect(
      await pgCode(
        db.query(`update vs.invoice set amount_paid = 0, status = 'issued' where id = $1`, [id]),
      ),
    ).toBe('ok');
    expect(await codeOf(updateInvoiceDraft(w.db, w.ctx, { invoiceId: id, notes: 'x' }))).toBe(
      'INVALID_STATE',
    );
    expect(await codeOf(deleteInvoiceDraft(w.db, w.ctx, { invoiceId: id }))).toBe('INVALID_STATE');
  });

  it('numbers concurrent issues without gaps or duplicates', async () => {
    const [party] = await listBillingParties(w.db, w.ctx, { kind: 'agency' });
    const drafts = [];
    for (let i = 0; i < 12; i++) {
      drafts.push(
        await createInvoiceDraft(w.db, w.ctx, {
          type: 'invoice',
          billingPartyId: party!.id,
          currency: 'EGP',
          manualLines: [
            {
              descriptionAr: `بند ${i}`,
              descriptionEn: `Item ${i}`,
              unitAmount: 10_000n + BigInt(i),
            },
          ],
        }),
      );
    }
    // One draft that fails at issue (an EGP invoice given a rate) must not leave a gap.
    const failing = drafts[5]!;
    // The channel API's role has no rights on invoices at all.
    const api = w.wide(1);
    expect(await pgCode(issueInvoice(api, w.ctx, { invoiceId: drafts[0]!.invoiceId }))).toBe(
      '42501',
    );
    const pool = openDatabase('vs_backoffice', { config: testConfig(), max: 14 });
    const results = await Promise.allSettled(
      drafts.map((d) =>
        issueInvoice(
          pool,
          w.ctx,
          d === failing ? { invoiceId: d.invoiceId, fxRate: '1.5' } : { invoiceId: d.invoiceId },
        ),
      ),
    );
    await pool.close();
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const { rows } = await owner().query<{ seq: number; number: string }>(
      `select seq, number from vs.invoice where operator_id = $1 and series = 'invoice' order by seq`,
      [w.ctx.operatorId],
    );
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    expect(new Set(rows.map((r) => r.number)).size).toBe(rows.length);
  });

  it('prints from frozen snapshots and lists issued documents in the register (F2)', async () => {
    // The first invoice, issued before its agency's legal name was added.
    const issued = (await listInvoices(w.db, w.ctx, { type: 'invoice', limit: 500 })).find(
      (i) => i.number === `INV-${year}-00001`,
    );
    const data = await invoiceDocumentData(w.db, w.ctx, issued!.id);
    expect(data).toMatchObject({ type: 'invoice', currency: 'USD', baseCurrency: 'EGP' });
    expect(data.fx).toMatchObject({ rate: '48.5', source: 'CBE' });
    // The snapshot, not today's party: the legal name added later is not on it.
    expect(data.party.legalNameEn).toBeNull();
    const { documentId } = await requestInvoiceDocument(w.db, w.ctx, {
      invoiceId: issued!.id,
      locale: 'both',
    });
    const doc = await owner().query(
      `select kind, format, entity, entity_id from vs.document where id = $1`,
      [documentId],
    );
    expect(doc.rows[0]).toMatchObject({
      kind: 'invoice',
      format: 'pdf',
      entity: 'invoice',
      entity_id: issued!.id,
    });

    const today = await todayInCairo(w.db);
    const rows = await invoiceRegisterData(w.db, w.ctx, { from: today, to: today });
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => r.number && r.issueDate === today)).toBe(true);
    const note = rows.find((r) => r.type === 'credit_note')!;
    expect(note.credits).toMatch(/^INV-/);
    const usd = rows.find((r) => r.currency === 'USD' && r.type === 'invoice')!;
    expect(usd.baseTotal).toBeGreaterThan(usd.total);
    const register = await requestInvoiceRegister(w.db, w.ctx, { from: today, to: today });
    const reg = await owner().query(
      `select kind, format, entity, params from vs.document where id = $1`,
      [register.documentId],
    );
    expect(reg.rows[0]).toMatchObject({
      kind: 'invoice_register',
      format: 'xlsx',
      entity: 'operator',
    });
  });

  it('locks numbering once a series has been issued', async () => {
    const settings = await getFinanceSettings(w.db, w.ctx);
    expect(settings.numberingLocked).toEqual({ invoice: true, credit_note: true });
    expect(await codeOf(updateFinanceSettings(w.db, w.ctx, { invoicePrefix: 'FAC' }))).toBe(
      'INVALID_STATE',
    );
    expect(await codeOf(updateFinanceSettings(w.db, w.ctx, { baseCurrency: 'USD' }))).toBe(
      'INVALID_STATE',
    );
    const updated = await updateFinanceSettings(w.db, w.ctx, {
      legalNameEn: 'Demo Nile Cruises S.A.E.',
      taxRegistrationNo: '123-456-789',
      bankDetailsEn: 'CIB, IBAN EG00 0000',
    });
    expect(updated).toMatchObject({
      legal_name_en: 'Demo Nile Cruises S.A.E.',
      invoice_prefix: 'INV',
    });
  });
});

describe('invoicing F1: a company continuing a paper series', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('starts at the first number and prefix it chose', async () => {
    await updateFinanceSettings(w.db, w.ctx, {
      invoicePrefix: 'FAC',
      firstInvoiceNumber: 431,
      numberDigits: 4,
    });
    const parties = await listBillingParties(w.db, w.ctx);
    expect(parties).toEqual([]);
    const sailingId = await w.sailing('LXR-4', 21);
    const a = await staffBook(w.db, w.ctx, {
      channelId: w.agents.credit,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: 'paper-series',
    });
    const draft = await createInvoiceDraft(w.db, w.ctx, {
      type: 'invoice',
      bookingIds: [a.bookingId],
    });
    const issued = await issueInvoice(w.db, w.ctx, { invoiceId: draft.invoiceId, fxRate: '50' });
    const year = (await todayInCairo(w.db)).slice(0, 4);
    expect(issued.number).toBe(`FAC-${year}-0431`);
  });
});
