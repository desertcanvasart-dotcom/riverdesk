import { sql } from 'kysely';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import type { EngineContext, Tx } from '../internal';

/**
 * Analytics A1.1: the nightly snapshot of what is on the books for every upcoming departure and
 * sailing (docs/analytics-plan.md § 3). Pace screens compare these nights with each other and
 * with the same calendar date a year earlier.
 *
 * The night is the Cairo date of the run time less two hours, so a run at 21:45 UTC writes the
 * same night whether Cairo is at UTC+2 (23:45) or on summer time (00:45 the next day). Running a
 * night again replaces it, so a missed or repeated run is harmless.
 */

/** Departures further ahead than this are not snapshotted (pace beyond a year is noise). */
export const SNAPSHOT_HORIZON_DAYS = 400;
/** The one-time backfill rebuilds at most this many past nights. */
export const BACKFILL_MAX_NIGHTS = 400;

const nightOf = (at: Date) =>
  sql<string>`((${at}::timestamptz - interval '2 hours') at time zone 'Africa/Cairo')::date::text`;

async function writeNight(tx: Tx, operatorId: string, night: string) {
  await tx.deleteFrom('analytics_leg_day').where('snapshot_date', '=', night).execute();
  await tx.deleteFrom('analytics_sailing_day').where('snapshot_date', '=', night).execute();

  const legs = await sql`
    insert into vs.analytics_leg_day (operator_id, snapshot_date, leg_id, category_id, depart_date,
                                      capacity, booked, held, blocked, allotted_unsold, stop_sale)
    select ${operatorId}::uuid, ${night}::date, b.leg_id, b.category_id, l.depart_date,
           coalesce(sum(b.total) filter (where b.kind in ('pool', 'allotment')), 0)::int,
           coalesce(sum(b.booked) filter (where b.kind in ('pool', 'allotment')), 0)::int,
           coalesce(sum(b.held) filter (where b.kind in ('pool', 'allotment')), 0)::int,
           coalesce(sum(b.total) filter (where b.kind = 'block' and b.released_at is null), 0)::int,
           coalesce(sum(greatest(b.total - b.held - b.booked, 0))
             filter (where b.kind = 'allotment' and b.released_at is null), 0)::int,
           coalesce(bool_or(b.stop_sale) filter (where b.kind = 'pool'), false)
    from vs.inventory_bucket b
    join vs.leg l on l.id = b.leg_id
    where l.depart_date >= ${night}::date
      and l.depart_date < ${night}::date + ${SNAPSHOT_HORIZON_DAYS}::int
      and l.status <> 'cancelled'
    group by b.leg_id, b.category_id, l.depart_date`.execute(tx);

  // Confirmed bookings, open requests and active holds, each grouped by sailing, channel,
  // market and currency, then folded into one row per group.
  const sailings = await sql`
    with confirmed as (
      select b.sailing_id, b.channel_id, b.market, b.currency,
             count(distinct b.id)::int as bookings,
             count(bc.id)::int as cabins,
             coalesce(sum(bc.adults + cardinality(bc.child_ages)), 0)::int as guests,
             (count(bc.id) * max(s.nights))::int as cabin_nights,
             0::int as requests_open, 0::int as holds_open
      from vs.booking b
      join vs.sailing s on s.id = b.sailing_id
      left join vs.booking_cabin bc on bc.booking_id = b.id and bc.status = 'active'
      where b.status = 'confirmed' and s.embark_date >= ${night}::date
      group by b.sailing_id, b.channel_id, b.market, b.currency
    ),
    money as (
      select b.sailing_id, b.channel_id, b.market, b.currency,
             sum(b.total)::bigint as value_total, sum(b.net_total)::bigint as value_net
      from vs.booking b join vs.sailing s on s.id = b.sailing_id
      where b.status = 'confirmed' and s.embark_date >= ${night}::date
      group by b.sailing_id, b.channel_id, b.market, b.currency
    ),
    pipeline as (
      select b.sailing_id, b.channel_id, b.market, b.currency,
             count(*) filter (where b.status = 'requested')::int as requests_open, 0 as holds_open
      from vs.booking b join vs.sailing s on s.id = b.sailing_id
      where b.status = 'requested' and s.embark_date >= ${night}::date
      group by b.sailing_id, b.channel_id, b.market, b.currency
      union all
      select q.sailing_id, h.channel_id, q.market, q.currency, 0, count(*)::int
      from vs.hold h join vs.quote q on q.id = h.quote_id join vs.sailing s on s.id = q.sailing_id
      where h.status = 'active' and s.embark_date >= ${night}::date
      group by q.sailing_id, h.channel_id, q.market, q.currency
    ),
    keys as (
      select sailing_id, channel_id, market, currency from confirmed
      union select sailing_id, channel_id, market, currency from pipeline
    )
    insert into vs.analytics_sailing_day (operator_id, snapshot_date, sailing_id, embark_date, channel_id,
                                          market, currency, bookings, cabins, guests, cabin_nights,
                                          value_total, value_net, requests_open, holds_open)
    select ${operatorId}::uuid, ${night}::date, k.sailing_id, s.embark_date, k.channel_id, k.market, k.currency,
           coalesce(c.bookings, 0), coalesce(c.cabins, 0), coalesce(c.guests, 0), coalesce(c.cabin_nights, 0),
           coalesce(m.value_total, 0), coalesce(m.value_net, 0),
           coalesce((select sum(p.requests_open) from pipeline p where (p.sailing_id, p.channel_id, p.market, p.currency)
                     = (k.sailing_id, k.channel_id, k.market, k.currency)), 0)::int,
           coalesce((select sum(p.holds_open) from pipeline p where (p.sailing_id, p.channel_id, p.market, p.currency)
                     = (k.sailing_id, k.channel_id, k.market, k.currency)), 0)::int
    from keys k
    join vs.sailing s on s.id = k.sailing_id
    left join confirmed c using (sailing_id, channel_id, market, currency)
    left join money m using (sailing_id, channel_id, market, currency)`.execute(tx);

  return {
    legRows: Number(legs.numAffectedRows ?? 0),
    sailingRows: Number(sailings.numAffectedRows ?? 0),
  };
}

