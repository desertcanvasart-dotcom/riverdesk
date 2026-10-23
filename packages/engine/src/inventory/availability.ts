import { sql } from 'kysely';
import { z } from 'zod';
import type { VsDatabase } from '@vs/db';
import { parseInput, type EngineContext } from '../internal';
import { dateSchema } from '../schedule/setup';

export const getAvailabilityInput = z
  .object({ vesselId: z.uuid(), from: dateSchema, to: dateSchema })
  .refine((value) => value.to >= value.from, 'to is before from');

export interface CategoryAvailability {
  categoryId: string;
  code: string;
  /** Pool cabins sellable on every leg: the minimum free across the legs, 0 if any leg is stopped. */
  free: number;
  stopSale: boolean;
}

export interface SailingAvailability {
  sailingId: string;
  patternCode: string | null;
  embarkDate: string;
  disembarkDate: string;
  nights: number;
  embarkPort: string;
  disembarkPort: string;
  legIds: string[];
  categories: CategoryAvailability[];
}

export interface Availability {
  /** Database time the counts were read at. */
  asOf: Date;
  sailings: SailingAvailability[];
}

/**
 * Per open sailing embarking between `from` and `to`, and per category: the minimum pool free
 * count across the sailing's legs (spec § Inventory model). A leg that is not open, a stopped
 * pool bucket or a missing bucket gives 0. Channel caps and allotments apply on top (Batch 5).
 */
export async function getAvailability(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof getAvailabilityInput>,
): Promise<Availability> {
  const data = parseInput(getAvailabilityInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
      as_of: Date;
      sailing_id: string;
      pattern_code: string | null;
      embark_date: string;
      disembark_date: string;
      nights: number;
      embark_port: string;
      disembark_port: string;
      leg_ids: string[];
      category_id: string;
      category_code: string;
      min_free: number | null;
      stopped: boolean;
      unavailable: boolean;
    }>`
      select now() as as_of,
             s.id as sailing_id, sp.code as pattern_code,
             s.embark_date::text, s.disembark_date::text, s.nights,
             ep.code as embark_port, dp.code as disembark_port,
             array_agg(l.id order by sl.seq) as leg_ids,
             c.id as category_id, c.code as category_code,
             min(b.total - b.held - b.booked) as min_free,
             coalesce(bool_or(b.stop_sale), false) as stopped,
             bool_or(l.status <> 'open' or b.id is null) as unavailable
      from vs.sailing s
      join vs.port ep on ep.id = s.embark_port_id
      join vs.port dp on dp.id = s.disembark_port_id
      left join vs.sailing_pattern sp on sp.id = s.pattern_id
      join vs.sailing_leg sl on sl.sailing_id = s.id
      join vs.leg l on l.id = sl.leg_id
      join vs.cabin_category c on c.vessel_id = s.vessel_id
      left join vs.inventory_bucket b on b.leg_id = l.id and b.category_id = c.id and b.kind = 'pool'
      where s.vessel_id = ${data.vesselId}
        and s.embark_date between ${data.from}::date and ${data.to}::date
        and s.status = 'open'
      group by s.id, sp.code, ep.code, dp.code, c.id, c.code, c.sort_order
      order by s.embark_date, s.nights, sp.code, c.sort_order, c.code`.execute(tx);

    const asOf =
      rows[0]?.as_of ?? (await sql<{ now: Date }>`select now() as now`.execute(tx)).rows[0]!.now;
    const sailings = new Map<string, SailingAvailability>();
    for (const row of rows) {
      let sailing = sailings.get(row.sailing_id);
      if (!sailing) {
        sailing = {
          sailingId: row.sailing_id,
          patternCode: row.pattern_code,
          embarkDate: row.embark_date,
          disembarkDate: row.disembark_date,
          nights: row.nights,
          embarkPort: row.embark_port,
          disembarkPort: row.disembark_port,
          legIds: row.leg_ids,
          categories: [],
        };
        sailings.set(row.sailing_id, sailing);
      }
      const free = row.stopped || row.unavailable ? 0 : Math.max(0, row.min_free ?? 0);
      sailing.categories.push({
        categoryId: row.category_id,
        code: row.category_code,
        free,
        stopSale: row.stopped,
      });
    }
    return { asOf, sailings: [...sailings.values()] };
  });
}
