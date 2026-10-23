import { run, type Runner, type TaskList } from 'graphile-worker';
import { openDatabase, type VsDatabase } from '@vs/engine';
import {
  connectionString,
  createLogger,
  roleConnection,
  type Config,
  type Logger,
} from '@vs/shared';
import { nightlyInvariants } from './tasks/nightly-invariants';

/**
 * Cron schedule (Graphile Worker crontab, evaluated in UTC). 00:00 UTC is 02:00 or 03:00 in
 * Cairo depending on DST. Jobs tied to a Cairo date compute it in Postgres, never from this time.
 */
export const CRONTAB = ['0 0 * * * nightly_invariants ?max=1'].join('\n');

export function buildTaskList(db: VsDatabase, logger: Logger): TaskList {
  return { nightly_invariants: nightlyInvariants(db, logger) };
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
    taskList: buildTaskList(db, logger),
    crontab: CRONTAB,
  });
  logger.info('worker started');
  return {
    runner,
    db,
    async stop() {
      await runner.stop();
      await db.close();
    },
  };
}
