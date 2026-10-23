import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { addDays, daysBetween } from '@vs/shared';
import { generateSchedule, todayInCairo } from '../src/index';
import { buckets, demoWorld, legs, commit, releaseAll, type World } from './helpers/world';

describe('generateSchedule', () => {
  let world: World;

  beforeAll(async () => {
    world = await demoWorld();
  });

  afterAll(async () => {
    await world.close();
  });

  it('creates legs A and B every week up to 18 months, with pool buckets equal to active cabins', async () => {
    const result = await generateSchedule(world.db, world.ctx, { vesselId: world.demo.vesselId });
    const today = await todayInCairo(world.db);
    expect(daysBetween(today, result.until)).toBeGreaterThanOrEqual(545); // 18 months
    expect(daysBetween(today, result.until)).toBeLessThanOrEqual(553);

    const all = await legs(world.demo.vesselId);
    expect(result.legsCreated).toBe(all.length);
    expect(all[0]).toMatchObject({
      from_port: 'LXR',
      to_port: 'ASW',
      depart_date: world.demo.validFrom,
      arrive_date: addDays(world.demo.validFrom, 4),
    });
    expect(all[1]).toMatchObject({
      from_port: 'ASW',
      to_port: 'LXR',
      depart_date: addDays(world.demo.validFrom, 4),
      arrive_date: addDays(world.demo.validFrom, 7),
    });
    // Legs are contiguous: each one starts where and when the previous ended.
    for (let i = 1; i < all.length; i += 1) {
      expect(all[i]!.depart_date).toBe(all[i - 1]!.arrive_date);
      expect(all[i]!.from_port).toBe(all[i - 1]!.to_port);
    }

    const pools = (await buckets(world.demo.vesselId)).filter((bucket) => bucket.kind === 'pool');
    expect(pools).toHaveLength(all.length * 4);
    const byCategory = (id: string) => pools.filter((bucket) => bucket.category_id === id);
    expect(new Set(byCategory(world.demo.categories.STD).map((b) => b.total))).toEqual(
      new Set([12]),
    );
    expect(new Set(byCategory(world.demo.categories.RS).map((b) => b.total))).toEqual(new Set([2]));
    expect(result.bucketsCreated).toBe(pools.length);
  });

  it("creates the four sailing patterns; 7 nights from Aswan spans leg B and the next week's leg A", async () => {
    const { rows } = await owner().query<{
      code: string;
      embark_date: string;
      nights: number;
      legs: string[];
    }>(
      `select sp.code, s.embark_date::text, s.nights,
              array_agg(fp.code || '>' || tp.code || '@' || l.depart_date::text order by sl.seq) as legs
       from vs.sailing s join vs.sailing_pattern sp on sp.id = s.pattern_id
       join vs.sailing_leg sl on sl.sailing_id = s.id join vs.leg l on l.id = sl.leg_id
       join vs.port fp on fp.id = l.from_port_id join vs.port tp on tp.id = l.to_port_id
       where s.vessel_id = $1 and s.embark_date < $2::date + 7
       group by sp.code, s.embark_date, s.nights order by s.embark_date, sp.code`,
      [world.demo.vesselId, world.demo.validFrom],
    );
    const monday = world.demo.validFrom;
    const friday = addDays(monday, 4);
    const nextMonday = addDays(monday, 7);
    expect(rows).toEqual([
      { code: 'LXR-4', embark_date: monday, nights: 4, legs: [`LXR>ASW@${monday}`] },
      {
        code: 'LXR-7',
        embark_date: monday,
        nights: 7,
        legs: [`LXR>ASW@${monday}`, `ASW>LXR@${friday}`],
      },
      { code: 'ASW-3', embark_date: friday, nights: 3, legs: [`ASW>LXR@${friday}`] },
      {
        code: 'ASW-7',
        embark_date: friday,
        nights: 7,
        legs: [`ASW>LXR@${friday}`, `LXR>ASW@${nextMonday}`],
      },
    ]);
  });

  it('emits sailing.changed for each new sailing and records inventory events', async () => {
    const { rows } = await owner().query<{ type: string; n: number }>(
      `select type, count(*)::int as n from vs.event where operator_id = $1 group by type`,
      [world.ctx.operatorId],
    );
    const sailings = await owner().query(`select 1 from vs.sailing where vessel_id = $1`, [
      world.demo.vesselId,
    ]);
    expect(rows).toContainEqual({ type: 'sailing.changed', n: sailings.rowCount });
    const events = await owner().query<{ n: number }>(
      `select count(*)::int as n from vs.inventory_event where operator_id = $1 and cause = 'schedule.generated'`,
      [world.ctx.operatorId],
    );
    expect(events.rows[0]!.n).toBeGreaterThan(0);
  });

  it('is idempotent and never changes legs that have commitments', async () => {
    const [first] = await legs(world.demo.vesselId);
    const taken = await commit(world, first!.id, world.demo.categories.STD, 3, 1);
    const before = await buckets(world.demo.vesselId);
    const again = await generateSchedule(world.db, world.ctx, { vesselId: world.demo.vesselId });
    expect(again).toMatchObject({
      legsCreated: 0,
      bucketsCreated: 0,
      sailingsCreated: 0,
      conflicts: [],
    });
    expect(await buckets(world.demo.vesselId)).toEqual(before);
    await releaseAll(taken);
  });

  it('extends the horizon later without touching earlier legs', async () => {
    const short = await demoWorld({ code: 'SHORT' });
    try {
      const until = addDays(short.demo.validFrom, 20);
      const first = await generateSchedule(short.db, short.ctx, {
        vesselId: short.demo.vesselId,
        until,
      });
      expect(first.legsCreated).toBe(6); // 3 weeks × (A, B)
      const firstLegs = await legs(short.demo.vesselId);
      const second = await generateSchedule(short.db, short.ctx, {
        vesselId: short.demo.vesselId,
        until: addDays(until, 7),
      });
      expect(second.legsCreated).toBe(2);
      // The ASW-7 sailing of week 3 needed week 4's leg A, so it only appears now.
      expect(second.sailingsCreated).toBeGreaterThanOrEqual(4);
      expect((await legs(short.demo.vesselId)).slice(0, 6)).toEqual(firstLegs);
    } finally {
      await short.close();
    }
  });
});
