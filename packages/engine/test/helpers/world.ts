import { createOperator, owner, testConfig } from '@vs/db/testing';
import { systemActor, type Actor, type BusinessDate } from '@vs/shared';
import {
  cancelBooking,
  confirmHold,
  createDemoPricing,
  createDemoVessel,
  createHold,
  createQuote,
  openDatabase,
  releaseHold,
  type DemoVessel,
  type EngineContext,
  type VsDatabase,
} from '../../src/index';

export interface World {
  db: VsDatabase;
  ctx: EngineContext;
  demo: DemoVessel;
  /** Demo pricing (unless created with pricing: false): nilecrz collects payment; back office is prepaid. */
  channels: { nilecrz: string; backOffice: string };
  ratePlanIds: string[];
  close(): Promise<void>;
}

/** A fresh operator with the demo vessel (and its demo pricing), acting through the back-office role. */
export async function demoWorld(
  options: Parameters<typeof createDemoVessel>[2] & { pricing?: boolean } = {},
  actor: Actor = systemActor('test'),
): Promise<World> {
  const db = openDatabase('vs_backoffice', { config: testConfig(), max: 8 });
  const operatorId = await createOperator('Engine test operator');
  const ctx = { operatorId, actor };
  const demo = await createDemoVessel(db, ctx, options);
  const pricing =
    options.pricing === false ? undefined : await createDemoPricing(db, ctx, demo.vesselId);
  const channels = pricing?.channels ?? { nilecrz: '', backOffice: '' };
  return {
    db,
    ctx,
    demo,
    channels,
    ratePlanIds: pricing?.ratePlanIds ?? [],
    close: () => db.close(),
  };
}

/** The single-leg sailing over a leg: leg A → 4 nights from Luxor, leg B → 3 nights from Aswan. */
export async function sailingOverLeg(legId: string): Promise<string> {
  const { rows } = await owner().query<{ id: string }>(
    `select sl.sailing_id as id from vs.sailing_leg sl
     where sl.sailing_id in (select sailing_id from vs.sailing_leg group by sailing_id having count(*) = 1)
       and sl.leg_id = $1`,
    [legId],
  );
  if (!rows[0]) throw new Error('No single-leg sailing over this leg');
  return rows[0].id;
}

export interface Commitment {
  bookingId?: string;
  holdId: string;
  release(): Promise<void>;
}

/**
 * Real commitments through the engine (nilecrz, which confirms at once): `booked` cabins as one
 * confirmed booking and `held` cabins as one option hold on the single-leg sailing over `legId`.
 * release() cancels or releases them again.
 */
export async function commit(
  world: World,
  legId: string,
  categoryId: string,
  booked: number,
  held = 0,
): Promise<Commitment[]> {
  const sailingId = await sailingOverLeg(legId);
  const made: Commitment[] = [];
  for (const [count, confirm] of [
    [booked, true],
    [held, false],
  ] as const) {
    if (count === 0) continue;
    const quote = await createQuote(world.db, world.ctx, {
      channelId: world.channels.nilecrz,
      sailingId,
      market: 'international',
      cabins: Array.from({ length: count }, () => ({ categoryId, adults: 1 })),
    });
    const hold = await createHold(world.db, world.ctx, {
      channelId: world.channels.nilecrz,
      quoteId: quote.id,
      kind: 'option',
    });
    if (confirm) {
      const booking = await confirmHold(world.db, world.ctx, {
        holdId: hold.holdId,
        guests: [{ cabin: 0, firstName: 'Test', lastName: 'Guest', lead: true }],
      });
      made.push({
        holdId: hold.holdId,
        bookingId: booking.bookingId,
        release: async () => {
          await cancelBooking(world.db, world.ctx, {
            bookingId: booking.bookingId,
            reason: 'test cleanup',
          });
        },
      });
    } else {
      made.push({
        holdId: hold.holdId,
        release: async () => void (await releaseHold(world.db, world.ctx, { holdId: hold.holdId })),
      });
    }
  }
  return made;
}

export async function releaseAll(commitments: Commitment[]) {
  for (const c of commitments) await c.release();
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
