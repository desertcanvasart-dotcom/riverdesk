import { owner, testConfig } from '@vs/db/testing';
import { addDays, type BusinessDate } from '@vs/shared';
import {
  createChannel,
  createContract,
  createQuote,
  generateSchedule,
  openDatabase,
  type VsDatabase,
} from '../../src/index';
import { demoWorld, type World } from './world';

export interface BookingWorld extends World {
  /** First Monday of the schedule (0–6 days from today). */
  M: BusinessDate;
  agents: { credit: string; onRequest: string; allotment: string; stopped: string };
  sailing(pattern: 'LXR-4' | 'LXR-7' | 'ASW-3' | 'ASW-7', embarkOffset: number): Promise<string>;
  quote(
    channelId: string,
    sailingId: string,
    cabins: { cat: 'STD' | 'SUP' | 'JS' | 'RS'; adults?: number; ages?: number[] }[],
  ): Promise<string>;
  /** A separate pool for concurrency tests (many real connections). */
  wide(max?: number): VsDatabase;
}

export const lead = [{ cabin: 0, firstName: 'Mona', lastName: 'Hassan', lead: true }];

/** Demo vessel, demo pricing (nilecrz, back office) and four agent channels, 10 weeks of schedule. */
export async function bookingWorld(): Promise<BookingWorld> {
  const world = await demoWorld();
  const { db, ctx, demo } = world;
  const M = demo.validFrom;
  await generateSchedule(db, ctx, { vesselId: demo.vesselId, until: addDays(M, 76) });
  const categoryIds = Object.values(demo.categories);
  const agent = async (code: string, terms: Partial<Parameters<typeof createContract>[2]>) => {
    const channel = await createChannel(db, ctx, {
      code,
      name: code,
      type: 'agent',
      creditAllowed: true,
      creditLimit: 100_000_000,
      creditCurrency: 'USD',
    });
    await createContract(db, ctx, {
      channelId: channel.id,
      vesselId: demo.vesselId,
      allocation: 'pool',
      paymentMode: 'credit',
      validFrom: M,
      categoryIds,
      ratePlanIds: world.ratePlanIds,
      ...terms,
    });
    return channel.id;
  };
  const agents = {
    credit: await agent('credit-agent', {}),
    onRequest: await agent('request-agent', { allocation: 'on_request' }),
    allotment: await agent('allotment-agent', { allocation: 'allotment' }),
    stopped: await agent('stopped-agent', { stopSell: true }),
  };
  const pools: VsDatabase[] = [];
  return {
    ...world,
    M,
    agents,
    async sailing(pattern, embarkOffset) {
      const { rows } = await owner().query<{ id: string }>(
        `select s.id from vs.sailing s join vs.sailing_pattern sp on sp.id = s.pattern_id
         where s.vessel_id = $1 and sp.code = $2 and s.embark_date = $3`,
        [demo.vesselId, pattern, addDays(M, embarkOffset)],
      );
      if (!rows[0]) throw new Error(`No ${pattern} on M+${embarkOffset}`);
      return rows[0].id;
    },
    async quote(channelId, sailingId, cabins) {
      const quote = await createQuote(db, ctx, {
        channelId,
        sailingId,
        market: 'international',
        cabins: cabins.map((c) => ({
          categoryId: demo.categories[c.cat],
          adults: c.adults ?? 2,
          childAges: c.ages ?? [],
        })),
      });
      return quote.id;
    },
    wide(max = 25) {
      const pool = openDatabase('vs_api', { config: testConfig(), max });
      pools.push(pool);
      return pool;
    },
    async close() {
      for (const pool of pools) await pool.close();
      await world.close();
    },
  };
}

/** Pool counters for (leg, category), all kinds. */
export async function counters(legId: string, categoryId: string) {
  const { rows } = await owner().query<{
    kind: string;
    total: number;
    held: number;
    booked: number;
  }>(
    `select kind, total, held, booked from vs.inventory_bucket where leg_id = $1 and category_id = $2 order by kind, id`,
    [legId, categoryId],
  );
  return rows;
}

export async function legsOf(sailingId: string): Promise<string[]> {
  const { rows } = await owner().query<{ leg_id: string }>(
    `select leg_id from vs.sailing_leg where sailing_id = $1 order by seq`,
    [sailingId],
  );
  return rows.map((r) => r.leg_id);
}

/** Test-only time travel (owner connection): make a hold, offer or request due now. */
export async function expireNow(table: 'hold' | 'offer', id: string) {
  await owner().query(
    `update vs.${table} set expires_at = now() - interval '1 second' where id = $1`,
    [id],
  );
}
