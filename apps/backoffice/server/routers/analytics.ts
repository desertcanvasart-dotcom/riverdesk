import {
  analyticsExportInput,
  analyticsFilterInput,
  analyticsOverview,
  behaviourReport,
  cashReport,
  cashReportInput,
  revenueReport,
  revenueReportInput,
  channelsReport,
  requestAnalyticsExport,
  analyticsOverviewInput,
  occupancyReport,
  occupancyReportInput,
  sailingPace,
  sailingPaceInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { can } from '../permissions';
import { TRPCError } from '@trpc/server';
import { procedure, router } from '../trpc';

/** Analytics A1.2: read-only. Money figures only for roles that see money (owner, finance). */
export const analyticsRouter = router({
  overview: procedure('analytics.view')
    .input(analyticsOverviewInput)
    .query(({ ctx, input }) =>
      analyticsOverview(backofficeDb(), ctx.engine, input, {
        withMoney: can(ctx.staff.role, 'analytics.money'),
      }),
    ),
  occupancy: procedure('analytics.view')
    .input(occupancyReportInput)
    .query(({ ctx, input }) =>
      occupancyReport(backofficeDb(), ctx.engine, input, {
        withMoney: can(ctx.staff.role, 'analytics.money'),
      }),
    ),
  pace: procedure('analytics.view')
    .input(sailingPaceInput)
    .query(({ ctx, input }) => sailingPace(backofficeDb(), ctx.engine, input)),
  channels: procedure('analytics.view')
    .input(analyticsFilterInput)
    .query(({ ctx, input }) =>
      channelsReport(backofficeDb(), ctx.engine, input, {
        withMoney: can(ctx.staff.role, 'analytics.money'),
      }),
    ),
  behaviour: procedure('analytics.view')
    .input(analyticsFilterInput)
    .query(({ ctx, input }) =>
      behaviourReport(backofficeDb(), ctx.engine, input, {
        withMoney: can(ctx.staff.role, 'analytics.money'),
      }),
    ),
  /** A2.1: cash in, forecast and money held — money only. */
  cash: procedure('analytics.money')
    .input(cashReportInput)
    .query(({ ctx, input }) => cashReport(backofficeDb(), ctx.engine, input)),
  /** A2.2: revenue, leakage, currency exposure and the base-currency view — money only. */
  revenue: procedure('analytics.money')
    .input(revenueReportInput)
    .query(({ ctx, input }) => revenueReport(backofficeDb(), ctx.engine, input)),
  /** An Excel file of one tab; money columns follow the person's role, decided here. */
  export: procedure('analytics.view')
    .input(analyticsExportInput)
    .mutation(({ ctx, input }) => {
      const withMoney = can(ctx.staff.role, 'analytics.money');
      // The money tabs are money from end to end.
      if ((input.report === 'cash' || input.report === 'revenue') && !withMoney)
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Needs analytics.money' });
      return requestAnalyticsExport(backofficeDb(), ctx.engine, input, { withMoney });
    }),
});
