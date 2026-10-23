import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner, testConfig } from '@vs/db/testing';
import { addDays, systemActor } from '@vs/shared';
import {
  generateSchedule,
  getAvailability,
  openDatabase,
  runInvariantChecks,
  setStopSale,
  type VsDatabase,
} from '../src/index';
import { buckets, demoWorld, legs, type World } from './helpers/world';

async function violationsFor(operatorId: string) {
  const { rows } = await owner().query<{
    invariant: number;
    entity: string;
    entity_id: string;
    detail: Record<string, unknown>;
  }>(
    `select invariant, entity, entity_id, detail from vs.check_invariants() where operator_id = $1 order by invariant, entity_id`,
    [operatorId],
  );
  return rows;
}

describe('check_invariants() on inventory (invariants 1 and 3)', () => {
  let world: World;
  let worker: VsDatabase;

  beforeAll(async () => {
    world = await demoWorld();
    worker = openDatabase('vs_worker', { config: testConfig(), max: 2 });
    await generateSchedule(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      until: addDays(world.demo.validFrom, 13),
    });
  });

  afterAll(async () => {
    await worker.close();
    await world.close();
  });

  it('is clean after generation', async () => {
    expect(await violationsFor(world.ctx.operatorId)).toEqual([]);
  });

  it('reports each corrupted counter, and the nightly job stops sales on exactly those', async () => {
    const all = await legs(world.demo.vesselId);
    const pools = (await buckets(world.demo.vesselId)).filter((b) => b.kind === 'pool');
    const pool = (legIndex: number, category: keyof typeof world.demo.categories) =>
      pools.find(
        (b) => b.leg_id === all[legIndex]!.id && b.category_id === world.demo.categories[category],
      )!;
    const totalOff = pool(0, 'STD'); // invariant 1: totals no longer match the cabins
    const overHeld = pool(1, 'SUP'); // invariant 3: held + booked > total
    const silentOvercommit = pool(2, 'JS'); // invariant 3: overcommit without stop sale or exception

    await owner().query(`update vs.inventory_bucket set total = total + 1 where id = $1`, [
      totalOff.id,
    ]);
    await owner().query(`update vs.inventory_bucket set held = total + 1 where id = $1`, [
      overHeld.id,
    ]);
    await owner().query(`update vs.inventory_bucket set overcommit = 1 where id = $1`, [
      silentOvercommit.id,
    ]);

    const found = await violationsFor(world.ctx.operatorId);
    expect(found).toHaveLength(3);
    expect(found).toContainEqual({
      invariant: 1,
      entity: 'leg',
      entity_id: all[0]!.id,
      detail: {
        leg_id: all[0]!.id,
        category_id: world.demo.categories.STD,
        bucket_total: 13,
        active_cabins: 12,
      },
    });
    expect(found).toContainEqual(
      expect.objectContaining({ invariant: 3, entity: 'inventory_bucket', entity_id: overHeld.id }),
    );
    expect(found).toContainEqual(
      expect.objectContaining({
        invariant: 3,
        entity: 'inventory_bucket',
        entity_id: silentOvercommit.id,
      }),
    );

    const results = await runInvariantChecks(worker, systemActor('nightly_invariants'));
    expect(results.find((r) => r.operatorId === world.ctx.operatorId)).toEqual({
      operatorId: world.ctx.operatorId,
      violations: 3,
      opened: 3,
    });
    const stopped = (await buckets(world.demo.vesselId)).filter((b) => b.stop_sale);
    expect(stopped.map((b) => b.id).sort()).toEqual(
      [totalOff.id, overHeld.id, silentOvercommit.id].sort(),
    );
    expect(new Set(stopped.map((b) => b.stop_reason))).toEqual(new Set(['invariant']));

    const availability = await getAvailability(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      from: all[0]!.depart_date,
      to: all[0]!.depart_date,
    });
    const lxr4 = availability.sailings.find((s) => s.patternCode === 'LXR-4')!;
    expect(lxr4.categories.find((c) => c.code === 'STD')).toMatchObject({
      free: 0,
      stopSale: true,
    });

    // A second run opens no duplicate exceptions.
    const rerun = await runInvariantChecks(worker, systemActor('nightly_invariants'));
    expect(rerun.find((r) => r.operatorId === world.ctx.operatorId)?.opened).toBe(0);

    // Repair, then lift the stop: clean again.
    await owner().query(`update vs.inventory_bucket set total = total - 1 where id = $1`, [
      totalOff.id,
    ]);
    await owner().query(`update vs.inventory_bucket set held = 0 where id = $1`, [overHeld.id]);
    await owner().query(`update vs.inventory_bucket set overcommit = 0 where id = $1`, [
      silentOvercommit.id,
    ]);
    expect(await violationsFor(world.ctx.operatorId)).toEqual([]);
    await setStopSale(world.db, world.ctx, {
      legIds: stopped.map((b) => b.leg_id),
      stop: false,
      reason: 'Counters repaired',
    });
    expect((await buckets(world.demo.vesselId)).filter((b) => b.stop_sale)).toEqual([]);
  });

  it('accepts overcommit only on a stopped pool bucket with an open oversubscription exception', async () => {
    const [bucket] = (await buckets(world.demo.vesselId)).filter((b) => b.kind === 'pool');
    await owner().query(
      `update vs.inventory_bucket set overcommit = 1, booked = total + 1, stop_sale = true, stop_reason = 'emergency_block' where id = $1`,
      [bucket!.id],
    );
    const { rows } = await owner().query<{ id: string }>(
      `insert into vs.exception (operator_id, kind, summary, refs) values ($1, 'oversubscription', 'test', $2) returning id`,
      [world.ctx.operatorId, JSON.stringify([{ entity: 'inventory_bucket', id: bucket!.id }])],
    );
    expect(await violationsFor(world.ctx.operatorId)).toEqual([]);
    await owner().query(`update vs.exception set status = 'resolved' where id = $1`, [rows[0]!.id]);
    expect((await violationsFor(world.ctx.operatorId)).map((v) => v.entity_id)).toEqual([
      bucket!.id,
    ]);
    await owner().query(
      `update vs.inventory_bucket set overcommit = 0, booked = 0, stop_sale = false, stop_reason = null where id = $1`,
      [bucket!.id],
    );
  });
});
