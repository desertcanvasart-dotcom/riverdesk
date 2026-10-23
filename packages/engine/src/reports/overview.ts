import { sql } from 'kysely';
import type { VsDatabase } from '@vs/db';
import { addDays } from '@vs/shared';
import { getAvailability, type Availability } from '../inventory/availability';
import { cairoToday, type EngineContext } from '../internal';
import { checkInvariants, type InvariantViolation } from '../invariants';

/**
 * Read-only snapshot for the temporary progress page (replaced by the Batch 6 screens). Reads
 * only, inside one tenant transaction; writes nothing.
 */
export interface Overview {
  operator: { name: string; slug: string };
  asOf: Date;
  today: string;
  vessel: { id: string; name: string; code: string } | null;
  counts: {
    legs: number;
    sailings: number;
    activeHolds: number;
    openExceptions: number;
    quotes: number;
    bookingsByStatus: Record<string, number>;
  };
  invariants: InvariantViolation[];
  availability: Availability | null;
  categories: { code: string; name: string; cabins: number }[];
  bookings: {
    ref: string;
    status: string;
    paymentStatus: string;
    channel: string;
    pattern: string | null;
    embarkDate: string;
    cabins: number;
    guests: number;
    total: string;
    currency: string;
    revision: number;
    createdAt: Date;
  }[];
  holds: { kind: string; channel: string; embarkDate: string; cabins: number; expiresAt: Date }[];
  quotes: {
    channel: string;
    pattern: string | null;
    embarkDate: string;
    total: string;
    currency: string;
    expiresAt: Date;
    expired: boolean;
  }[];
  exceptions: { kind: string; severity: string; summary: string; createdAt: Date }[];
}

export async function getOverview(
  db: VsDatabase,
  ctx: EngineContext,
  options: { weeks?: number } = {},
): Promise<Overview> {
  const vessel = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx.selectFrom('vessel').select(['id', 'name', 'code']).orderBy('created_at').executeTakeFirst(),
  );
  const today = await db.withLookupTx((tx) => cairoToday(tx));
  const availability = vessel
    ? await getAvailability(db, ctx, {
        vesselId: vessel.id,
        from: today,
        to: addDays(today, (options.weeks ?? 6) * 7 - 1),
      })
    : null;

  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const operator = await tx
      .selectFrom('operator')
      .select(['name', 'slug'])
      .executeTakeFirstOrThrow();
    const one = async (query: ReturnType<typeof sql<{ n: number }>>) =>
      (await query.execute(tx)).rows[0]?.n ?? 0;
    const statuses = await sql<{
      status: string;
      n: number;
    }>`select status, count(*)::int as n from vs.booking group by status`.execute(tx);
    const categories = await sql<{ code: string; name: string; cabins: number }>`
      select c.code, c.name_en as name,
             (select count(*)::int from vs.cabin_period p where p.category_id = c.id and p.during @> ${today}::date) as cabins
      from vs.cabin_category c order by c.sort_order, c.code`.execute(tx);
    const bookings = await sql<Overview['bookings'][number]>`
      select b.ref, b.status, b.payment_status as "paymentStatus", ch.name as channel, sp.code as pattern, s.embark_date::text as "embarkDate",
             (select count(*)::int from vs.booking_cabin bc where bc.booking_id = b.id and bc.status = 'active') as cabins,
             (select count(*)::int from vs.guest g where g.booking_id = b.id) as guests,
             b.total::text as total, b.currency, b.revision, b.created_at as "createdAt"
      from vs.booking b
      join vs.channel ch on ch.id = b.channel_id
      join vs.sailing s on s.id = b.sailing_id
      left join vs.sailing_pattern sp on sp.id = s.pattern_id
      order by b.created_at desc limit 25`.execute(tx);
    const holds = await sql<Overview['holds'][number]>`
      select h.kind, ch.name as channel, s.embark_date::text as "embarkDate",
             jsonb_array_length(q.cabins) as cabins, h.expires_at as "expiresAt"
      from vs.hold h join vs.channel ch on ch.id = h.channel_id
      join vs.quote q on q.id = h.quote_id join vs.sailing s on s.id = q.sailing_id
      where h.status = 'active' order by h.expires_at limit 25`.execute(tx);
    const quotes = await sql<Overview['quotes'][number]>`
      select ch.name as channel, sp.code as pattern, s.embark_date::text as "embarkDate", q.total::text as total,
             q.currency, q.expires_at as "expiresAt", q.expires_at <= now() as expired
      from vs.quote q join vs.channel ch on ch.id = q.channel_id join vs.sailing s on s.id = q.sailing_id
      left join vs.sailing_pattern sp on sp.id = s.pattern_id
      order by q.created_at desc limit 15`.execute(tx);
    const exceptions = await sql<Overview['exceptions'][number]>`
      select kind, severity, summary, created_at as "createdAt" from vs.exception
      where status in ('open', 'acknowledged') order by created_at desc limit 25`.execute(tx);
    return {
      operator,
      asOf: availability?.asOf ?? new Date(),
      today,
      vessel: vessel ?? null,
      counts: {
        legs: await one(
          sql`select count(*)::int as n from vs.leg where status = 'open' and depart_date >= ${today}::date`,
        ),
        sailings: await one(
          sql`select count(*)::int as n from vs.sailing where status = 'open' and embark_date >= ${today}::date`,
        ),
        activeHolds: await one(sql`select count(*)::int as n from vs.hold where status = 'active'`),
        openExceptions: await one(
          sql`select count(*)::int as n from vs.exception where status in ('open', 'acknowledged')`,
        ),
        quotes: await one(sql`select count(*)::int as n from vs.quote`),
        bookingsByStatus: Object.fromEntries(statuses.rows.map((r) => [r.status, r.n])),
      },
      invariants: await checkInvariants(tx),
      availability,
      categories: categories.rows,
      bookings: bookings.rows,
      holds: holds.rows,
      quotes: quotes.rows,
      exceptions: exceptions.rows,
    };
  });
}
