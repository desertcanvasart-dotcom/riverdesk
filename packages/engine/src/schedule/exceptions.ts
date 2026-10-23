import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import {
  emitEvents,
  legCommitments,
  lockVessel,
  openException,
  parseInput,
  type EngineContext,
  type Tx,
} from '../internal';
import { dateSchema } from './setup';

const base = { vesselId: z.uuid(), reason: z.string().min(1).max(500) };

export const scheduleExceptionInput = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('cancel'), legIds: z.array(z.uuid()).min(1).max(100) }),
  z.object({ ...base, kind: z.literal('dry_dock'), from: dateSchema, to: dateSchema }),
  z.object({
    ...base,
    kind: z.literal('shift'),
    legIds: z.array(z.uuid()).min(1).max(100),
    days: z
      .number()
      .int()
      .min(-14)
      .max(14)
      .refine((days) => days !== 0, 'days must not be 0'),
  }),
  z.object({
    ...base,
    kind: z.literal('port_change'),
    legId: z.uuid(),
    fromPortId: z.uuid().optional(),
    toPortId: z.uuid().optional(),
  }),
]);

export interface ScheduleExceptionResult {
  scheduleExceptionId: string;
  legsChanged: number;
  sailingsChanged: number;
  /** Sailings that no longer form a continuous trip (dates or ports) and were closed to sale. */
  sailingsClosed: string[];
  /** Set when changed legs carry holds, bookings or allotments: staff must act on them. */
  exceptionId: string | null;
}

interface LegRow {
  id: string;
  depart_date: string;
  arrive_date: string;
  from_port_id: string;
  to_port_id: string;
  status: string;
}

/**
 * Cancels departures, shifts dates, changes ports, or takes the vessel into dry dock. The change
 * is applied (bookings follow the physical departure) and never silently: legs with commitments
 * raise a schedule_change exception for the action list, and every touched sailing emits
 * sailing.changed. Dry-dock ranges are also skipped by later schedule generation.
 */
export async function applyScheduleException(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof scheduleExceptionInput>,
): Promise<ScheduleExceptionResult> {
  const data = parseInput(scheduleExceptionInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) =>
    applyInTx(tx, ctx, data).then(({ legIds: _legIds, ...result }) => result),
  );
}

export interface ScheduleExceptionPreview extends Omit<
  ScheduleExceptionResult,
  'scheduleExceptionId' | 'exceptionId'
> {
  legs: { id: string; departDate: string; arriveDate: string }[];
  bookings: { ref: string; status: string; channel: string; cabins: number }[];
  holds: number;
  allotments: { channel: string; cabins: number }[];
}

class PreviewRollback extends Error {
  constructor(readonly preview: ScheduleExceptionPreview) {
    super('preview');
  }
}

/**
 * The impact of a schedule exception before staff apply it: the real change runs inside a
 * transaction, its effects are read, and everything is rolled back. Exact by construction.
 */
export async function previewScheduleException(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof scheduleExceptionInput>,
): Promise<ScheduleExceptionPreview> {
  const data = parseInput(scheduleExceptionInput, input);
  try {
    await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
      const result = await applyInTx(tx, ctx, data);
      const ids = result.legIds;
      const legs = await sql<ScheduleExceptionPreview['legs'][number]>`
        select id, depart_date::text as "departDate", arrive_date::text as "arriveDate"
        from vs.leg where id = any(${ids}::uuid[]) order by depart_date`.execute(tx);
      const bookings = await sql<ScheduleExceptionPreview['bookings'][number]>`
        select b.ref, b.status, ch.name as channel, count(distinct bl.booking_cabin_id)::int as cabins
        from vs.booking_line bl join vs.booking b on b.id = bl.booking_id join vs.channel ch on ch.id = b.channel_id
        where bl.leg_id = any(${ids}::uuid[]) and bl.status = 'confirmed'
        group by b.ref, b.status, ch.name order by b.ref`.execute(tx);
      const holds = await sql<{ n: number }>`
        select count(distinct h.id)::int as n from vs.hold_line hl join vs.hold h on h.id = hl.hold_id
        where hl.leg_id = any(${ids}::uuid[]) and h.status = 'active'`.execute(tx);
      const allotments = await sql<ScheduleExceptionPreview['allotments'][number]>`
        select ch.name as channel, max(b.total)::int as cabins
        from vs.inventory_bucket b join vs.allotment a on a.id = b.allotment_id join vs.channel ch on ch.id = a.channel_id
        where b.leg_id = any(${ids}::uuid[]) and b.kind = 'allotment' and b.released_at is null and b.total > 0
        group by ch.name order by ch.name`.execute(tx);
      throw new PreviewRollback({
        legsChanged: result.legsChanged,
        sailingsChanged: result.sailingsChanged,
        sailingsClosed: result.sailingsClosed,
        legs: legs.rows,
        bookings: bookings.rows,
        holds: holds.rows[0]!.n,
        allotments: allotments.rows,
      });
    });
  } catch (error) {
    if (error instanceof PreviewRollback) return error.preview;
    throw error;
  }
  throw new Error('unreachable');
}

