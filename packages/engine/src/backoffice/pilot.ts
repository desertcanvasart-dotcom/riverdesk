import { sql } from 'kysely';
import type { VsDatabase } from '@vs/db';
import type { EngineContext } from '../internal';

/**
 * The pilot dashboard (owner only): is the system safe to keep running? Invariant status,
 * oversells (must be 0), how fast requests are answered, and bookings by channel. Last 30 days.
 */
export async function pilotDashboard(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const invariants = await sql<{ invariant: number; n: number }>`
      select invariant, count(*)::int as n from vs.check_invariants()
      where operator_id = ${ctx.operatorId} group by invariant order by invariant`.execute(tx);
    // An oversell: more cabins held or booked than a bucket holds (an emergency block's
    // overcommit on a stopped pool is covered and listed separately).
    const oversells = await sql<{ oversold: number; covered: number }>`
      select count(*) filter (where held + booked > total + overcommit)::int as oversold,
             count(*) filter (where overcommit > 0 and held + booked > total)::int as covered
      from vs.inventory_bucket`.execute(tx);
    const requests = await sql<{
      received: number;
      answered: number;
      pending: number;
      expired: number;
      p50_minutes: number | null;
      p90_minutes: number | null;
    }>`
      with req as (
        select b.id, b.status, b.created_at,
               (select min(a.created_at) from vs.audit_log a
                where a.entity_id = b.id and a.action in ('request.accepted', 'request.declined', 'request.offered')) as answered_at
        from vs.booking b
        where b.created_at > now() - interval '30 days'
          and exists (select from vs.audit_log a where a.entity_id = b.id and a.action = 'request.created'))
      select count(*)::int as received,
             count(answered_at)::int as answered,
             count(*) filter (where answered_at is null and status = 'requested')::int as pending,
             count(*) filter (where answered_at is null and status = 'expired')::int as expired,
             round((percentile_cont(0.5) within group (order by extract(epoch from answered_at - created_at)) / 60)::numeric, 1)::float as p50_minutes,
             round((percentile_cont(0.9) within group (order by extract(epoch from answered_at - created_at)) / 60)::numeric, 1)::float as p90_minutes
      from req`.execute(tx);
    const channels = await sql<{
      channel: string;
      type: string;
      bookings: number;
      confirmed: number;
      cancelled: number;
      requests: number;
    }>`
      select c.name as channel, c.type,
             count(b.id)::int as bookings,
             count(b.id) filter (where b.status in ('confirmed', 'completed'))::int as confirmed,
             count(b.id) filter (where b.status = 'cancelled')::int as cancelled,
             count(b.id) filter (where b.status in ('requested', 'offered'))::int as requests
      from vs.channel c
      left join vs.booking b on b.channel_id = c.id and b.created_at > now() - interval '30 days'
      group by c.id order by count(b.id) desc, c.name`.execute(tx);
    const exceptions = await sql<{ kind: string; n: number }>`
      select kind, count(*)::int as n from vs.exception where status in ('open', 'acknowledged')
      group by kind order by kind`.execute(tx);
    return {
      invariants: invariants.rows,
      oversells: oversells.rows[0]!,
      requests: requests.rows[0]!,
      channels: channels.rows,
      openExceptions: exceptions.rows,
    };
  });
}
