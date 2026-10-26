import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { parseInput, type EngineContext } from '../internal';

/**
 * Analytics A1.3 (docs/analytics-plan.md § 4.3–4.4): channels and markets, and booking behaviour.
 * One filter for both: the period is either when bookings were confirmed (`booked`) or when
 * their sailings embark (`sailing`), both in Cairo dates; then vessel, channel, market and cabin
 * category. Bookings count whatever happened to them later (a cancelled booking is still a
 * booking, and shows in the cancellation figures). Money is per currency and only `withMoney`.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const analyticsFilterInput = z
  .object({
    from: date,
    to: date,
    basis: z.enum(['booked', 'sailing']).default('booked'),
    vesselId: z.uuid().nullish(),
    channelId: z.uuid().nullish(),
    market: z.string().min(1).max(32).nullish(),
    categoryId: z.uuid().nullish(),
  })
  .refine((f) => f.from <= f.to, { message: 'from must be on or before to' });
export type AnalyticsFilter = z.output<typeof analyticsFilterInput>;

const MAX_DAYS = 400;

function parseFilter(input: z.input<typeof analyticsFilterInput>): AnalyticsFilter {
  const f = parseInput(analyticsFilterInput, input);
  if ((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000 > MAX_DAYS)
    throw new DomainError('VALIDATION_FAILED', {
      message: `A period of at most ${MAX_DAYS} days`,
      details: { field: 'to' },
    });
  return f;
}

/** The bookings in scope, as a SQL condition on `b` (booking) and `s` (its sailing). */
function inScope(f: AnalyticsFilter): RawBuilder<boolean> {
  const period =
    f.basis === 'booked'
      ? sql`(b.confirmed_at at time zone 'Africa/Cairo')::date between ${f.from}::date and ${f.to}::date`
      : sql`s.embark_date between ${f.from}::date and ${f.to}::date`;
  return sql<boolean>`b.confirmed_at is not null and ${period}
    and (${f.vesselId ?? null}::uuid is null or b.vessel_id = ${f.vesselId ?? null}::uuid)
    and (${f.channelId ?? null}::uuid is null or b.channel_id = ${f.channelId ?? null}::uuid)
    and (${f.market ?? null}::text is null or b.market = ${f.market ?? null}::text)
    and (${f.categoryId ?? null}::uuid is null or exists (
      select from vs.booking_cabin fc where fc.booking_id = b.id and fc.category_id = ${f.categoryId ?? null}::uuid))`;
}

/** Bookings in scope with their cabins and guests (all cabins still on the booking). */
const scoped = (f: AnalyticsFilter) => sql`
  select b.id, b.channel_id, b.market, b.currency, b.total, b.net_total, b.status, b.penalty_amount,
         b.confirmed_at, b.cancelled_at, s.embark_date, s.nights, s.pattern_id,
         c.cabins, c.guests, c.with_children
  from vs.booking b
  join vs.sailing s on s.id = b.sailing_id
  cross join lateral (
    select count(*)::int as cabins,
           coalesce(sum(bc.adults + cardinality(bc.child_ages)), 0)::int as guests,
           bool_or(cardinality(bc.child_ages) > 0) as with_children
    from vs.booking_cabin bc where bc.booking_id = b.id and bc.status = 'active') c
  where ${inScope(f)}`;

export interface CurrencyAmount {
  currency: string;
  amount: bigint;
}

const toMoney = (rows: { currency: string; amount: string }[]): CurrencyAmount[] =>
  rows.map((r) => ({ currency: r.currency, amount: BigInt(r.amount) }));

