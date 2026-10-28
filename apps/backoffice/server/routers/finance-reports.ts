import {
  accountantExportInput,
  financeReportInput,
  getAccountantExport,
  getFinanceReport,
  listAccountMappings,
  requestAccountantExport,
  requestAccountantExportInput,
  requestFinanceReport,
  requestFinanceReportInput,
  saveAccountMapping,
  saveAccountMappingInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

/**
 * Invoicing F5: finance reports (anyone who can see invoices, like statements), and the
 * accountant's exports and account codes (finance).
 */
export const financeReportsRouter = router({
  report: procedure('read')
    .input(financeReportInput)
    .query(({ ctx, input }) => getFinanceReport(backofficeDb(), ctx.engine, input)),
  requestReport: procedure('read')
    .input(requestFinanceReportInput)
    .mutation(({ ctx, input }) => requestFinanceReport(backofficeDb(), ctx.engine, input)),
  exportPreview: procedure('finance')
    .input(accountantExportInput)
    .query(({ ctx, input }) => getAccountantExport(backofficeDb(), ctx.engine, input)),
  requestExport: procedure('finance')
    .input(requestAccountantExportInput)
    .mutation(({ ctx, input }) => requestAccountantExport(backofficeDb(), ctx.engine, input)),
  accountCodes: procedure('finance').query(({ ctx }) =>
    listAccountMappings(backofficeDb(), ctx.engine),
  ),
  saveAccountCode: procedure('finance')
    .input(saveAccountMappingInput)
    .mutation(({ ctx, input }) => saveAccountMapping(backofficeDb(), ctx.engine, input)),
});
