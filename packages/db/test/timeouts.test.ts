import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { isDomainError } from '@vs/contracts';
import { createDatabase, pgErrorCode, roleConnection } from '@vs/shared';
import { openDatabase, WORKER_TX_TIMEOUTS, type DB } from '../src/index';
import { testConfig } from '../src/testing/index';

describe('transaction time limits', () => {
  const config = testConfig();
  const api = openDatabase('vs_api', { config, max: 2 });
  const worker = openDatabase('vs_worker', { config, max: 1 });
  const strict = createDatabase<DB>(
    { ...roleConnection(config, 'vs_api'), max: 2 },
    { schema: 'vs', timeouts: { statementMs: 1_000, lockMs: 200 } },
  );
  const show = (db: typeof api, name: string) =>
    db.withLookupTx(async (tx) => {
      const { rows } = await sql<{
        value: string;
      }>`select current_setting(${name}) as value`.execute(tx);
      return rows[0]!.value;
    });

  afterAll(async () => {
    await Promise.all([api.close(), worker.close(), strict.close()]);
  });

  it('every transaction carries statement, lock and idle limits; the worker gets longer ones', async () => {
    expect(await show(api, 'statement_timeout')).toBe('1min');
    expect(await show(api, 'lock_timeout')).toBe('20s');
    expect(await show(api, 'idle_in_transaction_session_timeout')).toBe('2min');
    expect(WORKER_TX_TIMEOUTS.statementMs).toBe(600_000);
    expect(await show(worker, 'statement_timeout')).toBe('10min');
    expect(await show(worker, 'lock_timeout')).toBe('20s');
    // Per transaction only: the connection itself is left as it was.
    const { rows } = await api.pool.query<{ statement_timeout: string }>('show statement_timeout');
    expect(rows[0]!.statement_timeout).toBe('0');
  });

  it('a statement that runs past its limit is cancelled', async () => {
    const error = await strict
      .withLookupTx((tx) => sql`select pg_sleep(2)`.execute(tx))
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe('57014');
  });

  it('waiting too long for a lock ends in RETRY_LATER, without retrying in a loop', async () => {
    let attempts = 0;
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    let locked!: () => void;
    const taken = new Promise<void>((done) => (locked = done));
    const holder = api.withLookupTx(async (tx) => {
      await sql`select pg_advisory_xact_lock(7214)`.execute(tx);
      locked();
      await held;
    });
    await taken;
    try {
      const error = await strict
        .withLookupTx(async (tx) => {
          attempts += 1;
          await sql`select pg_advisory_xact_lock(7214)`.execute(tx);
        })
        .catch((e: unknown) => e);
      expect(isDomainError(error, 'RETRY_LATER') && error.details).toMatchObject({
        reason: 'lock_timeout',
      });
      expect(attempts).toBe(1);
    } finally {
      release();
      await holder;
    }
  });
});
