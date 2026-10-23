import { sql } from 'kysely';
import { z } from 'zod';
import type { VsDatabase } from '@vs/db';
import type { BusinessDate } from '@vs/shared';
import { audit } from '../audit';
import {
  cairoToday,
  emitEvents,
  lockVessel,
  parseInput,
  recordInventoryEvents,
  type EngineContext,
  type Tx,
} from '../internal';
import { chainLegs, cycleStarts, planLegs, type ChainLeg, type PlannedLeg } from './plan';
import { dateSchema } from './setup';

export const HORIZON_MONTHS = 18;

export const generateScheduleInput = z.object({
  vesselId: z.uuid(),
  /** Defaults to, and is capped at, 18 months from today (Cairo). */
  until: dateSchema.optional(),
});

export interface GenerateScheduleResult {
  until: BusinessDate;
  legsCreated: number;
  bucketsCreated: number;
  sailingsCreated: number;
  /** Planned legs skipped because another live leg of the vessel overlaps them. */
  conflicts: { templateId: string; departDate: string; arriveDate: string }[];
}

/**
 * Creates legs, their pool buckets and sailings from the vessel's templates and patterns, up to
 * 18 months ahead. Idempotent: existing legs and sailings are never changed or deleted (legs with
 * holds or bookings included) and a rerun creates nothing. Changes to existing departures go
 * through applyScheduleException.
 */
export async function generateSchedule(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof generateScheduleInput>,
): Promise<GenerateScheduleResult> {
  const data = parseInput(generateScheduleInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await lockVessel(tx, data.vesselId);
    const today = await cairoToday(tx);
    const horizon = await horizonDate(tx);
    const until = data.until && data.until < horizon ? data.until : horizon;

    const templates = await tx
      .selectFrom('schedule_template')
      .selectAll()
      .where('vessel_id', '=', data.vesselId)
      .where('active', '=', true)
      .orderBy('valid_from')
      .orderBy('id')
      .execute();
    const dryDocks = (
      await tx
        .selectFrom('schedule_exception')
        .select(['date_from', 'date_to'])
        .where('vessel_id', '=', data.vesselId)
        .where('kind', '=', 'dry_dock')
        .execute()
    ).map((row) => ({ from: row.date_from as BusinessDate, to: row.date_to as BusinessDate }));

    const result: GenerateScheduleResult = {
      until,
      legsCreated: 0,
      bucketsCreated: 0,
      sailingsCreated: 0,
      conflicts: [],
    };
    for (const template of templates) {
      const stops = await tx
        .selectFrom('schedule_template_stop')
        .selectAll()
        .where('template_id', '=', template.id)
        .orderBy('seq')
        .execute();
      const planned = planLegs({
        stops: stops.map((stop) => ({
          seq: stop.seq,
          portId: stop.port_id,
          dayOffset: stop.day_offset,
          boarding: stop.embark_allowed || stop.disembark_allowed,
        })),
        validFrom: template.valid_from as BusinessDate,
        validTo: template.valid_to as BusinessDate | null,
        cycleDays: template.cycle_days,
        today,
        until,
        dryDocks,
      });
      const created = await insertLegs(tx, ctx, data.vesselId, template.id, planned);
      result.legsCreated += created.length;
      result.bucketsCreated += await createPoolBuckets(tx, ctx, created);
      const existing = await templateLegs(tx, template.id, today);
      result.conflicts.push(
        ...planned
          .filter((leg) => !existing.has(`${leg.cycleStart}|${leg.fromSeq}`))
          .map((leg) => ({
            templateId: template.id,
            departDate: leg.departDate,
            arriveDate: leg.arriveDate,
          })),
      );
      result.sailingsCreated += await createSailings(
        tx,
        ctx,
        template,
        stops.length - 1,
        existing,
        today,
        until,
      );
    }

    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'schedule.generated',
      entity: 'vessel',
      entityId: data.vesselId,
      after: { ...result, conflicts: result.conflicts.length },
    });
    return result;
  });
}