/** Per channel, per market, per guest nationality, and agency allotments. */
export async function channelsReport(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof analyticsFilterInput>,
  options: { withMoney: boolean },
) {
  const f = parseFilter(input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const channels = await sql<{
      channelId: string;
      name: string;
      type: string;
      bookings: number;
      cabins: number;
      cabinNights: number;
      cancelled: number;
    }>`
      with x as (${scoped(f)})
      select ch.id as "channelId", ch.name, ch.type, count(*)::int as bookings,
             sum(x.cabins)::int as cabins, sum(x.cabins * x.nights)::int as "cabinNights",
             count(*) filter (where x.cancelled_at is not null)::int as cancelled
      from x join vs.channel ch on ch.id = x.channel_id
      group by ch.id, ch.name, ch.type
      order by cabins desc, ch.name`.execute(tx);
    const channelMoney = options.withMoney
      ? (
          await sql<{
            channelId: string;
            currency: string;
            total: string;
            net: string;
            cabinNights: number;
          }>`
            with x as (${scoped(f)})
            select x.channel_id as "channelId", x.currency, sum(x.total)::text as total,
                   sum(x.net_total)::text as net, sum(x.cabins * x.nights)::int as "cabinNights"
            from x group by x.channel_id, x.currency`.execute(tx)
        ).rows
      : [];

    // Requests per channel: received in the period (by request date, or by embarkation),
    // answered within how many minutes (median), and how many became bookings.
    const requestPeriod =
      f.basis === 'booked'
        ? sql`(b.created_at at time zone 'Africa/Cairo')::date between ${f.from}::date and ${f.to}::date`
        : sql`s.embark_date between ${f.from}::date and ${f.to}::date`;
    const requests = await sql<{
      channelId: string;
      received: number;
      converted: number;
      medianMinutes: number | null;
    }>`
      with req as (
        select b.id, b.channel_id, b.status, b.created_at,
               (select min(a.created_at) from vs.audit_log a
                where a.entity_id = b.id and a.action in ('request.accepted', 'request.declined', 'request.offered')) as answered_at
        from vs.booking b join vs.sailing s on s.id = b.sailing_id
        where ${requestPeriod}
          and (${f.vesselId ?? null}::uuid is null or b.vessel_id = ${f.vesselId ?? null}::uuid)
          and (${f.channelId ?? null}::uuid is null or b.channel_id = ${f.channelId ?? null}::uuid)
          and (${f.market ?? null}::text is null or b.market = ${f.market ?? null}::text)
          and exists (select from vs.audit_log a where a.entity_id = b.id and a.action = 'request.created'))
      select channel_id as "channelId", count(*)::int as received,
             count(*) filter (where status in ('confirmed', 'completed'))::int as converted,
             round((percentile_cont(0.5) within group (order by extract(epoch from answered_at - created_at)) / 60)::numeric, 0)::int as "medianMinutes"
      from req group by channel_id`.execute(tx);

    const markets = await sql<{
      market: string;
      bookings: number;
      cabins: number;
      guests: number;
      withChildren: number;
    }>`
      with x as (${scoped(f)})
      select x.market, count(*)::int as bookings, sum(x.cabins)::int as cabins, sum(x.guests)::int as guests,
             count(*) filter (where x.with_children)::int as "withChildren"
      from x group by x.market order by cabins desc, x.market`.execute(tx);
    const marketMoney = options.withMoney
      ? (
          await sql<{ market: string; currency: string; amount: string }>`
            with x as (${scoped(f)})
            select x.market, x.currency, sum(x.total)::text as amount from x group by x.market, x.currency`.execute(
            tx,
          )
        ).rows
      : [];
    const marketNames = await tx
      .selectFrom('market')
      .select(['code', 'name_en as nameEn', 'name_ar as nameAr'])
      .execute();

    const nationalities = await sql<{
      nationality: string | null;
      guests: number;
      bookings: number;
    }>`
      with x as (${scoped(f)})
      select g.nationality, count(*)::int as guests, count(distinct g.booking_id)::int as bookings
      from x join vs.guest g on g.booking_id = x.id
      group by g.nationality order by guests desc, g.nationality nulls last`.execute(tx);

    // Agency allotments on departures in the period (by departure date, whatever the basis).
    const allotments = await sql<{
      channelId: string;
      name: string;
      allotted: number;
      sold: number;
      held: number;
      released: number;
      open: number;
    }>`
      with b as (
        select bk.*, a.channel_id,
               coalesce((select -sum(e.delta_total) from vs.inventory_event e
                         where e.bucket_id = bk.id and e.delta_total < 0 and e.created_at = bk.released_at), 0) as released_unsold
        from vs.inventory_bucket bk
        join vs.allotment a on a.id = bk.allotment_id
        join vs.leg l on l.id = bk.leg_id
        where bk.kind = 'allotment' and l.depart_date between ${f.from}::date and ${f.to}::date
          and (${f.vesselId ?? null}::uuid is null or l.vessel_id = ${f.vesselId ?? null}::uuid)
          and (${f.channelId ?? null}::uuid is null or a.channel_id = ${f.channelId ?? null}::uuid)
          and (${f.categoryId ?? null}::uuid is null or bk.category_id = ${f.categoryId ?? null}::uuid))
      select ch.id as "channelId", ch.name,
             (sum(b.total) + sum(b.released_unsold))::int as allotted, sum(b.booked)::int as sold,
             sum(b.held)::int as held, sum(b.released_unsold)::int as released,
             sum(greatest(b.total - b.held - b.booked, 0)) filter (where b.released_at is null)::int as open
      from b join vs.channel ch on ch.id = b.channel_id
      group by ch.id, ch.name order by allotted desc, ch.name`.execute(tx);

    // A channel that only sent requests in the period still gets its row.
    const requestOnly = requests.rows
      .map((r) => r.channelId)
      .filter((id) => !channels.rows.some((c) => c.channelId === id));
    if (requestOnly.length) {
      const extra = await tx
        .selectFrom('channel')
        .select(['id as channelId', 'name', 'type'])
        .where('id', 'in', requestOnly)
        .execute();
      channels.rows.push(
        ...extra.map((c) => ({ ...c, bookings: 0, cabins: 0, cabinNights: 0, cancelled: 0 })),
      );
    }

    return {
      filter: f,
      channels: channels.rows.map((c) => {
        const r = requests.rows.find((x) => x.channelId === c.channelId);
        return {
          ...c,
          requests: r
            ? { received: r.received, converted: r.converted, medianMinutes: r.medianMinutes }
            : null,
          ...(options.withMoney
            ? {
                value: channelMoney
                  .filter((m) => m.channelId === c.channelId)
                  .map((m) => ({
                    currency: m.currency,
                    total: BigInt(m.total),
                    net: BigInt(m.net),
                    cabinNights: m.cabinNights,
                  })),
              }
            : {}),
        };
      }),
      markets: markets.rows.map((m) => {
        const name = marketNames.find((n) => n.code === m.market);
        return {
          ...m,
          nameEn: name?.nameEn ?? m.market,
          nameAr: name?.nameAr ?? m.market,
          ...(options.withMoney
            ? {
                value: toMoney(marketMoney.filter((x) => x.market === m.market)),
              }
            : {}),
        };
      }),
      nationalities: nationalities.rows,
      allotments: allotments.rows,
    };
  });
}

