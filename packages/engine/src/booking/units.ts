import { sql } from 'kysely';
import { DomainError } from '@vs/contracts';
import { resolveClearedOversubscriptions } from '../inventory/blocks';
import {
  availabilityChanged,
  lockBuckets,
  recordInventoryEvents,
  type BucketDelta,
  type EngineContext,
  type LockedBucket,
  type Tx,
} from '../internal';

/**
 * Inventory moves for holds and bookings (spec § Taking inventory). Callers lock their owning
 * row (hold or booking) first; these functions then lock buckets in the global order.
 */

export interface UnitNeed {
  legId: string;
  categoryId: string;
  n: number;
}

export interface TakenUnits extends UnitNeed {
  bucketId: string;
  kind: 'pool' | 'allotment';
}

export type CounterField = 'held' | 'booked';

/**
 * Takes n cabins on every (leg, category) in one go, or none: from the channel's allotment if it
 * has free cabins, otherwise from the pool if the contract allows pool sales. A stopped pool
 * bucket (stop sale, invariant violation, emergency block) stops sales on that leg × category
 * for every bucket.
 */
export async function takeUnits(
  tx: Tx,
  ctx: EngineContext,
  options: {
    channelId: string;
    allocation: string;
    needs: UnitNeed[];
    field: CounterField;
    cause: string;
    ref: { entity: string; id: string };
  },
): Promise<TakenUnits[]> {
  const needs = mergeNeeds(options.needs);
  if (needs.length === 0) return [];
  const legIds = [...new Set(needs.map((need) => need.legId))];
  const categoryIds = [...new Set(needs.map((need) => need.categoryId))];

  const legs = await tx
    .selectFrom('leg')
    .select(['id', 'status'])
    .where('id', 'in', legIds)
    .execute();
  if (legs.length !== legIds.length || legs.some((leg) => leg.status !== 'open')) {
    throw new DomainError('SAILING_CLOSED', { details: { legIds } });
  }

  const { rows: candidates } = await sql<{ id: string }>`
    select b.id from vs.inventory_bucket b
    left join vs.allotment a on a.id = b.allotment_id
    where b.leg_id = any(${legIds}::uuid[]) and b.category_id = any(${categoryIds}::uuid[])
      and (b.kind = 'pool'
           or (b.kind = 'allotment' and b.released_at is null and a.channel_id = ${options.channelId} and a.status = 'active'))`.execute(
    tx,
  );
  const locked = await lockBuckets(tx, { bucketIds: candidates.map((c) => c.id) });

  const taken: TakenUnits[] = [];
  for (const need of needs) {
    const here = locked.filter((b) => b.leg_id === need.legId && b.category_id === need.categoryId);
    const pool = here.find((b) => b.kind === 'pool');
    const where = { legId: need.legId, categoryId: need.categoryId, n: need.n };
    if (!pool)
      throw new DomainError('NOT_AVAILABLE', { details: { ...where, reason: 'no_bucket' } });
    if (pool.stop_sale)
      throw new DomainError('NOT_AVAILABLE', { details: { ...where, reason: 'stop_sale' } });
    const free = (b: LockedBucket) => b.total - b.held - b.booked;
    const bucket =
      here.find((b) => b.kind === 'allotment' && free(b) >= need.n) ??
      (options.allocation !== 'allotment' && free(pool) >= need.n ? pool : undefined);
    if (!bucket) {
      throw new DomainError('NOT_AVAILABLE', {
        details: {
          ...where,
          free:
            Math.max(0, free(pool)) +
            here
              .filter((b) => b.kind === 'allotment')
              .reduce((s, b) => s + Math.max(0, free(b)), 0),
        },
      });
    }
    // The guarded counter update from the spec: it can only succeed while the cabins are free.
    const result = await sql`
      update vs.inventory_bucket set ${sql.ref(options.field)} = ${sql.ref(options.field)} + ${need.n}
      where id = ${bucket.id} and total - held - booked >= ${need.n}`.execute(tx);
    if (Number(result.numAffectedRows ?? 0) !== 1)
      throw new DomainError('NOT_AVAILABLE', { details: where });
    bucket[options.field] += need.n;
    taken.push({ ...need, bucketId: bucket.id, kind: bucket.kind as 'pool' | 'allotment' });
  }

  await recordInventoryEvents(
    tx,
    ctx,
    taken.map((t) => ({
      bucketId: t.bucketId,
      legId: t.legId,
      categoryId: t.categoryId,
      [options.field]: t.n,
    })),
    options.cause,
    options.ref,
  );
  await availabilityChanged(
    tx,
    ctx,
    taken.map((t) => t.bucketId),
    options.cause,
  );
  return taken;
}

function mergeNeeds(needs: UnitNeed[]): UnitNeed[] {
  const merged = new Map<string, UnitNeed>();
  for (const need of needs) {
    const key = `${need.legId}|${need.categoryId}`;
    const existing = merged.get(key);
    if (existing) existing.n += need.n;
    else merged.set(key, { ...need });
  }
  return [...merged.values()].filter((need) => need.n > 0);
}

export interface ReleaseUnit {
  bucketId: string;
  n: number;
  field: CounterField;
}

/**
 * Returns cabins: held or booked −= n. A unit leaving an allotment bucket after its release date
 * also moves its total to the pool in the same transaction (spec § Allotments). Over-committed
 * pools recover as commitments leave them.
 */
