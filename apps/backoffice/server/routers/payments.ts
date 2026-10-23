import { z } from 'zod';
import {
  calculateRefund,
  calculateRefundInput,
  listPayments,
  recordPayment,
  recordPaymentInput,
  recordRefund,
  recordRefundInput,
  reversePayment,
  reversePaymentInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The ledger is append-only: mistakes are reversed, money back is a refund. */
export const paymentsRouter = router({
  ledger: procedure('read')
    .input(
      z.object({
        from: date.optional(),
        to: date.optional(),
        method: z.string().max(30).optional(),
      }),
    )
    .query(({ ctx, input }) => listPayments(backofficeDb(), ctx.engine, input)),
  record: procedure('payments.write')
    .input(recordPaymentInput)
    .mutation(({ ctx, input }) => recordPayment(backofficeDb(), ctx.engine, input)),
  refundDue: procedure('read')
    .input(calculateRefundInput)
    .query(({ ctx, input }) => calculateRefund(backofficeDb(), ctx.engine, input)),
  refund: procedure('payments.write')
    .input(recordRefundInput)
    .mutation(({ ctx, input }) => recordRefund(backofficeDb(), ctx.engine, input)),
  reverse: procedure('payments.write')
    .input(reversePaymentInput)
    .mutation(({ ctx, input }) => reversePayment(backofficeDb(), ctx.engine, input)),
});
