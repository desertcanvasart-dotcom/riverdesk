import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner, testConfig } from '@vs/db/testing';
import { isDomainError } from '@vs/contracts';
import { addDays } from '@vs/shared';
import {
  blockCabins,
  cancelBooking,
  confirmHold,
  createAllotment,
  createHold,
  expireHolds,
  generateSchedule,
  openDatabase,
  releaseBlock,
  releaseDueAllotments,
  releaseHold,
  type VsDatabase,
} from '../src/index';
import { bookingWorld, counters, lead, legsOf, type BookingWorld } from './helpers/booking-world';

/** Settles every promise and tallies outcomes: 'ok' or the domain error code. Other errors fail the test. */
async function tally<T>(runs: Promise<T>[]) {
  const settled = await Promise.allSettled(runs);
  const outcomes = settled.map((s) => {
    if (s.status === 'fulfilled') return 'ok';
    if (isDomainError(s.reason)) return s.reason.code;
    throw s.reason;
  });
  const counts: Record<string, number> = {};
  for (const o of outcomes) counts[o] = (counts[o] ?? 0) + 1;
  return { counts, settled };
}

async function invariantsFor(operatorId: string) {
  return (
    await owner().query(
      `select invariant, entity, entity_id from vs.check_invariants() where operator_id = $1`,
      [operatorId],
    )
  ).rows;
}

