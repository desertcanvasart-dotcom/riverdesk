import {
  agingInput,
  getAging,
  getCreditExposure,
  getStatement,
  requestAgingDocument,
  requestAgingInput,
  requestStatementDocument,
  requestStatementInput,
  statementInput,
} from '@vs/engine';
import { z } from 'zod';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

/**
 * Invoicing F4: statements, the aging of open invoices and agencies' credit exposure. Reading
 * them changes nothing, so anyone who can see invoices may, like printing an invoice.
 */
export const receivablesRouter = router({
  statement: procedure('read')
    .input(statementInput)
    .query(({ ctx, input }) => getStatement(backofficeDb(), ctx.engine, input)),
  requestStatement: procedure('read')
    .input(requestStatementInput)
    .mutation(({ ctx, input }) => requestStatementDocument(backofficeDb(), ctx.engine, input)),
  aging: procedure('read')
    .input(agingInput)
    .query(({ ctx, input }) => getAging(backofficeDb(), ctx.engine, input)),
  requestAging: procedure('read')
    .input(requestAgingInput)
    .mutation(({ ctx, input }) => requestAgingDocument(backofficeDb(), ctx.engine, input)),
  creditExposure: procedure('read')
    .input(z.object({ channelId: z.uuid() }))
    .query(({ ctx, input }) => getCreditExposure(backofficeDb(), ctx.engine, input)),
});
