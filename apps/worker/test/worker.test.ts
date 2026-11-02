import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseCrontab, quickAddJob, runOnce } from 'graphile-worker';
import { createOperator, owner, testConfig } from '@vs/db/testing';
import { openDatabase, type VsDatabase } from '@vs/engine';
import { connectionString, createLogger, roleConnection } from '@vs/shared';
import { buildTaskList, CRONTAB, startWorker } from '../src/worker';

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

  it('every cron job runs alone (its own queue and key); only jobs safe to repeat are retried', () => {
    const items = parseCrontab(CRONTAB);
    for (const item of items)
      expect(item.options, item.task).toMatchObject({ queueName: item.task, jobKey: item.task });
    expect(items.filter((i) => (i.options.maxAttempts ?? 1) > 1).map((i) => i.task)).toEqual([
      'assign_cabins',
      'erase_passports',
      'analytics_snapshot',
    ]);
    // What emails or cancels is never retried and never catches up twice in a run.
    for (const task of ['outage_pack', 'overdue_balances', 'checkin_packs', 'webhooks'])
      expect(items.find((i) => i.task === task)!.options.maxAttempts, task).toBe(1);
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
      // Starting the real worker may have scheduled cron runs (catch-ups included); they are not
      // this file's jobs, and left in the queue they can run ahead of the jobs the tests add.
      await owner().query(`delete from graphile_worker._private_jobs where locked_at is null`);
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
    // runOnce stops when it finds nothing runnable; run it again while the job is still queued
    // behind another (a few seconds at most).
    const runAndLook = async () => {
      await runOnce({ connectionString: workerUrl, taskList: buildTaskList(db, logger) });
      const { rows } = await owner().query<{ last_error: string | null }>(
        `select last_error from graphile_worker._private_jobs where id = $1`,
        [job.id],
      );
      return rows;
    };
    let rows = await runAndLook();
    const deadline = Date.now() + 5_000;
    while (rows.length > 0 && !rows[0]!.last_error && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      rows = await runAndLook();
    }
    expect(rows).toHaveLength(0); // completed jobs are deleted; a failed one stays with last_error
  });
});
