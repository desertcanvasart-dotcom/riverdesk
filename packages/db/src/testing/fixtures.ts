import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { uuidv7 } from '@vs/shared';
import { owner } from './env';

/** Creates an operator (and its settings row) directly as the owner. */
export async function createOperator(name = 'Test operator'): Promise<string> {
  const id = uuidv7();
  const slug = `t-${id.slice(-12)}`;
  await owner().query('insert into vs.operator (id, name, slug) values ($1, $2, $3)', [
    id,
    name,
    slug,
  ]);
  await owner().query('insert into vs.operator_setting (operator_id) values ($1)', [id]);
  return id;
}

/**
 * One row per tenant table for a given operator, inserted as the owner. The cross-tenant
 * harness needs a row on both sides of every table; a tenant table with no fixture here fails
 * the harness, so each batch must add fixtures for the tables it creates.
 */
export type Fixture = (db: pg.Pool, operatorId: string) => Promise<void>;

export const TENANT_FIXTURES: Record<string, Fixture> = {
  // The operator row and its settings are created by createOperator().
  operator: async () => {},
  operator_setting: async () => {},
  staff_user: async (db, operatorId) => {
    const authUserId = randomUUID();
    await db.query(
      `insert into vs.staff_user (operator_id, auth_user_id, email, display_name, role)
       values ($1, $2, $3, 'Fixture staff', 'reservations')`,
      [operatorId, authUserId, `fixture-${authUserId.slice(0, 8)}@example.test`],
    );
  },
  audit_log: async (db, operatorId) => {
    await db.query(
      `insert into vs.audit_log (operator_id, actor_type, actor_label, action, entity)
       values ($1, 'system', 'fixture', 'fixture.created', 'fixture')`,
      [operatorId],
    );
  },
  exception: async (db, operatorId) => {
    await db.query(
      `insert into vs.exception (operator_id, kind, summary) values ($1, 'invariant', 'Fixture')`,
      [operatorId],
    );
  },
  idempotency_key: async (db, operatorId) => {
    await db.query(
      `insert into vs.idempotency_key (operator_id, scope_id, key, request_hash)
       values ($1, $2, $3, 'fixture')`,
      [operatorId, randomUUID(), `fixture-${randomUUID()}`],
    );
  },
};

export async function seedFixtures(
  operatorId: string,
  tables: string[],
  fixtures: Record<string, Fixture> = TENANT_FIXTURES,
): Promise<void> {
  for (const table of tables) {
    const fixture = fixtures[table];
    if (fixture) await fixture(owner(), operatorId);
  }
}
