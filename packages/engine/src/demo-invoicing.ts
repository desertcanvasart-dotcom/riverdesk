import type { VsDatabase } from '@vs/db';
import { addDays, type BusinessDate } from '@vs/shared';
import { cairoToday, type EngineContext } from './internal';
import { staffBook } from './backoffice/book';
import { recordPayment } from './booking/payments';
import { createInvoiceDraft, getInvoice, issueCreditNote, issueInvoice } from './finance/invoices';
import { recordReceipt } from './finance/receipts';
import { saveAccountMapping } from './finance/reports';
import { updateFinanceSettings } from './finance/settings';

/**
 * Sample invoicing for the demo operator (invoicing F1–F5), all through the engine: the company's
 * issuer details, agency invoices with a remittance and some credit left, a credit note, a
 * direct guest's deposit applied to their invoice, and a few account codes. For looking around
 * locally and for the help pages' screenshots; tests do not use it.
 */
export async function createDemoInvoicing(db: VsDatabase, ctx: EngineContext) {
  const ids = await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const channel = (code: string) =>
      tx.selectFrom('channel').select('id').where('code', '=', code).executeTakeFirstOrThrow();
    const bookings = await tx
      .selectFrom('booking as b')
      .innerJoin('channel as ch', 'ch.id', 'b.channel_id')
      .select(['b.id', 'b.ref', 'b.sailing_id', 'ch.code'])
      .where('b.status', '=', 'confirmed')
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('invoice_line').select('id').whereRef('booking_id', '=', 'b.id'))),
      )
      .orderBy('b.ref')
      .execute();
    const category = await tx
      .selectFrom('cabin_category')
      .select('id')
      .where('code', '=', 'STD')
      .executeTakeFirstOrThrow();
    return {
      nilecrz: (await channel('nilecrz')).id,
      backOffice: (await channel('back-office')).id,
      agent: (await channel('cairo-travel')).id,
      bookings,
      category: category.id,
    };
  });
  const date = (await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    cairoToday(tx),
  )) as BusinessDate;
  const usd = { fxRate: '50.25', fxSource: 'Central Bank of Egypt' };

  await updateFinanceSettings(db, ctx, {
    legalNameAr: 'شركة النيل التجريبية للفنادق العائمة',
    legalNameEn: 'Demo Nile Floating Hotels S.A.E.',
    addressAr: 'كورنيش النيل، الأقصر',
    addressEn: 'Corniche El Nil, Luxor',
    taxRegistrationNo: '512-345-678',
    commercialRegistrationNo: '98765',
    bankDetailsAr: 'البنك التجاري الدولي — حساب دولار 1000 2000 3000',
    bankDetailsEn: 'CIB — USD account 1000 2000 3000',
  });
  for (const [kind, code] of [
    ['receivables', '1200'],
    ['bank', '1020'],
    ['cash', '1010'],
    ['revenue_vessel', '4100'],
  ] as const)
    await saveAccountMapping(db, ctx, { kind, code });

  const issue = async (bookingIds: string[], dueDate?: string) => {
    const draft = await createInvoiceDraft(db, ctx, {
      type: 'invoice',
      bookingIds,
      locale: 'both',
      dueDate,
    });
    return issueInvoice(db, ctx, { invoiceId: draft.invoiceId, ...usd });
  };

  // The platform (nilecrz): two bookings on one invoice, paid in full by its settlement, then a
  // small credit note for a goodwill discount.
  const nile = ids.bookings.filter((b) => b.code === 'nilecrz').slice(0, 2);
  if (nile.length === 2) {
    const invoice = await issue(nile.map((b) => b.id));
    const { party, lines } = await getInvoice(db, ctx, { invoiceId: invoice.invoiceId });
    await recordReceipt(db, ctx, {
      billingPartyId: party.id,
      amount: invoice.total,
      currency: 'USD',
      method: 'platform',
      reference: 'NILECRZ-SETTLEMENT-0425',
      receivedOn: date,
      allocations: [{ invoiceId: invoice.invoiceId, amount: invoice.total }],
    });
    await issueCreditNote(db, ctx, {
      invoiceId: invoice.invoiceId,
      reason: 'Goodwill discount: late embarkation',
      lines: [{ lineId: lines[0]!.id, amount: 10_000n }],
    });
  }

  // The agency on credit: a second booking, both invoiced, a remittance that pays part and leaves
  // some credit, due in two days so it shows on Today.
  const sailingId = ids.bookings.find((b) => b.code === 'cairo-travel')?.sailing_id;
  if (sailingId) {
    const extra = await staffBook(db, ctx, {
      channelId: ids.agent,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: ids.category, adults: 2 }],
      guests: [{ cabin: 0, firstName: 'Karin', lastName: 'Schmidt', lead: true }],
      requestKey: 'demo-invoicing-agent-2',
    });
    const agentBookings = [
      ...ids.bookings.filter((b) => b.code === 'cairo-travel').map((b) => b.id),
      extra.bookingId,
    ];
    const invoice = await issue(agentBookings, addDays(date, 2));
    const { party } = await getInvoice(db, ctx, { invoiceId: invoice.invoiceId });
    await recordReceipt(db, ctx, {
      billingPartyId: party.id,
      amount: 150_000n,
      currency: 'USD',
      method: 'agency_remittance',
      reference: 'SWIFT 7781-CT',
      receivedOn: date,
      note: 'Part payment; the rest on account',
      allocations: [{ invoiceId: invoice.invoiceId, amount: 120_000n }],
    });
  }

  // A direct guest: booked by phone, deposit paid by card, then invoiced (the deposit applies).
  const directSailing = ids.bookings[0]?.sailing_id;
  if (directSailing) {
    const direct = await staffBook(db, ctx, {
      channelId: ids.backOffice,
      sailingId: directSailing,
      market: 'international',
      cabins: [{ categoryId: ids.category, adults: 2 }],
      guests: [{ cabin: 0, firstName: 'Laila', lastName: 'Mansour', lead: true }],
      requestKey: 'demo-invoicing-direct',
    });
    const deposit = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
      tx
        .selectFrom('booking')
        .select('deposit_amount')
        .where('id', '=', direct.bookingId)
        .executeTakeFirstOrThrow(),
    );
    await recordPayment(db, ctx, {
      bookingId: direct.bookingId,
      kind: 'deposit',
      method: 'card_office',
      amount: deposit.deposit_amount || 50_000n,
      currency: 'USD',
      reference: 'POS 004512',
      receivedOn: date,
      requestKey: 'demo-invoicing-deposit',
    });
    await issue([direct.bookingId]);
  }
}
