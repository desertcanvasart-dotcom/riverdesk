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
            `select identifier from graphile_worker._private_known_crontabs where identifier = 'nightly_invariants'`,
          );
          expect(rows).toHaveLength(1);
        },
        { timeout: 10_000, interval: 200 },
      );
    } finally {
      await worker.stop();
    }
  });

  it('runs nightly_invariants for every operator through the job queue', async () => {
    const job = await quickAddJob(
      { connectionString: workerUrl },
      'nightly_invariants',
      {},
      { jobKey: `test-${Date.now()}` },
    );
    await runOnce({ connectionString: workerUrl, taskList: buildTaskList(db, logger) });
    const { rows } = await owner().query(
      `select 1 from graphile_worker._private_jobs where id = $1`,
      [job.id],
    );
    expect(rows).toHaveLength(0); // completed jobs are deleted
  });
});
