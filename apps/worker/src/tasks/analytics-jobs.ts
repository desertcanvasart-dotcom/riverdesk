import type { Task } from 'graphile-worker';
import { backfillAnalytics, takeAnalyticsSnapshot, type VsDatabase } from '@vs/engine';
import type { Logger } from '@vs/shared';
import { forEachOperator } from './booking-jobs';

/**
 * Nightly (analytics A1.1): what is on the books for every upcoming departure and sailing. A
 * company's first run also rebuilds its past nights from booking dates, once.
 */
export function analyticsSnapshotTask(db: VsDatabase, logger: Logger): Task {
  return () =>
    forEachOperator(db, logger, 'analytics_snapshot', async (ctx) => {
      const backfill = await backfillAnalytics(db, ctx);
      const tonight = await takeAnalyticsSnapshot(db, ctx);
      return {
        backfilledNights: backfill.nights,
        legRows: tonight.legRows,
        sailingRows: tonight.sailingRows,
      };
    });
}
