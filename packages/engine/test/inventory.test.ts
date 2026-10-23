import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError } from '@vs/contracts';
import { addDays } from '@vs/shared';
import {
  blockCabins,
  emergencyBlock,
  generateSchedule,
  getAvailability,
  releaseBlock,
  setStopSale,
} from '../src/index';
import { buckets, demoWorld, legs, commit, releaseAll, type World } from './helpers/world';

describe('availability, blocks and stop sale', () => {
  let world: World;
  let legA: string;
  let legB: string;
  let std: string;

  beforeAll(async () => {
    world = await demoWorld();
    await generateSchedule(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      until: addDays(world.demo.validFrom, 27),
    });
    const all = await legs(world.demo.vesselId);
    legA = all[0]!.id; // Mon, Luxor → Aswan
    legB = all[1]!.id; // Fri, Aswan → Luxor
    std = world.demo.categories.STD;
  });

  afterAll(async () => {
    await world.close();
  });

  const firstWeek = async () => {
    const availability = await getAvailability(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      from: world.demo.validFrom,
      to: addDays(world.demo.validFrom, 6),
    });
    const free = (pattern: string, code = 'STD') =>
      availability.sailings
        .find((s) => s.patternCode === pattern)!
        .categories.find((c) => c.code === code)!.free;
    return { availability, free };
  };

  it('gives every sailing the minimum free count across its legs', async () => {
    const sold = await commit(world, legB, std, 5);
    const { availability, free } = await firstWeek();
    expect(availability.asOf).toBeInstanceOf(Date);
    expect(free('LXR-4')).toBe(12); // leg A only
    expect(free('ASW-3')).toBe(7); // leg B only
    expect(free('LXR-7')).toBe(7); // min(A 12, B 7)
    expect(free('ASW-7')).toBe(7); // min(B 7, next A 12)
    await releaseAll(sold);
  });

  it('refuses a normal block beyond free, and changes nothing', async () => {
    const sold = await commit(world, legA, std, 10);
    const before = await buckets(world.demo.vesselId);
    const error = await blockCabins(world.db, world.ctx, {
      legIds: [legA, legB],
      categoryId: std,
      count: 3,
      reason: 'Painting',
    }).catch((e: unknown) => e);
    expect(isDomainError(error, 'NOT_AVAILABLE')).toBe(true);
    expect(await buckets(world.demo.vesselId)).toEqual(before);
    const blocks = await owner().query(`select 1 from vs.cabin_block where operator_id = $1`, [
      world.ctx.operatorId,
    ]);
    expect(blocks.rowCount).toBe(0);
    await releaseAll(sold);
  });

  it('blocks from free on every leg, then release restores the counts', async () => {
    const before = await buckets(world.demo.vesselId);
    const block = await blockCabins(world.db, world.ctx, {
      legIds: [legA, legB],
      categoryId: std,
      count: 2,
      reason: 'AC repair',
    });
    let { free } = await firstWeek();
    expect(free('LXR-7')).toBe(10);
    expect(free('LXR-4')).toBe(10);
    const after = await buckets(world.demo.vesselId);
    expect(after.filter((b) => b.kind === 'block').map((b) => [b.leg_id, b.total])).toEqual([
      [legA, 2],
      [legB, 2],
    ]);

    await releaseBlock(world.db, world.ctx, { blockId: block.id });
    ({ free } = await firstWeek());
    expect(free('LXR-7')).toBe(12);
    const restored = await buckets(world.demo.vesselId);
    const counters = (rows: typeof before) =>
      rows.filter((b) => b.kind === 'pool').map((b) => [b.id, b.total, b.held, b.booked]);
    expect(counters(restored)).toEqual(counters(before));
    const again = await releaseBlock(world.db, world.ctx, { blockId: block.id }).catch(
      (e: unknown) => e,
    );
    expect(isDomainError(again, 'INVALID_STATE')).toBe(true);
  });

  it('emergency block may exceed free: exception, overcommit and stop sale until released', async () => {
    const sold = await commit(world, legA, std, 11); // 1 free
    const block = await emergencyBlock(world.db, world.ctx, {
      legIds: [legA],
      categoryId: std,
      count: 3,
      reason: 'Flooded cabins',
    });
    expect(block.exception_id).toBeTruthy();
    const pool = (await buckets(world.demo.vesselId)).find(
      (b) => b.leg_id === legA && b.category_id === std && b.kind === 'pool',
    )!;
    expect(pool).toMatchObject({
      total: 9,
      booked: 11,
      overcommit: 2,
      stop_sale: true,
      stop_reason: 'emergency_block',
    });

    const exception = await owner().query(
      `select kind, status, refs, details from vs.exception where id = $1`,
      [block.exception_id],
    );
    expect(exception.rows[0]).toMatchObject({ kind: 'oversubscription', status: 'open' });
    expect(exception.rows[0].refs).toContainEqual({ entity: 'inventory_bucket', id: pool.id });
    expect(exception.rows[0].details.commitments).toContainEqual(
      expect.objectContaining({ leg_id: legA, booked: 11 }),
    );

    const { free } = await firstWeek();
    expect(free('LXR-4')).toBe(0);
    expect(free('LXR-7')).toBe(0);
    const resume = await setStopSale(world.db, world.ctx, {
      legIds: [legA],
      categoryIds: [std],
      stop: false,
      reason: 'try',
    }).catch((e: unknown) => e);
    expect(isDomainError(resume, 'INVALID_STATE')).toBe(true);

    await releaseBlock(world.db, world.ctx, { blockId: block.id });
    const released = (await buckets(world.demo.vesselId)).find((b) => b.id === pool.id)!;
    expect(released).toMatchObject({
      total: 12,
      overcommit: 0,
      stop_sale: false,
      stop_reason: null,
    });
    const resolved = await owner().query(`select status from vs.exception where id = $1`, [
      block.exception_id,
    ]);
    expect(resolved.rows[0].status).toBe('resolved');
    await releaseAll(sold);
  });

  it('a stop sale gives 0 for every sailing on that leg', async () => {
    await setStopSale(world.db, world.ctx, {
      legIds: [legB],
      categoryIds: [std],
      stop: true,
      reason: 'Hold back for a group',
    });
    let { free } = await firstWeek();
    expect([free('ASW-3'), free('ASW-7'), free('LXR-7'), free('LXR-4')]).toEqual([0, 0, 0, 12]);
    expect(free('ASW-3', 'SUP')).toBe(10); // other categories unaffected
    await setStopSale(world.db, world.ctx, {
      legIds: [legB],
      categoryIds: [std],
      stop: false,
      reason: 'Released',
    });
    ({ free } = await firstWeek());
    expect(free('ASW-3')).toBe(12);
  });

  it('writes inventory events, outbox events and audit rows for each change', async () => {
    const { rows } = await owner().query<{ cause: string }>(
      `select distinct cause from vs.inventory_event where operator_id = $1 order by cause`,
      [world.ctx.operatorId],
    );
    expect(rows.map((r) => r.cause)).toEqual(
      expect.arrayContaining([
        'block.created',
        'block.emergency',
        'block.released',
        'schedule.generated',
      ]),
    );
    const availabilityEvents = await owner().query<{ n: number }>(
      `select count(*)::int as n from vs.event where operator_id = $1 and type = 'availability.changed'`,
      [world.ctx.operatorId],
    );
    expect(availabilityEvents.rows[0]!.n).toBeGreaterThan(0);
    const actions = await owner().query<{ action: string }>(
      `select distinct action from vs.audit_log where operator_id = $1`,
      [world.ctx.operatorId],
    );
    expect(actions.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'cabin_block.created',
        'cabin_block.emergency',
        'cabin_block.released',
        'stop_sale.set',
        'stop_sale.lifted',
      ]),
    );
  });
});
