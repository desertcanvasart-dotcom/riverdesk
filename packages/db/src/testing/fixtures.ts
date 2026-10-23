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
  port: inventoryWorld,
  vessel: inventoryWorld,
  cabin_category: inventoryWorld,
  cabin: inventoryWorld,
  cabin_period: inventoryWorld,
  schedule_template: inventoryWorld,
  schedule_template_stop: inventoryWorld,
  sailing_pattern: inventoryWorld,
  leg: inventoryWorld,
  sailing: inventoryWorld,
  sailing_leg: inventoryWorld,
  schedule_exception: inventoryWorld,
  cabin_block: inventoryWorld,
  inventory_bucket: inventoryWorld,
  inventory_event: inventoryWorld,
  event: inventoryWorld,
  idempotency_key: async (db, operatorId) => {
    await db.query(
      `insert into vs.idempotency_key (operator_id, scope_id, key, request_hash)
       values ($1, $2, $3, 'fixture')`,
      [operatorId, randomUUID(), `fixture-${randomUUID()}`],
    );
  },
};

const worlds = new Map<string, Promise<void>>();

/**
 * One consistent row in every Batch 1 table for an operator (vessel → cabin → template → leg →
 * sailing → buckets → events), created once and shared by all those tables' fixtures. Counters
 * satisfy the invariants: 1 cabin = pool 0 + block 1.
 */
export function inventoryWorld(db: pg.Pool, operatorId: string): Promise<void> {
  const existing = worlds.get(operatorId);
  if (existing) return existing;
  const created = (async () => {
    const one = async (text: string, params: unknown[]) =>
      (await db.query<{ id: string }>(text, params)).rows[0]!.id;
    const o = operatorId;
    const portA = await one(
      `insert into vs.port (operator_id, code, name_en, name_ar) values ($1, 'FXA', 'Fixture A', 'أ') returning id`,
      [o],
    );
    const portB = await one(
      `insert into vs.port (operator_id, code, name_en, name_ar) values ($1, 'FXB', 'Fixture B', 'ب') returning id`,
      [o],
    );
    const vessel = await one(
      `insert into vs.vessel (operator_id, code, name, type, max_guests) values ($1, 'FIX', 'Fixture', 'dahabiya', 20) returning id`,
      [o],
    );
    const category = await one(
      `insert into vs.cabin_category (operator_id, vessel_id, code, name_en, name_ar, max_adults, max_occupancy)
       values ($1, $2, 'STD', 'Standard', 'قياسي', 2, 3) returning id`,
      [o, vessel],
    );
    const cabin = await one(
      `insert into vs.cabin (operator_id, vessel_id, number) values ($1, $2, '101') returning id`,
      [o, vessel],
    );
    await db.query(
      `insert into vs.cabin_period (operator_id, vessel_id, cabin_id, category_id, during)
       values ($1, $2, $3, $4, daterange('2026-01-01', null))`,
      [o, vessel, cabin, category],
    );
    const template = await one(
      `insert into vs.schedule_template (operator_id, vessel_id, name, cycle_days, valid_from)
       values ($1, $2, 'Fixture week', 7, '2027-01-04') returning id`,
      [o, vessel],
    );
    await db.query(
      `insert into vs.schedule_template_stop (operator_id, template_id, seq, port_id, day_offset, embark_allowed, disembark_allowed)
       values ($1, $2, 0, $3, 0, true, true), ($1, $2, 1, $4, 3, true, true), ($1, $2, 2, $3, 7, true, true)`,
      [o, template, portA, portB],
    );
    const pattern = await one(
      `insert into vs.sailing_pattern (operator_id, vessel_id, template_id, code, name_en, name_ar, embark_stop_seq, disembark_stop_seq, nights)
       values ($1, $2, $3, 'F3', '3 nights', '٣ ليال', 0, 1, 3) returning id`,
      [o, vessel, template],
    );
    const leg = await one(
      `insert into vs.leg (operator_id, vessel_id, template_id, cycle_start, from_stop_seq, to_stop_seq, from_port_id, to_port_id, depart_date, arrive_date)
       values ($1, $2, $3, '2027-01-04', 0, 1, $4, $5, '2027-01-04', '2027-01-07') returning id`,
      [o, vessel, template, portA, portB],
    );
    const sailing = await one(
      `insert into vs.sailing (operator_id, vessel_id, pattern_id, embark_port_id, disembark_port_id, embark_date, disembark_date, nights)
       values ($1, $2, $3, $4, $5, '2027-01-04', '2027-01-07', 3) returning id`,
      [o, vessel, pattern, portA, portB],
    );
    await db.query(
      `insert into vs.sailing_leg (operator_id, sailing_id, leg_id, seq) values ($1, $2, $3, 0)`,
      [o, sailing, leg],
    );
    await db.query(
      `insert into vs.schedule_exception (operator_id, vessel_id, kind, date_from, date_to, reason)
       values ($1, $2, 'cancel', '2027-02-01', '2027-02-01', 'fixture')`,
      [o, vessel],
    );
    const block = await one(
      `insert into vs.cabin_block (operator_id, vessel_id, category_id, kind, count, reason)
       values ($1, $2, $3, 'normal', 1, 'fixture') returning id`,
      [o, vessel, category],
    );
    await db.query(
      `insert into vs.inventory_bucket (operator_id, vessel_id, leg_id, category_id, kind, total)
       values ($1, $2, $3, $4, 'pool', 0)`,
      [o, vessel, leg, category],
    );
    const blockBucket = await one(
      `insert into vs.inventory_bucket (operator_id, vessel_id, leg_id, category_id, kind, block_id, total)
       values ($1, $2, $3, $4, 'block', $5, 1) returning id`,
      [o, vessel, leg, category, block],
    );
    await db.query(
      `insert into vs.inventory_event (operator_id, bucket_id, leg_id, category_id, delta_total, cause, actor_type, actor_label)
       values ($1, $2, $3, $4, 1, 'fixture', 'system', 'fixture')`,
      [o, blockBucket, leg, category],
    );
    await db.query(
      `insert into vs.event (operator_id, type, resource, resource_id, resource_version)
       values ($1, 'sailing.changed', 'sailing', $2, 1)`,
      [o, sailing],
    );
  })();
  worlds.set(operatorId, created);
  return created;
}

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