async function applyInTx(
  tx: Tx,
  ctx: EngineContext,
  data: z.infer<typeof scheduleExceptionInput>,
): Promise<ScheduleExceptionResult & { legIds: string[] }> {
  {
    await lockVessel(tx, data.vesselId);

    let legs: LegRow[];
    if (data.kind === 'dry_dock') {
      if (data.to < data.from)
        throw new DomainError('VALIDATION_FAILED', { message: 'to is before from' });
      legs = await lockLegs(tx, data.vesselId, {
        overlapping: { from: data.from, to: data.to },
      });
    } else {
      const ids = data.kind === 'port_change' ? [data.legId] : data.legIds;
      legs = await lockLegs(tx, data.vesselId, { ids });
      if (legs.length !== new Set(ids).size)
        throw new DomainError('NOT_FOUND', { message: 'Leg not found on this vessel' });
      if (legs.some((leg) => leg.status === 'cancelled')) {
        throw new DomainError('INVALID_STATE', { message: 'A leg is already cancelled' });
      }
    }
    const legIds = legs.map((leg) => leg.id);

    let dateFrom: string;
    let dateTo: string;
    const details: Record<string, unknown> = { leg_ids: legIds };
    switch (data.kind) {
      case 'cancel':
      case 'dry_dock': {
        if (legIds.length > 0) {
          await tx
            .updateTable('leg')
            .set((eb) => ({ status: 'cancelled', version: eb('version', '+', 1n) }))
            .where('id', 'in', legIds)
            .execute();
        }
        dateFrom = data.kind === 'dry_dock' ? data.from : legs[0]!.depart_date;
        dateTo = data.kind === 'dry_dock' ? data.to : legs[legs.length - 1]!.arrive_date;
        break;
      }
      case 'shift': {
        // The overlap constraint is checked at commit, so a run of legs can move past itself.
        await sql`set constraints vs.leg_no_overlap deferred`.execute(tx);
        await tx
          .updateTable('leg')
          .set((eb) => ({
            depart_date: sql`depart_date + ${data.days}::int`,
            arrive_date: sql`arrive_date + ${data.days}::int`,
            version: eb('version', '+', 1n),
          }))
          .where('id', 'in', legIds)
          .execute();
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from vs.leg a join vs.leg b
            on a.vessel_id = b.vessel_id and a.id < b.id
           and a.status <> 'cancelled' and b.status <> 'cancelled'
           and daterange(a.depart_date, a.arrive_date) && daterange(b.depart_date, b.arrive_date)
          where a.vessel_id = ${data.vesselId} and (a.id = any(${legIds}::uuid[]) or b.id = any(${legIds}::uuid[]))`.execute(
          tx,
        );
        if (rows[0]!.n > 0)
          throw new DomainError('SCHEDULE_CONFLICT', {
            message: 'The shifted legs overlap other legs',
          });
        await sql`set constraints vs.leg_no_overlap immediate`.execute(tx);
        dateFrom = legs[0]!.depart_date;
        dateTo = legs[legs.length - 1]!.arrive_date;
        details.days = data.days;
        break;
      }
      case 'port_change': {
        if (!data.fromPortId && !data.toPortId) {
          throw new DomainError('VALIDATION_FAILED', {
            message: 'Give fromPortId, toPortId or both',
          });
        }
        await tx
          .updateTable('leg')
          .set((eb) => ({
            ...(data.fromPortId ? { from_port_id: data.fromPortId } : {}),
            ...(data.toPortId ? { to_port_id: data.toPortId } : {}),
            version: eb('version', '+', 1n),
          }))
          .where('id', '=', data.legId)
          .execute();
        dateFrom = legs[0]!.depart_date;
        dateTo = legs[0]!.arrive_date;
        details.before = { from_port_id: legs[0]!.from_port_id, to_port_id: legs[0]!.to_port_id };
        details.after = {
          from_port_id: data.fromPortId ?? legs[0]!.from_port_id,
          to_port_id: data.toPortId ?? legs[0]!.to_port_id,
        };
        break;
      }
    }

    const sailings = await refreshSailings(tx, legIds);
    const commitments = await legCommitments(tx, legIds);
    let exceptionId: string | null = null;
    if (commitments.length > 0) {
      exceptionId = await openException(tx, ctx, {
        kind: 'schedule_change',
        severity: 'warning',
        summary: `Schedule ${data.kind.replace('_', ' ')} affects ${new Set(commitments.map((c) => c.leg_id)).size} leg(s) with commitments`,
        refs: [...new Set(commitments.map((c) => c.leg_id))].map((id) => ({ entity: 'leg', id })),
        details: {
          kind: data.kind,
          reason: data.reason,
          commitments,
          sailings_closed: sailings.closed,
        },
      });
    }

    const record = await tx
      .insertInto('schedule_exception')
      .values({
        operator_id: ctx.operatorId,
        vessel_id: data.vesselId,
        kind: data.kind,
        date_from: dateFrom,
        date_to: dateTo < dateFrom ? dateFrom : dateTo,
        details: JSON.stringify(details),
        reason: data.reason,
        exception_id: exceptionId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await emitEvents(
      tx,
      ctx,
      sailings.changed.map((sailing) => ({
        type: 'sailing.changed',
        resource: 'sailing',
        resourceId: sailing.id,
        version: sailing.version,
        payload: {
          change: data.kind,
          status: sailing.status,
          embark_date: sailing.embark_date,
          vessel_id: data.vesselId,
        },
      })),
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: `schedule.${data.kind}`,
      entity: 'schedule_exception',
      entityId: record.id,
      after: {
        ...details,
        reason: data.reason,
        sailings_changed: sailings.changed.length,
        exception_id: exceptionId,
      },
    });
    return {
      scheduleExceptionId: record.id,
      legsChanged: legIds.length,
      sailingsChanged: sailings.changed.length,
      sailingsClosed: sailings.closed,
      exceptionId,
      legIds,
    };
  }
}

async function lockLegs(
  tx: Tx,
  vesselId: string,
  filter: { ids?: string[]; overlapping?: { from: string; to: string } },
): Promise<LegRow[]> {
  const { rows } = await sql<LegRow>`
    select id, depart_date::text, arrive_date::text, from_port_id, to_port_id, status
    from vs.leg
    where vessel_id = ${vesselId}
      ${filter.ids ? sql`and id = any(${filter.ids}::uuid[])` : sql``}
      ${filter.overlapping ? sql`and status <> 'cancelled' and depart_date <= ${filter.overlapping.to}::date and arrive_date > ${filter.overlapping.from}::date` : sql``}
    order by depart_date, id
    for update`.execute(tx);
  return rows;
}

/**
 * Recomputes every sailing that uses the changed legs: dates and ports from its first and last
 * leg; cancelled if a leg is cancelled; closed if its legs no longer join up (one leg must end
 * where and when the next begins).
 */
async function refreshSailings(tx: Tx, legIds: string[]) {
  if (legIds.length === 0) return { changed: [], closed: [] };
  const { rows: changed } = await sql<{
    id: string;
    version: bigint;
    status: string;
    embark_date: string;
  }>`
    with touched as (
      select distinct sl.sailing_id from vs.sailing_leg sl where sl.leg_id = any(${legIds}::uuid[])
    ),
    shape as (
      select sl.sailing_id,
             (array_agg(l.depart_date order by sl.seq))[1] as embark_date,
             (array_agg(l.arrive_date order by sl.seq desc))[1] as disembark_date,
             (array_agg(l.from_port_id order by sl.seq))[1] as embark_port_id,
             (array_agg(l.to_port_id order by sl.seq desc))[1] as disembark_port_id,
             bool_or(l.status = 'cancelled') as any_cancelled,
             bool_and(prev.id is null or (prev.arrive_date = l.depart_date and prev.to_port_id = l.from_port_id)) as joined
      from vs.sailing_leg sl
      join touched t on t.sailing_id = sl.sailing_id
      join vs.leg l on l.id = sl.leg_id
      left join vs.sailing_leg psl on psl.sailing_id = sl.sailing_id and psl.seq = sl.seq - 1
      left join vs.leg prev on prev.id = psl.leg_id
      group by sl.sailing_id
    )
    update vs.sailing s
    set embark_date = shape.embark_date,
        disembark_date = shape.disembark_date,
        embark_port_id = shape.embark_port_id,
        disembark_port_id = shape.disembark_port_id,
        nights = shape.disembark_date - shape.embark_date,
        status = case
          when shape.any_cancelled then 'cancelled'
          when not shape.joined then 'closed'
          else s.status end,
        version = s.version + 1
    from shape
    where s.id = shape.sailing_id
    returning s.id, s.version, s.status, s.embark_date::text`.execute(tx);
  return {
    changed,
    closed: changed.filter((sailing) => sailing.status === 'closed').map((sailing) => sailing.id),
  };
}
