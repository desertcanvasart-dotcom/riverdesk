import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError } from '@vs/contracts';
import { addDays } from '@vs/shared';
import { changeCapacity, generateSchedule } from '../src/index';
import { buckets, demoWorld, legs, simulateCommitment, type World } from './helpers/world';

describe('changeCapacity', () => {
  let world: World;
  let allLegs: Awaited<ReturnType<typeof legs>>;

  beforeAll(async () => {
    world = await demoWorld();
    await generateSchedule(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      until: addDays(world.demo.validFrom, 27),
    });
    allLegs = await legs(world.demo.vesselId);
  });

  afterAll(async () => {
    await world.close();
  });

  const totals = async (categoryId: string) =>
    (await buckets(world.demo.vesselId))
      .filter((b) => b.kind === 'pool' && b.category_id === categoryId)
      .map((b) => b.total);

  it('adds a cabin from a date: only legs departing on or after it change', async () => {
    const from = allLegs[2]!.depart_date; // week 2
    await changeCapacity(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      effectiveFrom: from,
      change: { kind: 'add', number: '113', categoryId: world.demo.categories.STD },
      reason: 'New cabin after refit',
    });
    expect(await totals(world.demo.categories.STD)).toEqual([12, 12, 13, 13, 13, 13, 13, 13]);
  });

  it('recategorises a cabin: one category down, the other up, on the same legs', async () => {
    const cabinId = world.demo.cabins.SUP[0]!;
    const from = allLegs[4]!.depart_date; // week 3
    await changeCapacity(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      effectiveFrom: from,
      change: { kind: 'recategorise', cabinId, categoryId: world.demo.categories.JS },
      reason: 'Upgraded to junior suite',
    });
    expect(await totals(world.demo.categories.SUP)).toEqual([10, 10, 10, 10, 9, 9, 9, 9]);
    expect(await totals(world.demo.categories.JS)).toEqual([6, 6, 6, 6, 7, 7, 7, 7]);
    const periods = await owner().query(
      `select category_id, during from vs.cabin_period where cabin_id = $1 order by lower(during)`,
      [cabinId],
    );
    expect(periods.rows.map((p) => p.category_id)).toEqual([
      world.demo.categories.SUP,
      world.demo.categories.JS,
    ]);
  });

  it('refuses a removal below commitments, lists the conflicts and changes nothing', async () => {
    const rs = world.demo.categories.RS; // 2 royal suites
    await simulateCommitment(allLegs[1]!.id, rs, 2); // both sold on leg B week 1
    await simulateCommitment(allLegs[5]!.id, rs, 1, 1); // both taken on leg B week 3
    const before = await buckets(world.demo.vesselId);
    const error = await changeCapacity(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      effectiveFrom: allLegs[0]!.depart_date,
      change: { kind: 'remove', cabinId: world.demo.cabins.RS[0]! },
      reason: 'Out of service',
    }).catch((e: unknown) => e);
    expect(isDomainError(error, 'CAPACITY_CONFLICT')).toBe(true);
    const conflicts = (error as { details: { conflicts: { legId: string; free: number }[] } })
      .details.conflicts;
    expect(conflicts.map((c) => [c.legId, c.free])).toEqual([
      [allLegs[1]!.id, 0],
      [allLegs[5]!.id, 0],
    ]);
    expect(await buckets(world.demo.vesselId)).toEqual(before);
    await simulateCommitment(allLegs[1]!.id, rs, 0);
    await simulateCommitment(allLegs[5]!.id, rs, 0);
  });

  it('removes a cabin once its legs are free', async () => {
    await changeCapacity(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      effectiveFrom: allLegs[0]!.depart_date,
      change: { kind: 'remove', cabinId: world.demo.cabins.RS[0]! },
      reason: 'Out of service',
    });
    expect(await totals(world.demo.categories.RS)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('new legs generated later use the cabins in service on their date', async () => {
    await generateSchedule(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      until: addDays(world.demo.validFrom, 34),
    });
    const std = await totals(world.demo.categories.STD);
    expect(std.slice(-2)).toEqual([13, 13]);
    expect((await totals(world.demo.categories.RS)).slice(-2)).toEqual([1, 1]);
  });

  it('refuses a date in the past', async () => {
    const error = await changeCapacity(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      effectiveFrom: '2020-01-01',
      change: { kind: 'add', number: '999', categoryId: world.demo.categories.STD },
      reason: 'x',
    }).catch((e: unknown) => e);
    expect(isDomainError(error, 'VALIDATION_FAILED')).toBe(true);
  });
});
