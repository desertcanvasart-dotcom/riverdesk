import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { quickAddJob, runOnce } from 'graphile-worker';
import { createOperator, owner, testConfig } from '@vs/db/testing';
import { openDatabase, type VsDatabase } from '@vs/engine';
import { connectionString, createLogger, roleConnection } from '@vs/shared';
import { buildTaskList, startWorker } from '../src/worker';

const logger = createLogger('worker-test', { level: 'silent' });

describe('worker', () => {
  const config = testConfig();
  const workerUrl = connectionString(roleConnection(config, 'vs_worker', { session: true }));
  let db: VsDatabase;

  beforeAll(async () => {
    db = openDatabase('vs_worker', { config, max: 2 });
    await createOperator('Worker operator');
  });

  afterAll(async () => {
    await db.close();
  });

  it('boots as vs_worker and registers the nightly_invariants cron job', async () => {
    const worker = await startWorker(config, { logger });
    try {
      // The scheduler records known cron entries shortly after start.
      await vi.waitFor(
        async () => {
          const { rows } = await owner().query<{ identifier: string }>(
            `select identifier from graphile_worker._private_known_crontabs order by identifier`,
          );
          expect(rows.map((r) => r.identifier)).toEqual(
            expect.arrayContaining([
              'complete_bookings',
              'expire_holds',
              'expire_requests',
              'nightly_invariants',
              'overdue_balances',
              'release_allotments',
              'webhooks',
              'prune_rate_limits',
              'health_alerts',
              'checkin_packs',
              'analytics_snapshot',
            ]),
          );
        },
        { timeout: 10_000, interval: 200 },
      );
    } finally {
      await worker.stop();
    }
  });

  it.each([
    'nightly_invariants',
    'expire_holds',
    'expire_requests',
    'release_allotments',
    'complete_bookings',
    'overdue_balances',
    'webhooks',
    'prune_rate_limits',
    'health_alerts',
    'checkin_packs',
    'analytics_snapshot',
  ])('runs %s for every operator through the job queue', async (task) => {
    const job = await quickAddJob(
      { connectionString: workerUrl },
      task,
      {},
      { jobKey: `test-${task}-${Date.now()}` },
    );
    await runOnce({ connectionString: workerUrl, taskList: buildTaskList(db, logger) });
    const { rows } = await owner().query(
      `select last_error from graphile_worker._private_jobs where id = $1`,
      [job.id],
    );
    expect(rows).toHaveLength(0); // completed jobs are deleted; a failed one stays with last_error
  });
});