export async function releaseUnits(
  tx: Tx,
  ctx: EngineContext,
  units: ReleaseUnit[],
  cause: string,
  ref: { entity: string; id: string } | null,
): Promise<void> {
  const wanted = units.filter((u) => u.n > 0);
  if (wanted.length === 0) return;
  const targets = await tx
    .selectFrom('inventory_bucket')
    .select(['id', 'leg_id', 'category_id'])
    .where('id', 'in', [...new Set(wanted.map((u) => u.bucketId))])
    .execute();
  const pools = await tx
    .selectFrom('inventory_bucket')
    .select('id')
    .where('kind', '=', 'pool')
    .where((eb) =>
      eb.or(
        targets.map((t) =>
          eb.and([eb('leg_id', '=', t.leg_id), eb('category_id', '=', t.category_id)]),
        ),
      ),
    )
    .execute();
  const locked = await lockBuckets(tx, {
    bucketIds: [...new Set([...targets.map((t) => t.id), ...pools.map((p) => p.id)])],
  });
  const byId = new Map(locked.map((b) => [b.id, { ...b }]));
  const deltas = new Map<string, BucketDelta>();
  const delta = (b: LockedBucket) => {
    let d = deltas.get(b.id);
    if (!d) {
      d = {
        bucketId: b.id,
        legId: b.leg_id,
        categoryId: b.category_id,
        total: 0,
        held: 0,
        booked: 0,
        overcommit: 0,
      };
      deltas.set(b.id, d);
    }
    return d;
  };
  const poolFor = (b: LockedBucket) =>
    [...byId.values()].find(
      (p) => p.kind === 'pool' && p.leg_id === b.leg_id && p.category_id === b.category_id,
    )!;

  const released = new Set(
    (
      await tx
        .selectFrom('inventory_bucket')
        .select('id')
        .where('id', 'in', [...byId.keys()])
        .where('released_at', 'is not', null)
        .execute()
    ).map((r) => r.id),
  );

  for (const unit of wanted) {
    const bucket = byId.get(unit.bucketId)!;
    if (bucket[unit.field] < unit.n) {
      throw new DomainError('INVARIANT_VIOLATION', {
        details: {
          bucketId: bucket.id,
          field: unit.field,
          has: bucket[unit.field],
          releasing: unit.n,
        },
      });
    }
    bucket[unit.field] -= unit.n;
    delta(bucket)[unit.field]! -= unit.n;
    if (bucket.kind === 'allotment' && released.has(bucket.id)) {
      const pool = poolFor(bucket);
      bucket.total -= unit.n;
      pool.total += unit.n;
      delta(bucket).total! -= unit.n;
      delta(pool).total! += unit.n;
    }
  }

  for (const bucket of byId.values()) {
    if (bucket.kind !== 'pool' || bucket.overcommit === 0) continue;
    const overcommit = Math.min(
      bucket.overcommit,
      Math.max(0, bucket.held + bucket.booked - bucket.total),
    );
    if (overcommit !== bucket.overcommit) {
      delta(bucket).overcommit! += overcommit - bucket.overcommit;
      bucket.overcommit = overcommit;
      if (overcommit === 0 && bucket.stop_reason === 'emergency_block') {
        bucket.stop_sale = false;
        bucket.stop_reason = null;
      }
    }
  }

  for (const id of deltas.keys()) {
    const b = byId.get(id)!;
    await sql`
      update vs.inventory_bucket
      set total = ${b.total}, held = ${b.held}, booked = ${b.booked}, overcommit = ${b.overcommit},
          stop_sale = ${b.stop_sale}, stop_reason = ${b.stop_reason}
      where id = ${id}`.execute(tx);
  }
  await resolveClearedOversubscriptions(
    tx,
    [...byId.values()].filter((b) => b.kind === 'pool').map((b) => b.id),
  );
  await recordInventoryEvents(tx, ctx, [...deltas.values()], cause, ref);
  await availabilityChanged(tx, ctx, [...deltas.keys()], cause);
}

/** Confirm: held −= n, booked += n on the same buckets. */
export async function holdToBooked(
  tx: Tx,
  ctx: EngineContext,
  lines: { bucketId: string; legId: string; categoryId: string; n: number }[],
  cause: string,
  ref: { entity: string; id: string },
): Promise<void> {
  if (lines.length === 0) return;
  await lockBuckets(tx, { bucketIds: [...new Set(lines.map((l) => l.bucketId))] });
  for (const line of lines) {
    const result = await sql`
      update vs.inventory_bucket set held = held - ${line.n}, booked = booked + ${line.n}
      where id = ${line.bucketId} and held >= ${line.n}`.execute(tx);
    if (Number(result.numAffectedRows ?? 0) !== 1) {
      throw new DomainError('INVARIANT_VIOLATION', {
        details: { bucketId: line.bucketId, reason: 'held below hold line' },
      });
    }
  }
  await recordInventoryEvents(
    tx,
    ctx,
    lines.map((l) => ({
      bucketId: l.bucketId,
      legId: l.legId,
      categoryId: l.categoryId,
      held: -l.n,
      booked: l.n,
    })),
    cause,
    ref,
  );
  await availabilityChanged(
    tx,
    ctx,
    lines.map((l) => l.bucketId),
    cause,
  );
}
