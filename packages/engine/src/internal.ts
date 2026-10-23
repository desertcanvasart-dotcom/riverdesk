import { sql, type Transaction } from 'kysely';
import { DomainError } from '@vs/contracts';
import type { DB } from '@vs/db';
import type { Actor, BusinessDate } from '@vs/shared';
import type { z } from 'zod';

export type Tx = Transaction<DB>;

/** Who is acting, for which tenant. Every engine write takes one (rule 11). */
export interface EngineContext {
  operatorId: string;
  actor: Actor;
}

/** Validates engine input at the boundary; zod failures become VALIDATION_FAILED. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DomainError('VALIDATION_FAILED', {
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }
  return result.data;
}

/** Today's date in Cairo, from the database clock (rule 4). */
export async function cairoToday(tx: Tx): Promise<BusinessDate> {
  const { rows } = await sql<{ today: string }>`
    select (now() at time zone 'Africa/Cairo')::date::text as today`.execute(tx);
  return rows[0]!.today as BusinessDate;
}

export async function dbNow(tx: Tx): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`select now() as now`.execute(tx);
  return rows[0]!.now;
}

/**
 * Locks the vessel row. Schedule generation, schedule exceptions and capacity changes all take
 * this lock first, so they never interleave on one vessel (each reads cabins and legs that the
 * others change).
 */
export async function lockVessel(tx: Tx, vesselId: string) {
  const vessel = await tx
    .selectFrom('vessel')
    .selectAll()
    .where('id', '=', vesselId)
    .forUpdate()
    .executeTakeFirst();
  if (!vessel)
    throw new DomainError('NOT_FOUND', { message: 'Vessel not found', details: { vesselId } });
  return vessel;
}

export interface LockedBucket {
  id: string;
  vessel_id: string;
  leg_id: string;
  category_id: string;
  kind: 'pool' | 'allotment' | 'block';
  allotment_id: string | null;
  block_id: string | null;
  total: number;
  held: number;
  booked: number;
  overcommit: number;
  stop_sale: boolean;
  stop_reason: string | null;
  depart_date: string;
  leg_status: string;
}

/**
 * Locks buckets in the one global order (rule 5): leg departure date, leg id, category id,
 * bucket id. Callers lock their owning row first. LockRows sits above the sort, so rows are
 * locked in this order.
 */
export async function lockBuckets(
  tx: Tx,
  filter: {
    bucketIds?: string[];
    legIds?: string[];
    categoryIds?: string[];
    kind?: LockedBucket['kind'];
  },
): Promise<LockedBucket[]> {
  const { rows } = await sql<LockedBucket>`
    select b.id, b.vessel_id, b.leg_id, b.category_id, b.kind, b.allotment_id, b.block_id,
           b.total, b.held, b.booked, b.overcommit, b.stop_sale, b.stop_reason,
           l.depart_date::text as depart_date, l.status as leg_status
    from vs.inventory_bucket b
    join vs.leg l on l.id = b.leg_id
    where true
      ${filter.bucketIds ? sql`and b.id = any(${filter.bucketIds}::uuid[])` : sql``}
      ${filter.legIds ? sql`and b.leg_id = any(${filter.legIds}::uuid[])` : sql``}
      ${filter.categoryIds ? sql`and b.category_id = any(${filter.categoryIds}::uuid[])` : sql``}
      ${filter.kind ? sql`and b.kind = ${filter.kind}` : sql``}
    order by l.depart_date, l.id, b.category_id, b.id
    for update of b`.execute(tx);
  return rows;
}

export interface BucketDelta {
  bucketId: string;
  legId: string;
  categoryId: string;
  total?: number;
  held?: number;
  booked?: number;
  overcommit?: number;
}

/** Appends one inventory_event per changed bucket (rule 3), in the caller's transaction. */
export async function recordInventoryEvents(
  tx: Tx,
  ctx: EngineContext,
  deltas: BucketDelta[],
  cause: string,
  ref: { entity: string; id: string } | null,
): Promise<void> {
  const rows = deltas
    .filter(
      (d) =>
        (d.total ?? 0) !== 0 ||
        (d.held ?? 0) !== 0 ||
        (d.booked ?? 0) !== 0 ||
        (d.overcommit ?? 0) !== 0,
    )
    .map((d) => ({
      operator_id: ctx.operatorId,
      bucket_id: d.bucketId,
      leg_id: d.legId,
      category_id: d.categoryId,
      delta_total: d.total ?? 0,
      delta_held: d.held ?? 0,
      delta_booked: d.booked ?? 0,
      delta_overcommit: d.overcommit ?? 0,
      cause,
      ref_entity: ref?.entity ?? null,
      ref_id: ref?.id ?? null,
      actor_type: ctx.actor.type,
      actor_id: ctx.actor.type === 'system' ? null : ctx.actor.id,
      actor_label: ctx.actor.label ?? null,
    }));
  if (rows.length > 0) await tx.insertInto('inventory_event').values(rows).execute();
}

