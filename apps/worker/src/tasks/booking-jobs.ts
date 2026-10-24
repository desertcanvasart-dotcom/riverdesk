import type { Task } from 'graphile-worker';
import {
  assignDueCabins,
  completeBookings,
  erasePassports,
  healthAlerts,
  expireHolds,
  expireRequests,
  listOperatorIds,
  processOverdueBalances,
  releaseDueAllotments,
  type EngineContext,
  type VsDatabase,
} from '@vs/engine';
import { captureAlert, captureError, systemActor, type Logger } from '@vs/shared';

/** Runs `fn` for every operator, each in its own tenant transaction(s); one failure does not stop the rest. */
export async function forEachOperator(
  db: VsDatabase,
  logger: Logger,
  job: string,
  fn: (ctx: EngineContext) => Promise<Record<string, number>>,
) {
  const totals: Record<string, number> = {};
  let failures = 0;
  for (const operatorId of await listOperatorIds(db)) {
    try {
      const result = await fn({ operatorId, actor: systemActor(job) });
      for (const [key, value] of Object.entries(result)) totals[key] = (totals[key] ?? 0) + value;
    } catch (error) {
      failures += 1;
      logger.error({ err: error, operatorId, job }, 'job failed for operator');
      captureError(error, { operatorId, job });
    }
  }
  if (failures > 0) throw new Error(`${job} failed for ${failures} operator(s)`);
  if (Object.values(totals).some((n) => n > 0)) logger.info({ job, ...totals }, 'job finished');
}

/** Every minute: expire holds in batches of 500 until none are due. */
export function expireHoldsTask(db: VsDatabase, logger: Logger): Task {
  return () =>
    forEachOperator(db, logger, 'expire_holds', async (ctx) => {
      let total = 0;
      for (;;) {
        const { expired } = await expireHolds(db, ctx, { limit: 500 });
        total += expired;
        if (expired < 500) return { expired: total };
      }
    });
}

export function expireRequestsTask(db: VsDatabase, logger: Logger): Task {
  return () => forEachOperator(db, logger, 'expire_requests', (ctx) => expireRequests(db, ctx));
}

export function releaseAllotmentsTask(db: VsDatabase, logger: Logger): Task {
  return () =>
    forEachOperator(db, logger, 'release_allotments', async (ctx) => {
      let total = 0;
      for (;;) {
        const { released } = await releaseDueAllotments(db, ctx, { limit: 500 });
        total += released;
        if (released < 500) return { released: total };
      }
    });
}

export function completeBookingsTask(db: VsDatabase, logger: Logger): Task {
  return () => forEachOperator(db, logger, 'complete_bookings', (ctx) => completeBookings(db, ctx));
}

/** Daily: overdue prepaid balances get a late_payment exception and a notice; auto-cancel only if the policy says so. */
export function overdueBalancesTask(db: VsDatabase, logger: Logger): Task {
  return () =>
    forEachOperator(db, logger, 'overdue_balances', (ctx) => processOverdueBalances(db, ctx));
}

/** Daily: departures inside the assignment cut-off get their physical cabins. */
export function assignCabinsTask(db: VsDatabase, logger: Logger): Task {
  return () => forEachOperator(db, logger, 'assign_cabins', (ctx) => assignDueCabins(db, ctx));
}

/** Daily: passport numbers and dates of birth go after the retention period. */
export function erasePassportsTask(db: VsDatabase, logger: Logger): Task {
  return () => forEachOperator(db, logger, 'erase_passports', (ctx) => erasePassports(db, ctx));
}

/**
 * Every 5 minutes: each alert condition that holds is logged at error level and sent to error
 * tracking as `alert:<name>` (one issue per alert, so the alert rule fires once and repeats count).
 */
export function healthAlertsTask(db: VsDatabase, logger: Logger): Task {
  return () =>
    forEachOperator(db, logger, 'health_alerts', async (ctx) => {
      const alerts = await healthAlerts(db, ctx);
      for (const alert of alerts) {
        logger.error(
          { alert: alert.name, operatorId: ctx.operatorId, count: alert.count, ...alert.detail },
          `alert: ${alert.name}`,
        );
        captureAlert(alert.name, {
          operatorId: ctx.operatorId,
          count: alert.count,
          ...alert.detail,
        });
      }
      return { alerts: alerts.length };
    });
}
