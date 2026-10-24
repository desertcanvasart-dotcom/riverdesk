import { run, type Runner, type TaskList } from 'graphile-worker';
import { openDatabase, type VsDatabase } from '@vs/engine';
import {
  connectionString,
  createLogger,
  loadConfig,
  roleConnection,
  type Config,
  type Logger,
} from '@vs/shared';
import { closeRenderer } from './documents/render';
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
import { outagePackTask, pruneDocumentsTask, renderDocumentTask } from './tasks/document-jobs';
import { nightlyInvariants } from './tasks/nightly-invariants';
import { pruneRateLimitsTask, webhooksTask } from './tasks/webhook-jobs';

/**
 * Cron schedule (Graphile Worker crontab, evaluated in UTC). 00:00 UTC is 02:00 or 03:00 in
 * Cairo depending on DST. Jobs tied to a Cairo date compute it in Postgres, never from this time.
 */
export const CRONTAB = [
  '* * * * * expire_holds ?max=1',
  '*/5 * * * * expire_requests ?max=1',
  // Release dates are Cairo dates compared in Postgres, so every 15 minutes covers 00:05 Cairo
  // (whatever the DST offset) and any missed run.
  '*/15 * * * * release_allotments ?max=1',
  '7 * * * * complete_bookings ?max=1',
  // 05:00 UTC is 07:00–08:00 in Cairo: notices go out at the start of the working day.
  '0 5 * * * overdue_balances ?max=1',
  '* * * * * webhooks ?max=1',
  '23 * * * * prune_rate_limits ?max=1',
  '0 0 * * * nightly_invariants ?max=1',
  // 01:00 UTC is 03:00–04:00 in Cairo: cabins are assigned before the working day.
  '0 1 * * * assign_cabins ?max=1',
  '30 1 * * * erase_passports ?max=1',
  '41 * * * * prune_documents ?max=1',
  '*/5 * * * * health_alerts ?max=1',
  // 02:00 UTC is 04:00–05:00 in Cairo: the pack is in the inbox before the office opens.
  '0 2 * * * outage_pack ?max=1',
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
  const runner = await run({
    connectionString: connectionString(roleConnection(config, 'vs_worker', { session: true })),
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
    },
  };
}
