import { createOperator, owner, testConfig } from '@vs/db/testing';
import { systemActor, type Actor, type BusinessDate } from '@vs/shared';
import {
  createDemoVessel,
  openDatabase,
  type DemoVessel,
  type EngineContext,
  type VsDatabase,
} from '../../src/index';

export interface World {
  db: VsDatabase;
  ctx: EngineContext;
  demo: DemoVessel;
  close(): Promise<void>;
}

/** A fresh operator with the demo vessel, acting through the back-office role. */
export async function demoWorld(
  options: Parameters<typeof createDemoVessel>[2] = {},
  actor: Actor = systemActor('test'),
): Promise<World> {
  const db = openDatabase('vs_backoffice', { config: testConfig(), max: 4 });
  const operatorId = await createOperator('Engine test operator');
  const ctx = { operatorId, actor };
  const demo = await createDemoVessel(db, ctx, options);
  return { db, ctx, demo, close: () => db.close() };
}

export interface BucketRow {
  id: string;
  leg_id: string;
  category_id: string;
  kind: string;
  total: number;
  held: number;
  booked: number;
  overcommit: number;
  stop_sale: boolean;
  stop_reason: string | null;
  depart_date: string;
}

/** Owner-side view of buckets for assertions. */
export async function buckets(vesselId: string): Promise<BucketRow[]> {
  const { rows } = await owner().query<BucketRow>(
    `select b.id, b.leg_id, b.category_id, b.kind, b.total, b.held, b.booked, b.overcommit, b.stop_sale,
            b.stop_reason, l.depart_date::text as depart_date
     from vs.inventory_bucket b join vs.leg l on l.id = b.leg_id
     where b.vessel_id = $1
     order by l.depart_date, b.kind, b.category_id`,
    [vesselId],
  );
  return rows;
}

export async function legs(vesselId: string) {
  const { rows } = await owner().query<{
    id: string;
    depart_date: BusinessDate;
    arrive_date: BusinessDate;
    from_port: string;
    to_port: string;
    status: string;
  }>(
    `select l.id, l.depart_date::text, l.arrive_date::text, fp.code as from_port, tp.code as to_port, l.status
     from vs.leg l join vs.port fp on fp.id = l.from_port_id join vs.port tp on tp.id = l.to_port_id
     where l.vessel_id = $1 order by l.depart_date`,
    [vesselId],
  );
  return rows;
}

/**
 * Test-only stand-in for commitments until holds and bookings exist (Batch 3): sets held/booked
 * on a pool bucket directly, as the owner. Values stay within invariant 3.
 */
export async function simulateCommitment(
  legId: string,
  categoryId: string,
  booked: number,
  held = 0,
) {
  await owner().query(
    `update vs.inventory_bucket set booked = $3, held = $4
     where leg_id = $1 and category_id = $2 and kind = 'pool'`,
    [legId, categoryId, booked, held],
  );
}