/** Takes tonight's snapshot (worker, nightly). `at` is for tests; the real time by default. */
export async function takeAnalyticsSnapshot(
  db: VsDatabase,
  ctx: EngineContext,
  at: Date = new Date(),
) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const night = (await sql<{ night: string }>`select ${nightOf(at)} as night`.execute(tx))
      .rows[0]!.night;
    const written = await writeNight(tx, ctx.operatorId, night);
    return { night, ...written };
  });
}

/**
 * Once per company, before its first snapshot: past nights rebuilt from booking dates (a booking
 * counts from the night it was confirmed until the night it was cancelled; its cabins on a
 * departure from when they were booked until released). Holds, blocks, requests and amendments of
 * those nights are not known, so the rows are marked `reconstructed`. Departure capacity uses
 * today's numbers. Does nothing if the company already has snapshot rows.
 */
export async function backfillAnalytics(db: VsDatabase, ctx: EngineContext, at: Date = new Date()) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const existing = await tx
      .selectFrom('analytics_sailing_day')
      .select('snapshot_date')
      .unionAll(tx.selectFrom('analytics_leg_day').select('snapshot_date'))
      .limit(1)
      .execute();
    if (existing.length > 0) return { nights: 0, legRows: 0, sailingRows: 0 };
    const { rows } = await sql<{ first: string | null; last: string }>`
      select greatest(min((b.confirmed_at at time zone 'Africa/Cairo')::date),
                      ${nightOf(at)}::date - ${BACKFILL_MAX_NIGHTS}::int)::text as first,
             (${nightOf(at)}::date - 1)::text as last
      from vs.booking b where b.confirmed_at is not null`.execute(tx);
    const { first, last } = rows[0]!;
    if (!first || first > last) return { nights: 0, legRows: 0, sailingRows: 0 };

    const legs = await sql`
      with nights as (select n::date as night from generate_series(${first}::date, ${last}::date, interval '1 day') n),
      capacity as (
        select b.leg_id, b.category_id, sum(b.total) filter (where b.kind in ('pool', 'allotment'))::int as capacity
        from vs.inventory_bucket b group by b.leg_id, b.category_id
      )
      insert into vs.analytics_leg_day (operator_id, snapshot_date, leg_id, category_id, depart_date,
                                        capacity, booked, held, blocked, allotted_unsold, reconstructed)
      select ${ctx.operatorId}::uuid, n.night, bl.leg_id, bl.category_id, l.depart_date,
             coalesce(max(c.capacity), 0), count(*)::int, 0, 0, 0, true
      from nights n
      join vs.booking_line bl on (bl.created_at at time zone 'Africa/Cairo')::date <= n.night
        and (bl.released_at is null or (bl.released_at at time zone 'Africa/Cairo')::date > n.night)
      join vs.booking b on b.id = bl.booking_id and b.confirmed_at is not null
        and (b.confirmed_at at time zone 'Africa/Cairo')::date <= n.night
      join vs.leg l on l.id = bl.leg_id and l.depart_date >= n.night
        and l.depart_date < n.night + ${SNAPSHOT_HORIZON_DAYS}::int
      left join capacity c on c.leg_id = bl.leg_id and c.category_id = bl.category_id
      group by n.night, bl.leg_id, bl.category_id, l.depart_date`.execute(tx);

    const sailings = await sql`
      with nights as (select n::date as night from generate_series(${first}::date, ${last}::date, interval '1 day') n)
      insert into vs.analytics_sailing_day (operator_id, snapshot_date, sailing_id, embark_date, channel_id,
                                            market, currency, bookings, cabins, guests, cabin_nights,
                                            value_total, value_net, reconstructed)
      select ${ctx.operatorId}::uuid, n.night, b.sailing_id, s.embark_date, b.channel_id, b.market, b.currency,
             count(*)::int,
             sum(c.cabins)::int, sum(c.guests)::int, sum(c.cabins * s.nights)::int,
             sum(b.total)::bigint, sum(b.net_total)::bigint, true
      from nights n
      join vs.booking b on b.confirmed_at is not null
        and (b.confirmed_at at time zone 'Africa/Cairo')::date <= n.night
        and (b.cancelled_at is null or (b.cancelled_at at time zone 'Africa/Cairo')::date > n.night)
      join vs.sailing s on s.id = b.sailing_id and s.embark_date >= n.night
      cross join lateral (
        select count(*)::int as cabins, coalesce(sum(bc.adults + cardinality(bc.child_ages)), 0)::int as guests
        from vs.booking_cabin bc where bc.booking_id = b.id and bc.status = 'active'
      ) c
      group by n.night, b.sailing_id, s.embark_date, b.channel_id, b.market, b.currency`.execute(
      tx,
    );

    const result = {
      nights: Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000) + 1,
      legRows: Number(legs.numAffectedRows ?? 0),
      sailingRows: Number(sailings.numAffectedRows ?? 0),
    };
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'analytics.backfilled',
      entity: 'operator',
      entityId: ctx.operatorId,
      after: { from: first, to: last, ...result },
    });
    return result;
  });
}