describe('concurrency (spec acceptance tests 1–4)', () => {
  let w: BookingWorld;
  let api: VsDatabase;
  let worker: VsDatabase;

  beforeAll(async () => {
    w = await bookingWorld();
    api = w.wide(25);
    worker = openDatabase('vs_worker', { config: testConfig(), max: 4 });
  }, 120_000);

  afterAll(async () => {
    await worker.close();
    await w.close();
  });

  it('test 1: 200 parallel holds for 5 free cabins → exactly 5 succeed', async () => {
    const sailing = await w.sailing('LXR-4', 7);
    const [leg] = (await legsOf(sailing)) as [string];
    const std = w.demo.categories.STD;
    const block = await blockCabins(w.db, w.ctx, {
      legIds: [leg],
      categoryId: std,
      count: 7,
      reason: 'Leave exactly 5 free',
    });
    const quoteId = await w.quote(w.channels.nilecrz, sailing, [{ cat: 'STD' }]);

    const { counts, settled } = await tally(
      Array.from({ length: 200 }, () =>
        createHold(api, w.ctx, { channelId: w.channels.nilecrz, quoteId, kind: 'checkout' }),
      ),
    );
    expect(counts).toEqual({ ok: 5, NOT_AVAILABLE: 195 });
    expect((await counters(leg, std)).find((c) => c.kind === 'pool')).toMatchObject({
      total: 5,
      held: 5,
    });
    expect(await invariantsFor(w.ctx.operatorId)).toEqual([]);

    for (const s of settled)
      if (s.status === 'fulfilled') await releaseHold(w.db, w.ctx, { holdId: s.value.holdId });
    await releaseBlock(w.db, w.ctx, { blockId: block.id });
  });

  it('test 2: 7 nights (A + B) and 4 nights (A) race for the last cabin → exactly one succeeds, every time', async () => {
    const long = await w.sailing('LXR-7', 14);
    const short = await w.sailing('LXR-4', 14);
    const [legA, legB] = (await legsOf(long)) as [string, string];
    const std = w.demo.categories.STD;
    const block = await blockCabins(w.db, w.ctx, {
      legIds: [legA, legB],
      categoryId: std,
      count: 11,
      reason: 'Leave 1 free on A and B',
    });
    const longQuote = await w.quote(w.channels.nilecrz, long, [{ cat: 'STD' }]);
    const shortQuote = await w.quote(w.channels.nilecrz, short, [{ cat: 'STD' }]);
    const winners: string[] = [];
    for (let round = 0; round < 20; round += 1) {
      const pair = [
        createHold(api, w.ctx, {
          channelId: w.channels.nilecrz,
          quoteId: longQuote,
          kind: 'checkout',
        }),
        createHold(api, w.ctx, {
          channelId: w.channels.nilecrz,
          quoteId: shortQuote,
          kind: 'checkout',
        }),
      ];
      const { counts, settled } = await tally(round % 2 ? pair : pair.reverse());
      expect(counts).toEqual({ ok: 1, NOT_AVAILABLE: 1 });
      const won = settled.find((s) => s.status === 'fulfilled') as PromiseFulfilledResult<{
        holdId: string;
        lines: unknown[];
      }>;
      winners.push(won.value.lines.length === 2 ? '7n' : '4n');
      await releaseHold(w.db, w.ctx, { holdId: won.value.holdId });
    }
    expect(winners).toHaveLength(20);
    expect(await invariantsFor(w.ctx.operatorId)).toEqual([]);
    await releaseBlock(w.db, w.ctx, { blockId: block.id });
  });

  it('test 3: 1,000 holds at their expiry instant; confirm and the expiry job race → each ends confirmed or expired, never both', async () => {
    await generateSchedule(w.db, w.ctx, { vesselId: w.demo.vesselId, until: addDays(w.M, 210) });
    // 1-cabin holds spread over single-leg sailings and categories until there are 1,000.
    const plan: { sailing: string; quote: string }[] = [];
    const capacity = { STD: 12, SUP: 10, JS: 6, RS: 2 } as const;
    for (let week = 9; plan.length < 1000; week += 1) {
      for (const [pattern, offset] of [
        ['LXR-4', 0],
        ['ASW-3', 4],
      ] as const) {
        const sailing = await w.sailing(pattern, week * 7 + offset);
        for (const cat of Object.keys(capacity) as (keyof typeof capacity)[]) {
          const quote = await w.quote(w.channels.nilecrz, sailing, [{ cat }]);
          for (let i = 0; i < capacity[cat] && plan.length < 1000; i += 1)
            plan.push({ sailing, quote });
        }
      }
    }
    const created = await Promise.all(
      plan.map((p) =>
        createHold(api, w.ctx, { channelId: w.channels.nilecrz, quoteId: p.quote, kind: 'option' }),
      ),
    );
    const holdIds = created.map((h) => h.holdId);
    await owner().query(
      `update vs.hold set expires_at = now() + interval '700 milliseconds' where id = any($1)`,
      [holdIds],
    );

    let expiring = true;
    const expiry = (async () => {
      let expired = 0;
      while (expiring) {
        expired += (await expireHolds(worker, w.ctx, { limit: 500 })).expired;
      }
      return expired + (await expireHolds(worker, w.ctx, { limit: 5000 })).expired;
    })();
    const confirms = await tally(
      holdIds.map((holdId) => confirmHold(api, w.ctx, { holdId, guests: lead })),
    );
    expiring = false;
    const expiredByJob = await expiry;

    expect(
      (confirms.counts.ok ?? 0) +
        (confirms.counts.HOLD_EXPIRED ?? 0) +
        (confirms.counts.HOLD_NOT_ACTIVE ?? 0),
    ).toBe(1000);
    const { rows } = await owner().query<{ status: string; n: number; with_booking: number }>(
      `select h.status, count(*)::int as n,
              count(*) filter (where b.status = 'confirmed')::int as with_booking
       from vs.hold h left join vs.booking b on b.id = h.booking_id
       where h.id = any($1) group by h.status order by h.status`,
      [holdIds],
    );
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r]));
    expect(Object.keys(byStatus).every((s) => s === 'confirmed' || s === 'expired')).toBe(true);
    expect((byStatus.confirmed?.n ?? 0) + (byStatus.expired?.n ?? 0)).toBe(1000);
    expect(byStatus.confirmed?.n ?? 0).toBe(confirms.counts.ok ?? 0);
    expect(byStatus.confirmed?.with_booking ?? 0).toBe(byStatus.confirmed?.n ?? 0); // every confirmed hold has its booking
    expect(byStatus.expired?.with_booking ?? 0).toBe(0); // no expired hold has a booking
    expect(byStatus.expired?.n ?? 0).toBe(expiredByJob);
    expect(await invariantsFor(w.ctx.operatorId)).toEqual([]);
    console.info(
      `test 3: ${byStatus.confirmed?.n ?? 0} confirmed, ${byStatus.expired?.n ?? 0} expired`,
    );
  }, 180_000);

  it('test 4: cancellation and allotment release race on the same bucket → the cabin is counted once and ends in the pool', async () => {
    const std = w.demo.categories.STD;
    for (let round = 0; round < 8; round += 1) {
      const sailing = await w.sailing('ASW-3', 7 * (round + 1) + 4);
      const [leg] = (await legsOf(sailing)) as [string];
      const allotment = await createAllotment(w.db, w.ctx, {
        channelId: w.agents.allotment,
        vesselId: w.demo.vesselId,
        legIds: [leg],
        categories: [{ categoryId: std, cabins: 1 }],
        releaseDays: 1,
      });
      const hold = await createHold(w.db, w.ctx, {
        channelId: w.agents.allotment,
        quoteId: await w.quote(w.agents.allotment, sailing, [{ cat: 'STD' }]),
        kind: 'option',
      });
      const booking = await confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead });
      await owner().query(`update vs.allotment set release_days = 400 where id = $1`, [
        allotment.id,
      ]); // due now

      const cancel = () =>
        cancelBooking(api, w.ctx, { bookingId: booking.bookingId, reason: 'race' });
      const release = () => releaseDueAllotments(worker, w.ctx);
      const results = await Promise.all(round % 2 ? [cancel(), release()] : [release(), cancel()]);
      expect(results).toHaveLength(2);

      const buckets = Object.fromEntries((await counters(leg, std)).map((c) => [c.kind, c]));
      expect(buckets.allotment).toMatchObject({ total: 0, held: 0, booked: 0 });
      expect(buckets.pool).toMatchObject({ total: 12, booked: 0 });
    }
    expect(await invariantsFor(w.ctx.operatorId)).toEqual([]);
  }, 120_000);
});
