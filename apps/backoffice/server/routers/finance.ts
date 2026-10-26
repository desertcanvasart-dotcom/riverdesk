import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  createInvoiceDraft,
  createInvoiceDraftInput,
  creditNoteInput,
  deleteInvoiceDraft,
  getFinanceSettings,
  getInvoice,
  issueCreditNote,
  issueInvoice,
  issueInvoiceInput,
  listBillingParties,
  listBillingPartiesInput,
  listInvoices,
  listInvoicesInput,
  listTaxRates,
  saveTaxRate,
  saveTaxRateInput,
  updateBillingParty,
  updateBillingPartyInput,
  updateFinanceSettings,
  updateFinanceSettingsInput,
  updateInvoiceDraft,
  updateInvoiceDraftInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { can } from '../permissions';
import { procedure, router, type StaffCtx } from '../trpc';

const invoiceId = z.object({ invoiceId: z.uuid() });

/** Invoicing F1: the company as issuer, its taxes, and whom it bills. */
export const financeRouter = router({
  settings: procedure('finance').query(({ ctx }) => getFinanceSettings(backofficeDb(), ctx.engine)),
  updateSettings: procedure('finance')
    .input(updateFinanceSettingsInput)
    .mutation(({ ctx, input }) => updateFinanceSettings(backofficeDb(), ctx.engine, input)),
  taxes: procedure('read').query(({ ctx }) => listTaxRates(backofficeDb(), ctx.engine)),
  saveTax: procedure('finance')
    .input(saveTaxRateInput)
    .mutation(({ ctx, input }) => saveTaxRate(backofficeDb(), ctx.engine, input)),
  parties: procedure('read')
    .input(listBillingPartiesInput)
    .query(({ ctx, input }) => listBillingParties(backofficeDb(), ctx.engine, input)),
  updateParty: procedure('finance')
    .input(updateBillingPartyInput)
    .mutation(({ ctx, input }) => updateBillingParty(backofficeDb(), ctx.engine, input)),
});

/** Reservations may edit and delete proformas; a draft invoice needs finance. */
async function assertDraftAllowed(ctx: StaffCtx, id: string) {
  if (can(ctx.staff.role, 'finance')) return;
  const { invoice } = await getInvoice(backofficeDb(), ctx.engine, { invoiceId: id });
  if (invoice.type !== 'proforma')
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Needs finance' });
}

/**
 * Proformas are drafted by reservations; invoices and credit notes only by finance. An issued
 * invoice is never edited: it is corrected by a credit note.
 */
export const invoicesRouter = router({
  list: procedure('read')
    .input(listInvoicesInput)
    .query(({ ctx, input }) => listInvoices(backofficeDb(), ctx.engine, input)),
  get: procedure('read')
    .input(invoiceId)
    .query(({ ctx, input }) => getInvoice(backofficeDb(), ctx.engine, input)),
  createProforma: procedure('bookings.write')
    .input(createInvoiceDraftInput)
    .mutation(({ ctx, input }) =>
      createInvoiceDraft(backofficeDb(), ctx.engine, { ...input, type: 'proforma' }),
    ),
  createDraft: procedure('finance')
    .input(createInvoiceDraftInput)
    .mutation(({ ctx, input }) => createInvoiceDraft(backofficeDb(), ctx.engine, input)),
  updateDraft: procedure('bookings.write')
    .input(updateInvoiceDraftInput)
    .mutation(async ({ ctx, input }) => {
      await assertDraftAllowed(ctx, input.invoiceId);
      return updateInvoiceDraft(backofficeDb(), ctx.engine, input);
    }),
  deleteDraft: procedure('bookings.write')
    .input(invoiceId)
    .mutation(async ({ ctx, input }) => {
      await assertDraftAllowed(ctx, input.invoiceId);
      return deleteInvoiceDraft(backofficeDb(), ctx.engine, input);
    }),
  issue: procedure('finance')
    .input(issueInvoiceInput)
    .mutation(({ ctx, input }) => issueInvoice(backofficeDb(), ctx.engine, input)),
  creditNote: procedure('finance')
    .input(creditNoteInput)
    .mutation(({ ctx, input }) => issueCreditNote(backofficeDb(), ctx.engine, input)),
});
