import { run, type Runner, type TaskList } from 'graphile-worker';
import { openDatabase, openJobQueuePool, type VsDatabase } from '@vs/engine';
import { createLogger, loadConfig, type Config, type Logger } from '@vs/shared';
import { closeRenderer } from './documents/render';
import { analyticsSnapshotTask } from './tasks/analytics-jobs';
import {
  assignCabinsTask,
  completeBookingsTask,
  erasePassportsTask,
  healthAlertsTask,
  overdueBalancesTask,
  expireHoldsTask,
  expireRequestsTask,
  releaseAllotmentsTask,
} from './tasks/booking-jobs';
import {
  checkinPacksTask,
  outagePackTask,
  pruneDocumentsTask,
  renderDocumentTask,
} from './tasks/document-jobs';
import { nightlyInvariants } from './tasks/nightly-invariants';
import { pruneRateLimitsTask, webhooksTask } from './tasks/webhook-jobs';

/**
 * One crontab line. Each job has its own queue, so two runs of it never overlap (a slow run makes
 * the next tick wait, also across a deploy's old and new workers), and its own job key, so at most
 * one more run waits. `fill` catches up a tick missed while the worker was down (a deploy at
 * night); `max` retries only jobs that are safe to run twice.
 */
const cron = (schedule: string, task: string, options: { max?: number; fill?: string } = {}) =>
  `${schedule} ${task} ?max=${options.max ?? 1}&queue=${task}&jobKey=${task}` +
  (options.fill ? `&fill=${options.fill}` : '');

/**
 * Cron schedule (Graphile Worker crontab, evaluated in UTC). 00:00 UTC is 02:00 or 03:00 in
 * Cairo depending on DST. Jobs tied to a Cairo date compute it in Postgres, never from this time.
 */
export const CRONTAB = [
  cron('* * * * *', 'expire_holds'),
  cron('*/5 * * * *', 'expire_requests'),
  // Release dates are Cairo dates compared in Postgres, so every 15 minutes covers 00:05 Cairo
  // (whatever the DST offset) and any missed run.
  cron('*/15 * * * *', 'release_allotments'),
  cron('7 * * * *', 'complete_bookings', { fill: '1h' }),
  // 05:00 UTC is 07:00–08:00 in Cairo: notices go out at the start of the working day. It sends
  // notices and cancels, so it is never retried; a missed run is caught up the same morning.
  cron('0 5 * * *', 'overdue_balances', { fill: '6h' }),
  cron('* * * * *', 'webhooks'),
  cron('23 * * * *', 'prune_rate_limits', { fill: '1h' }),
  cron('0 0 * * *', 'nightly_invariants', { fill: '12h' }),
  // 01:00 UTC is 03:00–04:00 in Cairo: cabins are assigned before the working day.
  cron('0 1 * * *', 'assign_cabins', { max: 3, fill: '6h' }),
  cron('30 1 * * *', 'erase_passports', { max: 3, fill: '12h' }),
  cron('41 * * * *', 'prune_documents', { fill: '1h' }),
  cron('*/5 * * * *', 'health_alerts'),
  // 02:00 UTC is 04:00–05:00 in Cairo: the pack is in the inbox before the office opens. It
  // emails the vessels, so it is never retried.
  cron('0 2 * * *', 'outage_pack', { fill: '3h' }),
  // The check-in pack: departures entering their vessel's window, and button presses (within a minute).
  cron('* * * * *', 'checkin_packs'),
  // 21:45 UTC is 23:45 in Cairo, or 00:45 on summer time; the snapshot counts it as the same night,
  // and so does a run caught up within the hour (a night ends at 02:00 Cairo).
  cron('45 21 * * *', 'analytics_snapshot', { max: 3, fill: '1h' }),
].join('\n');

export function buildTaskList(
  db: VsDatabase,
  logger: Logger,
  config: Config = loadConfig(),
): TaskList {
  return {
    expire_holds: expireHoldsTask(db, logger),
    expire_requests: expireRequestsTask(db, logger),
    release_allotments: releaseAllotmentsTask(db, logger),
    complete_bookings: completeBookingsTask(db, logger),
    overdue_balances: overdueBalancesTask(db, logger),
    webhooks: webhooksTask(db, logger),
    prune_rate_limits: pruneRateLimitsTask(db, logger),
    nightly_invariants: nightlyInvariants(db, logger),
    assign_cabins: assignCabinsTask(db, logger),
    erase_passports: erasePassportsTask(db, logger),
    prune_documents: pruneDocumentsTask(db, logger),
    health_alerts: healthAlertsTask(db, logger),
    outage_pack: outagePackTask(db, logger, config),
    checkin_packs: checkinPacksTask(db, logger, config),
    analytics_snapshot: analyticsSnapshotTask(db, logger),
    render_document: renderDocumentTask(db, logger),
  };
}

export interface WorkerHandle {
  runner: Runner;
  db: VsDatabase;
  stop(): Promise<void>;
}

/**
 * Starts the worker. Graphile Worker gets its own connection (session mode, as vs_worker, no
 * custom type parsers); tasks use the engine's pool, also as vs_worker.
 */
export async function startWorker(
  config: Config,
  options: { logger?: Logger } = {},
): Promise<WorkerHandle> {
  const logger = options.logger ?? createLogger('worker', { level: config.LOG_LEVEL });
  const db = openDatabase('vs_worker', { config, logger, session: true });
  const pgPool = openJobQueuePool({ config });
  const runner = await run({
    pgPool,
    concurrency: 2,
    noHandleSignals: true,
    pollInterval: 2_000,
    taskList: buildTaskList(db, logger, config),
    crontab: CRONTAB,
  });
  logger.info('worker started');
  return {
    runner,
    db,
    async stop() {
      await runner.stop();
      await closeRenderer();
      await db.close();
      await pgPool.end();
    },
  };
}
