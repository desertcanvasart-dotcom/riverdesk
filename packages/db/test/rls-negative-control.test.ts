import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkTenantIsolation, createOperator, owner, type Fixture } from '../src/testing/index';

// Negative control: the harness must notice when RLS is off. A throwaway tenant table is
// isolated first, then RLS is disabled and the harness has to report it.
describe('harness negative control', () => {
  const table = { name: 'zz_rls_probe', tenantColumn: 'operator_id', hasId: true };
  const fixture: Fixture = async (db, operatorId) => {
    await db.query('insert into vs.zz_rls_probe (operator_id, note) values ($1, $2)', [
      operatorId,
      'probe',
    ]);
  };
  let operatorA: string;
  let operatorB: string;

  beforeAll(async () => {
    await owner().query(`
      create table vs.zz_rls_probe (
        id uuid primary key default vs.uuid_v7(),
        operator_id uuid not null references vs.operator (id),
        note text not null
      );
      alter table vs.zz_rls_probe enable row level security;
      create policy tenant_isolation on vs.zz_rls_probe for all to vs_backoffice, vs_api, vs_worker
        using (operator_id = vs.current_operator_id()) with check (operator_id = vs.current_operator_id());
    `);
    operatorA = await createOperator('Probe A');
    operatorB = await createOperator('Probe B');
    await fixture(owner(), operatorA);
    await fixture(owner(), operatorB);
  });

  afterAll(async () => {
    await owner().query('drop table if exists vs.zz_rls_probe');
  });

  it('passes while RLS is enabled (grants come from default privileges)', async () => {
    const failures = await checkTenantIsolation({
      operatorA,
      operatorB,
      tables: [table],
      fixtures: { zz_rls_probe: fixture },
    });
    expect(failures).toEqual([]);
  });

  it('fails when RLS is disabled', async () => {
    await owner().query('alter table vs.zz_rls_probe disable row level security');
    const failures = await checkTenantIsolation({
      operatorA,
      operatorB,
      tables: [table],
      fixtures: { zz_rls_probe: fixture },
    });
    expect(failures).toContain('zz_rls_probe: RLS is disabled');
    for (const role of ['vs_backoffice', 'vs_api', 'vs_worker']) {
      expect(failures).toContain(`${role} on zz_rls_probe: read 1 row(s) of another operator`);
      expect(failures).toContain(`${role} on zz_rls_probe: updated 1 row(s) of another operator`);
    }
  });
});