export interface OutboxEvent {
  type: string;
  resource: string;
  resourceId: string;
  /** The owning row's version after this change (monotonic per resource). */
  version: bigint;
  /** Never personal data (rule 9). */
  payload: Record<string, unknown>;
}

/** Writes outbox events (rule 3). Webhook delivery and the feed arrive in Batch 5. */
export async function emitEvents(tx: Tx, ctx: EngineContext, events: OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx
    .insertInto('event')
    .values(
      events.map((event) => ({
        operator_id: ctx.operatorId,
        type: event.type,
        resource: event.resource,
        resource_id: event.resourceId,
        resource_version: event.version,
        payload: JSON.stringify(event.payload),
      })),
    )
    .execute();
}

/**
 * Bumps the version of changed buckets and emits availability.changed for pool buckets, whose
 * free count is what channels sell from.
 */
export async function availabilityChanged(
  tx: Tx,
  ctx: EngineContext,
  bucketIds: string[],
  cause: string,
): Promise<void> {
  if (bucketIds.length === 0) return;
  const updated = await tx
    .updateTable('inventory_bucket')
    .set((eb) => ({ version: eb('version', '+', 1n) }))
    .where('id', 'in', [...new Set(bucketIds)])
    .returning(['id', 'kind', 'version', 'vessel_id', 'leg_id', 'category_id'])
    .execute();
  await emitEvents(
    tx,
    ctx,
    updated
      .filter((bucket) => bucket.kind === 'pool')
      .map((bucket) => ({
        type: 'availability.changed',
        resource: 'inventory_bucket',
        resourceId: bucket.id,
        version: bucket.version,
        payload: {
          vessel_id: bucket.vessel_id,
          leg_id: bucket.leg_id,
          category_id: bucket.category_id,
          cause,
        },
      })),
  );
}

export interface ExceptionInput {
  kind: 'invariant' | 'oversubscription' | 'schedule_change';
  severity: 'critical' | 'warning' | 'info';
  summary: string;
  refs: { entity: string; id: string }[];
  details?: Record<string, unknown>;
  dedupeKey?: string;
}

/** Opens an exception for the action list. With a dedupe key, an open duplicate is not repeated. */
export async function openException(
  tx: Tx,
  ctx: EngineContext,
  input: ExceptionInput,
): Promise<string | null> {
  const { rows } = await sql<{ id: string }>`
    insert into vs.exception (operator_id, kind, severity, summary, refs, details, dedupe_key)
    values (${ctx.operatorId}, ${input.kind}, ${input.severity}, ${input.summary},
            ${JSON.stringify(input.refs)}::jsonb, ${JSON.stringify(input.details ?? {})}::jsonb,
            ${input.dedupeKey ?? null})
    on conflict (operator_id, dedupe_key) where dedupe_key is not null and status in ('open', 'acknowledged')
    do nothing
    returning id`.execute(tx);
  return rows[0]?.id ?? null;
}

/** Bucket ids on legs with commitments (anything held, booked, or allotted to a channel). */
export async function legCommitments(tx: Tx, legIds: string[]) {
  if (legIds.length === 0) return [];
  const { rows } = await sql<{
    leg_id: string;
    category_id: string;
    held: number;
    booked: number;
    allotted: number;
  }>`
    select b.leg_id, b.category_id,
           sum(b.held)::int as held, sum(b.booked)::int as booked,
           sum(case when b.kind = 'allotment' then b.total else 0 end)::int as allotted
    from vs.inventory_bucket b
    where b.leg_id = any(${legIds}::uuid[])
    group by b.leg_id, b.category_id
    having sum(b.held) + sum(b.booked) + sum(case when b.kind = 'allotment' then b.total else 0 end) > 0`.execute(
    tx,
  );
  return rows;
}
