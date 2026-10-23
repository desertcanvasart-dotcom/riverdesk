import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError } from '@vs/contracts';
import { addDays } from '@vs/shared';
import { applyScheduleException, generateSchedule, getAvailability } from '../src/index';
import { demoWorld, legs, commit, releaseAll, type World } from './helpers/world';

async function sailingsOf(vesselId: string) {
  const { rows } = await owner().query<{
    id: string;
    code: string;
    embark_date: string;
    disembark_date: string;
    status: string;
    embark: string;
  }>(
    `select s.id, sp.code, s.embark_date::text, s.disembark_date::text, s.status, p.code as embark
     from vs.sailing s join vs.sailing_pattern sp on sp.id = s.pattern_id join vs.port p on p.id = s.embark_port_id
     where s.vessel_id = $1 order by s.embark_date, sp.code`,
    [vesselId],
  );
  return rows;
}

describe('applyScheduleException', () => {
  let world: World;

  beforeAll(async () => {
    world = await demoWorld();
    await generateSchedule(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      until: addDays(world.demo.validFrom, 41),
    });
  });

  afterAll(async () => {
    await world.close();
  });

  it('cancels a departure: legs and sailings cancelled, commitments flagged, sailing.changed emitted', async () => {
    const all = await legs(world.demo.vesselId);
    const legA2 = all[2]!; // week 2, leg A
    const sold = await commit(world, legA2.id, world.demo.categories.STD, 4);
    const result = await applyScheduleException(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      kind: 'cancel',
      legIds: [legA2.id],
      reason: 'Low water at Esna lock',
    });
    expect(result.legsChanged).toBe(1);
    expect(result.exceptionId).toBeTruthy();
    // LXR-4 and LXR-7 of week 2 and ASW-7 of week 1 use that leg.
    expect(result.sailingsChanged).toBe(3);
    const cancelled = (await sailingsOf(world.demo.vesselId)).filter(
      (s) => s.status === 'cancelled',
    );
    expect(cancelled.map((s) => s.code).sort()).toEqual(['ASW-7', 'LXR-4', 'LXR-7']);

    const exception = await owner().query(
      `select kind, refs, details from vs.exception where id = $1`,
      [result.exceptionId],
    );
    expect(exception.rows[0]).toMatchObject({
      kind: 'schedule_change',
      refs: [{ entity: 'leg', id: legA2.id }],
    });
    const events = await owner().query(
      `select count(*)::int as n from vs.event where operator_id = $1 and type = 'sailing.changed' and payload->>'change' = 'cancel'`,
      [world.ctx.operatorId],
    );
    expect(events.rows[0].n).toBe(3);
    // The leg keeps its counters: bookings stay until staff move them.
    const pool = await owner().query(
      `select booked from vs.inventory_bucket where leg_id = $1 and category_id = $2 and kind = 'pool'`,
      [legA2.id, world.demo.categories.STD],
    );
    expect(pool.rows[0].booked).toBe(4);
    await releaseAll(sold);
  });

  it('shifts a leg by a day: its own sailing moves, a sailing that no longer joins up is closed', async () => {
    const all = await legs(world.demo.vesselId);
    const legB1 = all[1]!; // Fri → Mon, followed by the leg cancelled above, so there is room
    const result = await applyScheduleException(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      kind: 'shift',
      legIds: [legB1.id],
      days: 1,
      reason: 'Delayed departure from Aswan',
    });
    expect(result.exceptionId).toBeNull(); // no commitments
    const sailings = await sailingsOf(world.demo.vesselId);
    const saturday = addDays(legB1.depart_date, 1);
    expect(sailings.find((s) => s.code === 'ASW-3' && s.embark_date === saturday)).toMatchObject({
      status: 'open',
      disembark_date: addDays(legB1.arrive_date, 1),
    });
    // LXR-7 of week 1 (leg A arrives Friday, leg B now leaves Saturday) has a gap night: closed.
    const lxr7 = sailings.find((s) => s.code === 'LXR-7' && s.embark_date === all[0]!.depart_date)!;
    expect(result.sailingsClosed).toEqual([lxr7.id]);
    expect(lxr7.status).toBe('closed');
    const availability = await getAvailability(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      from: all[0]!.depart_date,
      to: addDays(all[0]!.depart_date, 6),
    });
    expect(availability.sailings.map((s) => s.patternCode).sort()).toEqual(['ASW-3', 'LXR-4']);
  });

  it('refuses a shift that would overlap another leg', async () => {
    const all = await legs(world.demo.vesselId);
    const error = await applyScheduleException(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      kind: 'shift',
      legIds: [all[7]!.id],
      days: 2,
      reason: 'x',
    }).catch((e: unknown) => e);
    expect(isDomainError(error, 'SCHEDULE_CONFLICT')).toBe(true);
  });

  it('changes a port: sailings take the new embark port', async () => {
    const all = await legs(world.demo.vesselId);
    const legA5 = all.find((l) => l.depart_date === addDays(world.demo.validFrom, 28))!; // leg A, week 5
    expect(legA5.from_port).toBe('LXR');
    await applyScheduleException(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      kind: 'port_change',
      legId: legA5.id,
      fromPortId: world.demo.ports.ESN,
      reason: 'Embark at Esna: Luxor berth closed',
    });
    const sailing = (await sailingsOf(world.demo.vesselId)).find(
      (s) => s.code === 'LXR-4' && s.embark_date === legA5.depart_date,
    )!;
    expect(sailing.embark).toBe('ESN');
    // The previous leg still arrives at Luxor, so the 7-night trip through it no longer joins up.
    const asw7 = (await sailingsOf(world.demo.vesselId)).find(
      (s) => s.code === 'ASW-7' && s.disembark_date === addDays(legA5.depart_date, 4),
    )!;
    expect(asw7.status).toBe('closed');
  });

  it('dry dock cancels the legs in the range and later generation skips it', async () => {
    const all = await legs(world.demo.vesselId);
    const last = all[all.length - 1]!;
    const from = addDays(last.arrive_date, 7);
    const to = addDays(from, 9);
    await applyScheduleException(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      kind: 'dry_dock',
      from,
      to,
      reason: 'Annual dry dock',
    });
    await generateSchedule(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      until: addDays(to, 14),
    });
    const after = await legs(world.demo.vesselId);
    const inRange = after.filter((leg) => leg.depart_date <= to && leg.arrive_date > from);
    expect(inRange).toEqual([]);
    expect(after.some((leg) => leg.depart_date > to)).toBe(true);
  });
});
