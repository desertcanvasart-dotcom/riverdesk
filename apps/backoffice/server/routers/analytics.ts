import {
  analyticsExportInput,
  analyticsFilterInput,
  analyticsOverview,
  behaviourReport,
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
  /** An Excel file of one tab; money columns follow the person's role, decided here. */
  export: procedure('analytics.view')
    .input(analyticsExportInput)
    .mutation(({ ctx, input }) =>
      requestAnalyticsExport(backofficeDb(), ctx.engine, input, {
        withMoney: can(ctx.staff.role, 'analytics.money'),
      }),
    ),
});
