import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { isDomainError } from '@vs/contracts';
import { systemActor } from '@vs/shared';
import { openDatabase, type VsDatabase } from '../src/index';
import { createOperator, owner, testConfig } from '../src/testing/index';

const actor = systemActor('test');

describe('withTenantTx', () => {
  let db: VsDatabase;
  let operatorA: string;
  let operatorB: string;

  beforeAll(async () => {
    db = openDatabase('vs_backoffice', { config: testConfig(), max: 4 });
    operatorA = await createOperator('Tx A');
    operatorB = await createOperator('Tx B');
  });

  afterAll(async () => {
    await db.close();
  });

  async function newException(operatorId: string, summary: string): Promise<string> {
    const { rows } = await owner().query<{ id: string }>(
      `insert into vs.exception (operator_id, kind, summary) values ($1, 'invariant', $2) returning id`,
      [operatorId, summary],
    );
    return rows[0]!.id;
  }

  it('runs as the runtime role with app.operator_id set for the transaction only', async () => {
    const seen = await db.withTenantTx(operatorA, actor, async ({ db: tx }) => {
      const role = await sql<{ role: string; tenant: string }>`
        select current_user as role, current_setting('app.operator_id', true) as tenant`.execute(
        tx,
      );
      const operators = await tx.selectFrom('operator').select('id').execute();
      return { ...role.rows[0], operators: operators.map((row) => row.id) };
    });
    expect(seen).toEqual({ role: 'vs_backoffice', tenant: operatorA, operators: [operatorA] });

    // SET LOCAL: the next transaction on any pooled connection starts with no tenant.
    const after = await db.withLookupTx((tx) => tx.selectFrom('operator').select('id').execute());
    expect(after).toEqual([]);
  });

  it('rolls back everything when the function throws', async () => {
    const summary = `rollback-${Date.now()}`;
    await expect(
      db.withTenantTx(operatorA, actor, async ({ db: tx }) => {
        await tx
          .insertInto('exception')
          .values({ operator_id: operatorA, kind: 'invariant', summary })
          .execute();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rowCount } = await owner().query('select 1 from vs.exception where summary = $1', [
      summary,
    ]);
    expect(rowCount).toBe(0);
  });

  it('cannot write another tenant even through Kysely', async () => {
    await expect(
      db.withTenantTx(operatorA, actor, ({ db: tx }) =>
        tx
          .insertInto('exception')
          .values({ operator_id: operatorB, kind: 'invariant', summary: 'x' })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('retries the whole transaction after a real deadlock between two connections', async () => {
    const x = await newException(operatorA, 'deadlock-x');
    const y = await newException(operatorA, 'deadlock-y');

    // Each transaction locks one row, waits until the other has locked its row, then asks for the
    // other row: a guaranteed deadlock. Postgres aborts one with 40P01; withTenantTx must rerun it.
    let ready = 0;
    let release!: () => void;
    const bothLocked = new Promise<void>((resolve) => (release = resolve));
    const arrive = async () => {
      ready += 1;
      if (ready === 2) release();
      await bothLocked;
    };

    const retries: { attempt: number; code: string }[] = [];
    const runs: Record<string, number[]> = { first: [], second: [] };
    const lockInOrder = (name: 'first' | 'second', a: string, b: string) =>
      db.withTenantTx(
        operatorA,
        actor,
        async ({ db: tx, attempt }) => {
          runs[name]!.push(attempt);
          await tx
            .updateTable('exception')
            .set({ summary: `${name}-a` })
            .where('id', '=', a)
            .execute();
          if (attempt === 0) await arrive();
          await tx
            .updateTable('exception')
            .set({ summary: `${name}-b` })
            .where('id', '=', b)
            .execute();
          return attempt;
        },
        { onRetry: (info) => retries.push(info) },
      );

    const [first, second] = await Promise.all([
      lockInOrder('first', x, y),
      lockInOrder('second', y, x),
    ]);

    expect(retries).toEqual([{ attempt: 1, code: '40P01' }]);
    expect([first, second].sort()).toEqual([0, 1]);
    const winner = first === 1 ? 'first' : 'second';
    const { rows } = await owner().query<{ id: string; summary: string }>(
      'select id, summary from vs.exception where id = any($1) order by id',
      [[x, y]],
    );
    // The retried transaction ran last, so both rows carry its writes.
    expect(new Set(rows.map((row) => row.summary.split('-')[0]))).toEqual(new Set([winner]));
  });

  it('gives up with RETRY_LATER after 3 retries', async () => {
    let attempts = 0;
    const error = await db
      .withTenantTx(operatorA, actor, async () => {
        attempts += 1;
        throw Object.assign(new Error('could not serialize access'), { code: '40001' });
      })
      .catch((caught: unknown) => caught);
    expect(attempts).toBe(4);
    expect(isDomainError(error, 'RETRY_LATER')).toBe(true);
  });

  it('does not retry other errors', async () => {
    let attempts = 0;
    await expect(
      db.withTenantTx(operatorA, actor, async () => {
        attempts += 1;
        throw Object.assign(new Error('unique violation'), { code: '23505' });
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(attempts).toBe(1);
  });

  it('rejects an invalid operator id before touching the database', async () => {
    await expect(db.withTenantTx('not-a-uuid', actor, async () => 1)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
