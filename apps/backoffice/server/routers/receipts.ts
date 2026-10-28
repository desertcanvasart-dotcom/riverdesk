import {
  allocateReceipt,
  allocateReceiptInput,
  getPartyAccount,
  getReceipt,
  listReceipts,
  listReceiptsInput,
  partyAccountInput,
  recordPartyRefund,
  recordPartyRefundInput,
  recordReceipt,
  recordReceiptInput,
  reverseReceipt,
  reverseReceiptInput,
  setReceiptAttachment,
  setReceiptAttachmentInput,
  unallocateReceipt,
  unallocateReceiptInput,
} from '@vs/engine';
import { z } from 'zod';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

/**
 * Invoicing F3: money received from and paid back to billing parties, and how it pays invoices.
 * Everything here is finance only; receipts are never edited (reversed instead).
 */
export const receiptsRouter = router({
  list: procedure('finance')
    .input(listReceiptsInput)
    .query(({ ctx, input }) => listReceipts(backofficeDb(), ctx.engine, input)),
  get: procedure('finance')
    .input(z.object({ receiptId: z.uuid() }))
    .query(({ ctx, input }) => getReceipt(backofficeDb(), ctx.engine, input)),
  account: procedure('finance')
    .input(partyAccountInput)
    .query(({ ctx, input }) => getPartyAccount(backofficeDb(), ctx.engine, input)),
  record: procedure('finance')
    .input(recordReceiptInput)
    .mutation(({ ctx, input }) => recordReceipt(backofficeDb(), ctx.engine, input)),
  allocate: procedure('finance')
    .input(allocateReceiptInput)
    .mutation(({ ctx, input }) => allocateReceipt(backofficeDb(), ctx.engine, input)),
  unallocate: procedure('finance')
    .input(unallocateReceiptInput)
    .mutation(({ ctx, input }) => unallocateReceipt(backofficeDb(), ctx.engine, input)),
  reverse: procedure('finance')
    .input(reverseReceiptInput)
    .mutation(({ ctx, input }) => reverseReceipt(backofficeDb(), ctx.engine, input)),
  refund: procedure('finance')
    .input(recordPartyRefundInput)
    .mutation(({ ctx, input }) => recordPartyRefund(backofficeDb(), ctx.engine, input)),
  attach: procedure('finance')
    .input(setReceiptAttachmentInput)
    .mutation(({ ctx, input }) => setReceiptAttachment(backofficeDb(), ctx.engine, input)),
});