async function horizonDate(tx: Tx): Promise<BusinessDate> {
  const { rows } = await sql<{ horizon: string }>`
    select ((now() at time zone 'Africa/Cairo')::date + make_interval(months => ${HORIZON_MONTHS}))::date::text as horizon`.execute(
    tx,
  );
  return rows[0]!.horizon as BusinessDate;
}

async function insertLegs(
  tx: Tx,
  ctx: EngineContext,
  vesselId: string,
  templateId: string,
  planned: PlannedLeg[],
): Promise<{ id: string; vessel_id: string; depart_date: string }[]> {
  if (planned.length === 0) return [];
  const rows = JSON.stringify(
    planned.map((leg) => ({
      cycle_start: leg.cycleStart,
      from_seq: leg.fromSeq,
      to_seq: leg.toSeq,
      from_port: leg.fromPortId,
      to_port: leg.toPortId,
      depart: leg.departDate,
      arrive: leg.arriveDate,
    })),
  );
  // Skips legs that overlap a live leg from another template or a shifted departure; the
  // exclusion constraint would otherwise abort the whole generation.
  const { rows: created } = await sql<{ id: string; vessel_id: string; depart_date: string }>`
    insert into vs.leg (operator_id, vessel_id, template_id, cycle_start, from_stop_seq, to_stop_seq,
                        from_port_id, to_port_id, depart_date, arrive_date)
    select ${ctx.operatorId}, ${vesselId}, ${templateId}, x.cycle_start, x.from_seq, x.to_seq,
           x.from_port, x.to_port, x.depart, x.arrive
    from jsonb_to_recordset(${rows}::jsonb)
      as x(cycle_start date, from_seq int, to_seq int, from_port uuid, to_port uuid, depart date, arrive date)
    where not exists (
      select from vs.leg l
      where l.vessel_id = ${vesselId} and l.status <> 'cancelled'
        and daterange(l.depart_date, l.arrive_date) && daterange(x.depart, x.arrive)
    )
    on conflict (operator_id, template_id, cycle_start, from_stop_seq) where template_id is not null
    do nothing
    returning id, vessel_id, depart_date::text`.execute(tx);
  return created;
}

/** One pool bucket per new leg × category, with total = cabins in that category on the departure date. */
async function createPoolBuckets(
  tx: Tx,
  ctx: EngineContext,
  legs: { id: string }[],
): Promise<number> {
  if (legs.length === 0) return 0;
  const { rows } = await sql<{ id: string; leg_id: string; category_id: string; total: number }>`
    insert into vs.inventory_bucket (operator_id, vessel_id, leg_id, category_id, kind, total)
    select l.operator_id, l.vessel_id, l.id, c.id, 'pool',
           (select count(*)::int from vs.cabin_period p
            where p.vessel_id = l.vessel_id and p.category_id = c.id and p.during @> l.depart_date)
    from vs.leg l
    join vs.cabin_category c on c.vessel_id = l.vessel_id and c.operator_id = l.operator_id
    where l.id = any(${legs.map((leg) => leg.id)}::uuid[])
    returning id, leg_id, category_id, total`.execute(tx);
  await recordInventoryEvents(
    tx,
    ctx,
    rows.map((row) => ({
      bucketId: row.id,
      legId: row.leg_id,
      categoryId: row.category_id,
      total: row.total,
    })),
    'schedule.generated',
    null,
  );
  return rows.length;
}

async function templateLegs(
  tx: Tx,
  templateId: string,
  today: BusinessDate,
): Promise<Map<string, ChainLeg>> {
  const legs = await tx
    .selectFrom('leg')
    .select(['id', 'cycle_start', 'from_stop_seq', 'to_stop_seq', 'status'])
    .where('template_id', '=', templateId)
    .where('depart_date', '>=', today)
    .execute();
  return new Map(
    legs.map((leg) => [
      `${leg.cycle_start}|${leg.from_stop_seq}`,
      {
        id: leg.id,
        cycleStart: leg.cycle_start as BusinessDate,
        fromSeq: leg.from_stop_seq!,
        toSeq: leg.to_stop_seq!,
        status: leg.status,
      },
    ]),
  );
}