/** Booking windows, cruise lengths, itineraries, holds, cancellations and amendments. */
export async function behaviourReport(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof analyticsFilterInput>,
  options: { withMoney: boolean },
) {
  const f = parseFilter(input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    // Days between confirmation (Cairo date) and embarkation, in bands.
    const windows = await sql<{ band: string; bookings: number }>`
      with x as (${scoped(f)}),
      d as (select (x.embark_date - (x.confirmed_at at time zone 'Africa/Cairo')::date) as days from x)
      select case when days <= 7 then '0-7' when days <= 14 then '8-14' when days <= 30 then '15-30'
                  when days <= 60 then '31-60' when days <= 90 then '61-90' when days <= 180 then '91-180'
                  else '181+' end as band, count(*)::int as bookings
      from d group by 1`.execute(tx);
    const windowStats = await sql<{ median: number | null; average: number | null }>`
      with x as (${scoped(f)})
      select percentile_cont(0.5) within group (order by (x.embark_date - (x.confirmed_at at time zone 'Africa/Cairo')::date))::int as median,
             round(avg(x.embark_date - (x.confirmed_at at time zone 'Africa/Cairo')::date))::int as average
      from x`.execute(tx);

    const lengths = await sql<{ nights: number; bookings: number; cabins: number }>`
      with x as (${scoped(f)})
      select x.nights, count(*)::int as bookings, sum(x.cabins)::int as cabins
      from x group by x.nights order by x.nights`.execute(tx);
    const itineraries = await sql<{
      code: string | null;
      nameEn: string | null;
      nameAr: string | null;
      nights: number;
      bookings: number;
      cabins: number;
    }>`
      with x as (${scoped(f)})
      select sp.code, sp.name_en as "nameEn", sp.name_ar as "nameAr", x.nights,
             count(*)::int as bookings, sum(x.cabins)::int as cabins
      from x left join vs.sailing_pattern sp on sp.id = x.pattern_id
      group by sp.code, sp.name_en, sp.name_ar, x.nights
      order by cabins desc, sp.code nulls last limit 10`.execute(tx);

    // Holds placed in the period (or for sailings embarking in it).
    const holdPeriod =
      f.basis === 'booked'
        ? sql`(h.created_at at time zone 'Africa/Cairo')::date between ${f.from}::date and ${f.to}::date`
        : sql`s.embark_date between ${f.from}::date and ${f.to}::date`;
    const holds = await sql<{
      kind: string;
      placed: number;
      confirmed: number;
      expired: number;
      released: number;
      active: number;
      averageHours: number | null;
    }>`
      select h.kind, count(*)::int as placed,
             count(*) filter (where h.status = 'confirmed')::int as confirmed,
             count(*) filter (where h.status = 'expired')::int as expired,
             count(*) filter (where h.status = 'released')::int as released,
             count(*) filter (where h.status = 'active')::int as active,
             round(avg(extract(epoch from h.ended_at - h.created_at) / 3600) filter (where h.ended_at is not null)::numeric, 1)::float as "averageHours"
      from vs.hold h join vs.quote q on q.id = h.quote_id join vs.sailing s on s.id = q.sailing_id
      where ${holdPeriod}
        and (${f.vesselId ?? null}::uuid is null or s.vessel_id = ${f.vesselId ?? null}::uuid)
        and (${f.channelId ?? null}::uuid is null or h.channel_id = ${f.channelId ?? null}::uuid)
        and (${f.market ?? null}::text is null or q.market = ${f.market ?? null}::text)
      group by h.kind order by placed desc`.execute(tx);

    // Cancellations of bookings in scope: how long before embarkation.
    const cancellations = await sql<{ band: string; bookings: number }>`
      with x as (${scoped(f)}),
      d as (select (x.embark_date - (x.cancelled_at at time zone 'Africa/Cairo')::date) as days
            from x where x.cancelled_at is not null)
      select case when days <= 7 then '0-7' when days <= 14 then '8-14' when days <= 30 then '15-30'
                  when days <= 60 then '31-60' when days <= 90 then '61-90' when days <= 180 then '91-180'
                  else '181+' end as band, count(*)::int as bookings
      from d group by 1`.execute(tx);
    const penalties = options.withMoney
      ? toMoney(
          (
            await sql<{ currency: string; amount: string }>`
              with x as (${scoped(f)})
              select x.currency, coalesce(sum(x.penalty_amount), 0)::text as amount
              from x where x.cancelled_at is not null group by x.currency`.execute(tx)
          ).rows,
        )
      : undefined;

    // Amendments of bookings in scope: what changed, and the fees charged.
    const amendments = await sql<{ change: string; amendments: number }>`
      with x as (${scoped(f)})
      select ch.value as change, count(*)::int as amendments
      from x join vs.booking_revision r on r.booking_id = x.id and r.reason like 'amendment%'
      cross join lateral jsonb_array_elements_text(coalesce(r.snapshot -> 'changes', '[]'::jsonb)) ch
      group by ch.value order by amendments desc`.execute(tx);
    const amendmentTotals = await sql<{ amendments: number; bookings: number }>`
      with x as (${scoped(f)})
      select count(*)::int as amendments, count(distinct r.booking_id)::int as bookings
      from x join vs.booking_revision r on r.booking_id = x.id and r.reason like 'amendment%'`.execute(
      tx,
    );
    const fees = options.withMoney
      ? toMoney(
          (
            await sql<{ currency: string; amount: string }>`
              with x as (${scoped(f)})
              select r.currency, sum(r.fee)::text as amount
              from x join vs.booking_revision r on r.booking_id = x.id and r.reason like 'amendment%'
              group by r.currency having sum(r.fee) > 0`.execute(tx)
          ).rows,
        )
      : undefined;

    const bands = ['0-7', '8-14', '15-30', '31-60', '61-90', '91-180', '181+'];
    const inBands = (rows: { band: string; bookings: number }[]) =>
      bands.map((band) => ({ band, bookings: rows.find((r) => r.band === band)?.bookings ?? 0 }));
    return {
      filter: f,
      bookingWindow: { bands: inBands(windows.rows), ...windowStats.rows[0]! },
      lengths: lengths.rows,
      itineraries: itineraries.rows,
      holds: holds.rows,
      cancellations: {
        bands: inBands(cancellations.rows),
        ...(options.withMoney ? { penalties } : {}),
      },
      amendments: {
        ...amendmentTotals.rows[0]!,
        changes: amendments.rows,
        ...(options.withMoney ? { fees } : {}),
      },
    };
  });
}
