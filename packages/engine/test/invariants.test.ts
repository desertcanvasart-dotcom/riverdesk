import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOperator, owner, testConfig } from '@vs/db/testing';
import { systemActor, uuidv7 } from '@vs/shared';
import {
  listOperatorIds,
  openDatabase,
  recordInvariantViolations,
  runInvariantChecks,
  type VsDatabase,
} from '../src/index';

const actor = systemActor('nightly_invariants');

describe('invariant checks', () => {
  let worker: VsDatabase;
  let api: VsDatabase;
  let operatorId: string;

  beforeAll(async () => {
    const config = testConfig();
    worker = openDatabase('vs_worker', { config, max: 2 });
    api = openDatabase('vs_api', { config, max: 1 });
    operatorId = await createOperator('Invariant operator');
  });

  afterAll(async () => {
    await worker.close();
    await api.close();
  });

  it('checks every operator and finds nothing on a clean database', async () => {
    const results = await runInvariantChecks(worker, actor);
    expect(results.map((result) => result.operatorId)).toContain(operatorId);
    expect(results.every((result) => result.violations === 0 && result.opened === 0)).toBe(true);
  });

  it('only the worker can list operators', async () => {
    expect(await listOperatorIds(worker)).toContain(operatorId);
    await expect(listOperatorIds(api)).rejects.toMatchObject({ code: '42501' });
  });

  it('opens one critical exception per violation, without duplicates', async () => {
    const bucketId = uuidv7();
    const violation = {
      operator_id: operatorId,
      invariant: 3,
      entity: 'inventory_bucket',
      entity_id: bucketId,
      detail: { held: -1 },
    };
    const record = () =>
      worker.withTenantTx(operatorId, actor, ({ db: tx }) =>
        recordInvariantViolations(tx, operatorId, actor, [violation]),
      );

    expect(await record()).toBe(1);
    expect(await record()).toBe(0);

    const { rows } = await owner().query(
      `select kind, severity, status, refs from vs.exception where operator_id = $1 and dedupe_key like 'invariant:%'`,
      [operatorId],
    );
    expect(rows).toEqual([
      {
        kind: 'invariant',
        severity: 'critical',
        status: 'open',
        refs: [{ entity: 'inventory_bucket', id: bucketId }],
      },
    ]);
    const audit = await owner().query(
      `select 1 from vs.audit_log where operator_id = $1 and action = 'exception.opened'`,
      [operatorId],
    );
    expect(audit.rowCount).toBe(1);
  });
});
