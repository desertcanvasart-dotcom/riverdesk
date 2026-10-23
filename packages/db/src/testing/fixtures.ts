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
  season: pricingFixture,
  season_period: pricingFixture,
  child_policy: pricingFixture,
  child_policy_band: pricingFixture,
  cancellation_policy: pricingFixture,
  cancellation_rule: pricingFixture,
  amendment_fee_rule: pricingFixture,
  payment_policy: pricingFixture,
  rate_plan: pricingFixture,
  rate: pricingFixture,
  supplement: pricingFixture,
  channel: pricingFixture,
  channel_contract: pricingFixture,
  channel_contract_category: pricingFixture,
  channel_contract_rate_plan: pricingFixture,
  quote: pricingFixture,
  allotment: bookingFixture,
  booking: bookingFixture,
  booking_cabin: bookingFixture,
  booking_line: bookingFixture,
  booking_revision: bookingFixture,
  hold: bookingFixture,
  hold_line: bookingFixture,
  offer: bookingFixture,
  guest: bookingFixture,
  payment: bookingFixture,
  idempotency_key: async (db, operatorId) => {
    const channel = await pricingWorld(db, operatorId);
    await db.query(
      `insert into vs.idempotency_key (operator_id, scope_id, key, request_hash)
       values ($1, $2, $3, 'fixture')`,
      [operatorId, channel, `fixture-${randomUUID()}`],
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

const pricingWorlds = new Map<string, Promise<string>>();

/**
 * One row in every Batch 2 table for an operator, on top of inventoryWorld. Resolves to the
 * fixture channel id (idempotency keys are scoped to a channel).
 */
export function pricingWorld(db: pg.Pool, operatorId: string): Promise<string> {
  const existing = pricingWorlds.get(operatorId);
  if (existing) return existing;
  const created = (async () => {
    await inventoryWorld(db, operatorId);
    const one = async (text: string, params: unknown[]) =>
      (await db.query<{ id: string }>(text, params)).rows[0]!.id;
    const o = operatorId;
    const ids = (
      await db.query<{ vessel: string; category: string; sailing: string }>(
        `select v.id as vessel, c.id as category, s.id as sailing
         from vs.vessel v join vs.cabin_category c on c.vessel_id = v.id join vs.sailing s on s.vessel_id = v.id
         where v.operator_id = $1 and v.code = 'FIX' limit 1`,
        [o],
      )
    ).rows[0]!;
    const season = await one(
      `insert into vs.season (operator_id, vessel_id, code, name) values ($1, $2, 'ALL', 'All year') returning id`,
      [o, ids.vessel],
    );
    await db.query(
      `insert into vs.season_period (operator_id, vessel_id, season_id, during) values ($1, $2, $3, daterange('2026-01-01', '2028-12-31'))`,
      [o, ids.vessel, season],
    );
    const child = await one(
      `insert into vs.child_policy (operator_id, name) values ($1, 'Fixture') returning id`,
      [o],
    );
    await db.query(
      `insert into vs.child_policy_band (operator_id, child_policy_id, age_from, age_to, basis) values ($1, $2, 0, 11, 'free')`,
      [o, child],
    );
    const cancel = await one(
      `insert into vs.cancellation_policy (operator_id, name) values ($1, 'Fixture') returning id`,
      [o],
    );
    await db.query(
      `insert into vs.cancellation_rule (operator_id, cancellation_policy_id, from_days, penalty_bps) values ($1, $2, 0, 10000)`,
      [o, cancel],
    );
    await db.query(
      `insert into vs.amendment_fee_rule (operator_id, cancellation_policy_id, change_kind, fee_kind, percent_bps) values ($1, $2, 'any', 'percent', 0)`,
      [o, cancel],
    );
    const payment = await one(
      `insert into vs.payment_policy (operator_id, name) values ($1, 'Fixture') returning id`,
      [o],
    );
    const plan = await one(
      `insert into vs.rate_plan (operator_id, vessel_id, code, name, market, currency, pricing_unit, pricing_period,
                                 child_policy_id, cancellation_policy_id, payment_policy_id)
       values ($1, $2, 'FIX', 'Fixture', 'international', 'USD', 'per_person', 'per_night', $3, $4, $5) returning id`,
      [o, ids.vessel, child, cancel, payment],
    );
    await db.query(
      `insert into vs.rate (operator_id, vessel_id, rate_plan_id, category_id, season_id, basis, amount)
       values ($1, $2, $3, $4, $5, 'double', 10000)`,
      [o, ids.vessel, plan, ids.category, season],
    );
    await db.query(
      `insert into vs.supplement (operator_id, rate_plan_id, code, kind, name_en, name_ar, date_from, date_to, amount_adult, amount_child)
       values ($1, $2, 'GALA', 'gala', 'Gala', 'حفل', '2027-12-31', '2027-12-31', 5000, 2500)`,
      [o, plan],
    );
    const channel = await one(
      `insert into vs.channel (operator_id, code, name, type) values ($1, 'fixture', 'Fixture', 'portal') returning id`,
      [o],
    );
    const contract = await one(
      `insert into vs.channel_contract (operator_id, channel_id, vessel_id, allocation, payment_mode, valid_from)
       values ($1, $2, $3, 'pool', 'channel_collected', '2026-01-01') returning id`,
      [o, channel, ids.vessel],
    );
    await db.query(
      `insert into vs.channel_contract_category (operator_id, contract_id, category_id) values ($1, $2, $3)`,
      [o, contract, ids.category],
    );
    await db.query(
      `insert into vs.channel_contract_rate_plan (operator_id, contract_id, rate_plan_id) values ($1, $2, $3)`,
      [o, contract, plan],
    );
    await db.query(
      `insert into vs.quote (operator_id, channel_id, contract_id, vessel_id, sailing_id, rate_plan_id, season_id, market,
                             currency, cabins, lines, total, net_total, policies, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'international', 'USD', '[]', '[]', 0, 0, '{}', now())`,
      [o, channel, contract, ids.vessel, ids.sailing, plan, season],
    );
    return channel;
  })();
  pricingWorlds.set(operatorId, created);
  return created;
}

async function pricingFixture(db: pg.Pool, operatorId: string): Promise<void> {
  await pricingWorld(db, operatorId);
}

const bookingWorlds = new Map<string, Promise<void>>();

/**
 * One row in every Batch 3 table, on top of pricingWorld. The hold is expired and the booking
 * line released, so the fixture moves no counters and invariant 2 holds.
 */
function bookingWorld(db: pg.Pool, operatorId: string): Promise<void> {
  const existing = bookingWorlds.get(operatorId);
  if (existing) return existing;
  const created = (async () => {
    const channel = await pricingWorld(db, operatorId);
    const one = async (text: string, params: unknown[]) =>
      (await db.query<{ id: string }>(text, params)).rows[0]!.id;
    const o = operatorId;
    const ids = (
      await db.query<{
        vessel: string;
        category: string;
        sailing: string;
        leg: string;
        bucket: string;
        quote: string;
        contract: string;
        plan: string;
      }>(
        `select v.id as vessel, c.id as category, s.id as sailing, l.id as leg, b.id as bucket,
                q.id as quote, q.contract_id as contract, q.rate_plan_id as plan
         from vs.vessel v
         join vs.cabin_category c on c.vessel_id = v.id
         join vs.sailing s on s.vessel_id = v.id
         join vs.leg l on l.vessel_id = v.id
         join vs.inventory_bucket b on b.leg_id = l.id and b.kind = 'pool'
         join vs.quote q on q.sailing_id = s.id
         where v.operator_id = $1 and v.code = 'FIX' limit 1`,
        [o],
      )
    ).rows[0]!;
    await db.query(
      `insert into vs.allotment (operator_id, channel_id, vessel_id, release_days) values ($1, $2, $3, 21)`,
      [o, channel, ids.vessel],
    );
    const booking = await one(
      `insert into vs.booking (operator_id, ref, channel_id, contract_id, vessel_id, sailing_id, quote_id, rate_plan_id,
                               status, revision, market, currency, total, net_total)
       values ($1, 'FX-27-00001', $2, $3, $4, $5, $6, $7, 'cancelled', 1, 'international', 'USD', 0, 0) returning id`,
      [o, channel, ids.contract, ids.vessel, ids.sailing, ids.quote, ids.plan],
    );
    const cabin = await one(
      `insert into vs.booking_cabin (operator_id, booking_id, seq, category_id, adults, status)
       values ($1, $2, 0, $3, 2, 'cancelled') returning id`,
      [o, booking, ids.category],
    );
    await db.query(
      `insert into vs.booking_line (operator_id, booking_id, booking_cabin_id, leg_id, category_id, bucket_id, status, released_at)
       values ($1, $2, $3, $4, $5, $6, 'released', now())`,
      [o, booking, cabin, ids.leg, ids.category, ids.bucket],
    );
    await db.query(
      `insert into vs.booking_revision (operator_id, booking_id, rev, quote_id, sailing_id, currency, total, net_total,
                                        snapshot, reason, actor_type, actor_label)
       values ($1, $2, 1, $3, $4, 'USD', 0, 0, '{}', 'fixture', 'system', 'fixture')`,
      [o, booking, ids.quote, ids.sailing],
    );
    const hold = await one(
      `insert into vs.hold (operator_id, channel_id, contract_id, quote_id, booking_id, kind, status, expires_at, ended_at)
       values ($1, $2, $3, $4, $5, 'offer', 'expired', now(), now()) returning id`,
      [o, channel, ids.contract, ids.quote, booking],
    );
    await db.query(
      `insert into vs.hold_line (operator_id, hold_id, leg_id, category_id, bucket_id, n) values ($1, $2, $3, $4, $5, 1)`,
      [o, hold, ids.leg, ids.category, ids.bucket],
    );
    await db.query(
      `insert into vs.offer (operator_id, booking_id, quote_id, hold_id, status, expires_at)
       values ($1, $2, $3, $4, 'expired', now())`,
      [o, booking, ids.quote, hold],
    );
    await db.query(
      `insert into vs.guest (operator_id, booking_id, booking_cabin_id, first_name, last_name, lead)
       values ($1, $2, $3, 'Fixture', 'Guest', true)`,
      [o, booking, cabin],
    );
    await db.query(
      `insert into vs.payment (operator_id, booking_id, kind, method, amount, currency, booking_amount, reference,
                               received_on, actor_type, actor_label)
       values ($1, $2, 'payment', 'cash', 100, 'USD', 100, 'fixture', '2026-01-01', 'system', 'fixture')`,
      [o, booking],
    );
  })();
  bookingWorlds.set(operatorId, created);
  return created;
}

async function bookingFixture(db: pg.Pool, operatorId: string): Promise<void> {
  await bookingWorld(db, operatorId);
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
