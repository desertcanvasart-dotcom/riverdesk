import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkTenantIsolation,
  createOperator,
  discoverTenantTables,
  findUnscopedTables,
  seedFixtures,
  TENANT_FIXTURES,
} from '../src/testing/index';

// Spec acceptance test 10: under the back-office, API and worker roles, operator A cannot read or
// write operator B's rows in any table. Tables are discovered from the catalogue, so every table a
// later batch adds is covered automatically (and fails here until it has a fixture).
describe('cross-tenant isolation (test 10)', () => {
  let operatorA: string;
  let operatorB: string;

  beforeAll(async () => {
    operatorA = await createOperator('Operator A');
    operatorB = await createOperator('Operator B');
    const tables = (await discoverTenantTables()).map((table) => table.name);
    await seedFixtures(operatorA, tables);
    await seedFixtures(operatorB, tables);
  });

  it('discovers the Batch 0 tenant tables', async () => {
    const names = (await discoverTenantTables()).map((table) => table.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'operator',
        'operator_setting',
        'staff_user',
        'audit_log',
        'exception',
        'idempotency_key',
      ]),
    );
  });

  it('has a fixture for every tenant table', async () => {
    const missing = (await discoverTenantTables())
      .map((t) => t.name)
      .filter((name) => !TENANT_FIXTURES[name]);
    expect(missing).toEqual([]);
  });

  it('has no table without a tenant column', async () => {
    expect(await findUnscopedTables()).toEqual([]);
  });

  it('isolates every tenant table under every runtime role', async () => {
    const failures = await checkTenantIsolation({ operatorA, operatorB });
    expect(failures).toEqual([]);
  });
});
