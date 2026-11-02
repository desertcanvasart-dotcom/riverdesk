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
 * Invoicing F4: statements and the aging of open invoices (owner, manager and finance), and an
 * agency's credit exposure, which the booking page shows whoever just booked over a warn-mode
 * credit limit.
 */
export const receivablesRouter = router({
  statement: procedure('reports.money')
    .input(statementInput)
    .query(({ ctx, input }) => getStatement(backofficeDb(), ctx.engine, input)),
  requestStatement: procedure('reports.money')
    .input(requestStatementInput)
    .mutation(({ ctx, input }) => requestStatementDocument(backofficeDb(), ctx.engine, input)),
  aging: procedure('reports.money')
    .input(agingInput)
    .query(({ ctx, input }) => getAging(backofficeDb(), ctx.engine, input)),
  requestAging: procedure('reports.money')
    .input(requestAgingInput)
    .mutation(({ ctx, input }) => requestAgingDocument(backofficeDb(), ctx.engine, input)),
  creditExposure: procedure('read')
    .input(z.object({ channelId: z.uuid() }))
    .query(({ ctx, input }) => getCreditExposure(backofficeDb(), ctx.engine, input)),
});