async function createSailings(
  tx: Tx,
  ctx: EngineContext,
  template: {
    id: string;
    vessel_id: string;
    cycle_days: number;
    valid_from: string;
    valid_to: string | null;
  },
  lastSeq: number,
  legs: Map<string, ChainLeg>,
  today: BusinessDate,
  until: BusinessDate,
): Promise<number> {
  const patterns = await tx
    .selectFrom('sailing_pattern')
    .selectAll()
    .where('template_id', '=', template.id)
    .where('active', '=', true)
    .execute();
  if (patterns.length === 0 || legs.size === 0) return 0;
  const legDates = new Map(
    (
      await tx
        .selectFrom('leg')
        .select(['id', 'depart_date', 'arrive_date', 'from_port_id', 'to_port_id'])
        .where(
          'id',
          'in',
          [...legs.values()].map((leg) => leg.id),
        )
        .execute()
    ).map((leg) => [leg.id, leg]),
  );

  const candidates: { patternId: string; chain: ChainLeg[] }[] = [];
  const starts = cycleStarts(
    template.valid_from as BusinessDate,
    template.valid_to as BusinessDate | null,
    template.cycle_days,
    until,
  );
  for (const pattern of patterns) {
    for (const cycleStart of starts) {
      const chain = chainLegs({
        cycleStart,
        cycleDays: template.cycle_days,
        lastSeq,
        embarkSeq: pattern.embark_stop_seq,
        disembarkSeq: pattern.disembark_stop_seq,
        cycleOffset: pattern.disembark_cycle_offset,
        legs,
      });
      if (chain && legDates.get(chain[0]!.id)!.depart_date >= today)
        candidates.push({ patternId: pattern.id, chain });
    }
  }
  if (candidates.length === 0) return 0;

  const values = candidates.map(({ patternId, chain }) => {
    const first = legDates.get(chain[0]!.id)!;
    const last = legDates.get(chain[chain.length - 1]!.id)!;
    const nights = Math.round(
      (Date.parse(last.arrive_date) - Date.parse(first.depart_date)) / 86_400_000,
    );
    return {
      operator_id: ctx.operatorId,
      vessel_id: template.vessel_id,
      pattern_id: patternId,
      embark_port_id: first.from_port_id,
      disembark_port_id: last.to_port_id,
      embark_date: first.depart_date,
      disembark_date: last.arrive_date,
      nights,
    };
  });
  const created = await tx
    .insertInto('sailing')
    .values(values)
    .onConflict((oc) =>
      oc
        .columns(['operator_id', 'pattern_id', 'embark_date'])
        .where('pattern_id', 'is not', null)
        .doNothing(),
    )
    .returning(['id', 'pattern_id', 'embark_date', 'version'])
    .execute();
  if (created.length === 0) return 0;

  const chains = new Map(
    candidates.map(({ patternId, chain }) => [
      `${patternId}|${legDates.get(chain[0]!.id)!.depart_date}`,
      chain,
    ]),
  );
  await tx
    .insertInto('sailing_leg')
    .values(
      created.flatMap((sailing) =>
        chains.get(`${sailing.pattern_id}|${sailing.embark_date}`)!.map((leg, seq) => ({
          operator_id: ctx.operatorId,
          sailing_id: sailing.id,
          leg_id: leg.id,
          seq,
        })),
      ),
    )
    .execute();
  await emitEvents(
    tx,
    ctx,
    created.map((sailing) => ({
      type: 'sailing.changed',
      resource: 'sailing',
      resourceId: sailing.id,
      version: sailing.version,
      payload: {
        change: 'created',
        vessel_id: template.vessel_id,
        embark_date: sailing.embark_date,
      },
    })),
  );
  return created.length;
}
