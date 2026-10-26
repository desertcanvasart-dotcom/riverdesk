import { sql } from 'kysely';
import { z } from 'zod';
import type { VsDatabase } from '@vs/db';
import { cairoToday, parseInput, type EngineContext } from '../internal';

/**
 * Analytics A1.2 (docs/analytics-plan.md § 4.1–4.2): the Overview and Occupancy and pace.
 * Definitions, shown on screen too:
 * - Occupancy = cabin-nights booked ÷ cabin-nights on sale (pool and allotments; blocked cabins
 *   are not on sale), over the departures in range, from live inventory.
 * - Booked in a period = bookings confirmed in it (Cairo dates), whatever happened to them later.
 * - Pace = cabins confirmed for the coming sailings as of a night, from the nightly snapshot.
 * - Last year = the same calendar dates a year earlier.
 * Money is per currency, never added across currencies, and only returned with `withMoney`.
 */

export interface MoneyByCurrency {
  currency: string;
  total: bigint;
  net: bigint;
}

export interface PeriodSales {
  from: string;
  to: string;
  bookings: number;
  cabins: number;
  /** Only with `withMoney`. */
  value?: MoneyByCurrency[];
}

const vesselFilter = z.object({ vesselId: z.uuid().nullish() });
const vesselOf = (input: { vesselId?: string | null }) => input.vesselId ?? null;

export const analyticsOverviewInput = vesselFilter;

export async function analyticsOverview(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof analyticsOverviewInput>,
  options: { withMoney: boolean },
) {
  const data = parseInput(analyticsOverviewInput, input);
  const vessel = vesselOf(data);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const today = await cairoToday(tx);

    // Occupancy over departures in four windows, from live inventory.
    const occupancy = await sql<{
      span: 'next30' | 'next60' | 'next90' | 'last30';
      booked_nights: number;
      sale_nights: number;
    }>`
      with w(span, from_date, to_date) as (values
        ('next30', ${today}::date, ${today}::date + 30),
        ('next60', ${today}::date, ${today}::date + 60),
        ('next90', ${today}::date, ${today}::date + 90),
        ('last30', ${today}::date - 30, ${today}::date))
      select w.span,
             coalesce(sum(b.booked * (l.arrive_date - l.depart_date)), 0)::int as booked_nights,
             coalesce(sum(b.total * (l.arrive_date - l.depart_date)), 0)::int as sale_nights
      from w
      left join vs.leg l on l.depart_date >= w.from_date and l.depart_date < w.to_date
        and l.status <> 'cancelled' and (${vessel}::uuid is null or l.vessel_id = ${vessel}::uuid)
      left join vs.inventory_bucket b on b.leg_id = l.id and b.kind in ('pool', 'allotment')
      group by w.span`.execute(tx);

    // Confirmations in a period, and the same calendar dates a year earlier.
    const sales = async (from: string, to: string): Promise<PeriodSales> => {
      const { rows } = await sql<{
        currency: string;
        bookings: number;
        cabins: number;
        total: string;
        net: string;
      }>`
        select b.currency, count(*)::int as bookings, sum(c.cabins)::int as cabins,
               sum(b.total)::text as total, sum(b.net_total)::text as net
        from vs.booking b
        cross join lateral (
          select count(*)::int as cabins from vs.booking_cabin bc
          where bc.booking_id = b.id and bc.status = 'active') c
        where b.confirmed_at is not null
          and (b.confirmed_at at time zone 'Africa/Cairo')::date between ${from}::date and ${to}::date
          and (${vessel}::uuid is null or b.vessel_id = ${vessel}::uuid)
        group by b.currency`.execute(tx);
      return {
        from,
        to,
        bookings: rows.reduce((n, r) => n + r.bookings, 0),
        cabins: rows.reduce((n, r) => n + r.cabins, 0),
        ...(options.withMoney
          ? {
              value: rows.map((r) => ({
                currency: r.currency,
                total: BigInt(r.total),
                net: BigInt(r.net),
              })),
            }
          : {}),
      };
    };
    const dates = (
      await sql<{
        week_from: string;
        month_from: string;
        ly_today: string;
        ly_week_from: string;
        ly_month_from: string;
      }>`
        select (${today}::date - 6)::text as week_from,
               date_trunc('month', ${today}::date)::date::text as month_from,
               (${today}::date - interval '1 year')::date::text as ly_today,
               (${today}::date - 6 - interval '1 year')::date::text as ly_week_from,
               (date_trunc('month', ${today}::date) - interval '1 year')::date::text as ly_month_from`.execute(
        tx,
      )
    ).rows[0]!;

    // Pace: cabins on the books for sailings embarking in the next 90 days — now (live), and
    // as the snapshot saw them 7 and 28 nights ago.
    const live = await sql<{ cabins: number }>`
      select count(bc.id)::int as cabins
      from vs.booking b join vs.sailing s on s.id = b.sailing_id
      join vs.booking_cabin bc on bc.booking_id = b.id and bc.status = 'active'
      where b.status = 'confirmed' and s.embark_date >= ${today}::date and s.embark_date < ${today}::date + 90
        and (${vessel}::uuid is null or s.vessel_id = ${vessel}::uuid)`.execute(tx);
    const snapshot = async (nightsAgo: number) => {
      const { rows } = await sql<{ nights: number; cabins: number | null }>`
        select count(*)::int as nights, sum(d.cabins)::int as cabins
        from vs.analytics_sailing_day d join vs.sailing s on s.id = d.sailing_id
        where d.snapshot_date = ${today}::date - ${nightsAgo}::int
          and d.embark_date >= ${today}::date and d.embark_date < ${today}::date + 90
          and (${vessel}::uuid is null or s.vessel_id = ${vessel}::uuid)`.execute(tx);
      const has = await sql<{ n: number }>`
        select count(*)::int as n from vs.analytics_leg_day
        where snapshot_date = ${today}::date - ${nightsAgo}::int limit 1`.execute(tx);
      return has.rows[0]!.n > 0 ? (rows[0]!.cabins ?? 0) : null;
    };

    // Requests received in the last 30 days: answered before their deadline, and booked.
    const requests = await sql<{
      received: number;
      answered_in_time: number;
      converted: number;
      pending: number;
    }>`
      with req as (
        select b.id, b.status, b.request_expires_at,
               (select min(a.created_at) from vs.audit_log a
                where a.entity_id = b.id and a.action in ('request.accepted', 'request.declined', 'request.offered')) as answered_at
        from vs.booking b
        where b.created_at > now() - interval '30 days'
          and (${vessel}::uuid is null or b.vessel_id = ${vessel}::uuid)
          and exists (select from vs.audit_log a where a.entity_id = b.id and a.action = 'request.created'))
      select count(*)::int as received,
             count(*) filter (where answered_at is not null and answered_at <= request_expires_at)::int as answered_in_time,
             count(*) filter (where status in ('confirmed', 'completed'))::int as converted,
             count(*) filter (where status = 'requested')::int as pending
      from req`.execute(tx);

    // Cancellations this month against confirmations this month.
    const cancellations = await sql<{ cancelled: number; confirmed: number }>`
      select count(*) filter (where b.cancelled_at is not null
               and (b.cancelled_at at time zone 'Africa/Cairo')::date >= ${dates.month_from}::date)::int as cancelled,
             count(*) filter (where b.confirmed_at is not null
               and (b.confirmed_at at time zone 'Africa/Cairo')::date >= ${dates.month_from}::date)::int as confirmed
      from vs.booking b
      where (${vessel}::uuid is null or b.vessel_id = ${vessel}::uuid)`.execute(tx);

    // The first confirmed booking: before it, "last year" has no data rather than zero sales.
    const history = await sql<{ from: string | null }>`
      select min((b.confirmed_at at time zone 'Africa/Cairo')::date)::text as from
      from vs.booking b where b.confirmed_at is not null
        and (${vessel}::uuid is null or b.vessel_id = ${vessel}::uuid)`.execute(tx);

    return {
      today,
      historyFrom: history.rows[0]?.from ?? null,
      occupancy: Object.fromEntries(
        occupancy.rows.map((r) => [
          r.span,
          { bookedNights: r.booked_nights, saleNights: r.sale_nights },
        ]),
      ) as Record<
        'next30' | 'next60' | 'next90' | 'last30',
        { bookedNights: number; saleNights: number }
      >,
      sales: {
        week: await sales(dates.week_from, today),
        weekLastYear: await sales(dates.ly_week_from, dates.ly_today),
        month: await sales(dates.month_from, today),
        monthLastYear: await sales(dates.ly_month_from, dates.ly_today),
      },
      pace: {
        now: live.rows[0]!.cabins,
        sevenNightsAgo: await snapshot(7),
        twentyEightNightsAgo: await snapshot(28),
      },
      requests: requests.rows[0]!,
      cancellations: cancellations.rows[0]!,
    };
  });
}

export const occupancyReportInput = vesselFilter.extend({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** At most 92 days, so the heat map stays readable. */
  days: z.number().int().min(1).max(92).default(60),
});

/**
 * Sailings embarking in range with their own bookings and the occupancy of their departures,
 * occupancy by cabin category, and a sailings × categories heat map.
 */
export async function occupancyReport(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof occupancyReportInput>,
  options: { withMoney: boolean },
) {
  const data = parseInput(occupancyReportInput, input);
  const vessel = vesselOf(data);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const sailings = await sql<{
      sailingId: string;
      vessel: string;
      embarkDate: string;
      nights: number;
      code: string | null;
      nameEn: string | null;
      nameAr: string | null;
      bookings: number;
      cabins: number;
      bookedNights: number;
      saleNights: number;
      held: number;
    }>`
      select s.id as "sailingId", v.name as vessel, s.embark_date::text as "embarkDate", s.nights,
             sp.code, sp.name_en as "nameEn", sp.name_ar as "nameAr",
             coalesce(own.bookings, 0) as bookings, coalesce(own.cabins, 0) as cabins,
             coalesce(inv.booked_nights, 0) as "bookedNights", coalesce(inv.sale_nights, 0) as "saleNights",
             coalesce(inv.held, 0) as held
      from vs.sailing s
      join vs.vessel v on v.id = s.vessel_id
      left join vs.sailing_pattern sp on sp.id = s.pattern_id
      left join lateral (
        select count(distinct b.id)::int as bookings, count(bc.id)::int as cabins
        from vs.booking b join vs.booking_cabin bc on bc.booking_id = b.id and bc.status = 'active'
        where b.sailing_id = s.id and b.status = 'confirmed') own on true
      left join lateral (
        select sum(bk.booked * (l.arrive_date - l.depart_date))::int as booked_nights,
               sum(bk.total * (l.arrive_date - l.depart_date))::int as sale_nights,
               sum(bk.held)::int as held
        from vs.sailing_leg sl join vs.leg l on l.id = sl.leg_id
        join vs.inventory_bucket bk on bk.leg_id = l.id and bk.kind in ('pool', 'allotment')
        where sl.sailing_id = s.id) inv on true
      where s.embark_date >= ${data.from}::date and s.embark_date < ${data.from}::date + ${data.days}::int
        and s.status <> 'cancelled' and (${vessel}::uuid is null or s.vessel_id = ${vessel}::uuid)
      order by s.embark_date, v.name, s.nights`.execute(tx);
    const ids = sailings.rows.map((r) => r.sailingId);
    const money =
      options.withMoney && ids.length
        ? (
            await sql<{ sailingId: string; currency: string; total: string; net: string }>`
              select b.sailing_id as "sailingId", b.currency, sum(b.total)::text as total, sum(b.net_total)::text as net
              from vs.booking b where b.sailing_id = any(${ids}::uuid[]) and b.status = 'confirmed'
              group by b.sailing_id, b.currency`.execute(tx)
          ).rows
        : [];

    // Departures in range (by date), by category: the heat map and the category totals.
    const cells = await sql<{
      sailingId: string;
      categoryId: string;
      bookedNights: number;
      saleNights: number;
    }>`
      select sl.sailing_id as "sailingId", bk.category_id as "categoryId",
             sum(bk.booked * (l.arrive_date - l.depart_date))::int as "bookedNights",
             sum(bk.total * (l.arrive_date - l.depart_date))::int as "saleNights"
      from vs.sailing_leg sl join vs.leg l on l.id = sl.leg_id
      join vs.inventory_bucket bk on bk.leg_id = l.id and bk.kind in ('pool', 'allotment')
      where sl.sailing_id = any(${ids}::uuid[])
      group by sl.sailing_id, bk.category_id`.execute(tx);
    const categories = await sql<{
      categoryId: string;
      code: string;
      nameEn: string;
      nameAr: string;
      bookedNights: number;
      saleNights: number;
    }>`
      select c.id as "categoryId", c.code, c.name_en as "nameEn", c.name_ar as "nameAr",
             coalesce(sum(bk.booked * (l.arrive_date - l.depart_date)), 0)::int as "bookedNights",
             coalesce(sum(bk.total * (l.arrive_date - l.depart_date)), 0)::int as "saleNights"
      from vs.cabin_category c
      join vs.inventory_bucket bk on bk.category_id = c.id and bk.kind in ('pool', 'allotment')
      join vs.leg l on l.id = bk.leg_id
      where l.depart_date >= ${data.from}::date and l.depart_date < ${data.from}::date + ${data.days}::int
        and l.status <> 'cancelled' and (${vessel}::uuid is null or l.vessel_id = ${vessel}::uuid)
      group by c.id, c.code, c.name_en, c.name_ar, c.sort_order
      order by c.sort_order, c.code`.execute(tx);

    return {
      from: data.from,
      days: data.days,
      sailings: sailings.rows.map((s) => ({
        ...s,
        ...(options.withMoney
          ? {
              value: money
                .filter((m) => m.sailingId === s.sailingId)
                .map((m) => ({ currency: m.currency, total: BigInt(m.total), net: BigInt(m.net) })),
            }
          : {}),
      })),
      categories: categories.rows,
      cells: cells.rows,
    };
  });
}

export const sailingPaceInput = z.object({ sailingId: z.uuid() });

/**
 * One sailing's pace: cabins confirmed night by night, by days before embarkation, from the
 * snapshot; and the same for the sailings of the same vessel that embarked on the same calendar
 * date a year earlier (if any). Reconstructed nights are marked.
 */
export async function sailingPace(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof sailingPaceInput>,
) {
  const data = parseInput(sailingPaceInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const sailing = await tx
      .selectFrom('sailing')
      .select(['id', 'vessel_id', sql<string>`embark_date::text`.as('embark_date')])
      .where('id', '=', data.sailingId)
      .executeTakeFirst();
    if (!sailing) return { embarkDate: null, lastYearDate: null, current: [], lastYear: [] };
    const series = async (ids: string[], embark: string) =>
      ids.length === 0
        ? []
        : (
            await sql<{ daysBefore: number; cabins: number; reconstructed: boolean }>`
              select (${embark}::date - d.snapshot_date)::int as "daysBefore",
                     sum(d.cabins)::int as cabins, bool_or(d.reconstructed) as reconstructed
              from vs.analytics_sailing_day d
              where d.sailing_id = any(${ids}::uuid[]) and d.snapshot_date <= ${embark}::date
              group by d.snapshot_date
              order by d.snapshot_date`.execute(tx)
          ).rows;
    const lastYear = await sql<{ id: string; embark: string }>`
      select s.id, s.embark_date::text as embark from vs.sailing s
      where s.vessel_id = ${sailing.vessel_id}
        and s.embark_date = (${sailing.embark_date}::date - interval '1 year')::date`.execute(tx);
    const lastYearDate = lastYear.rows[0]?.embark ?? null;
    return {
      embarkDate: sailing.embark_date,
      lastYearDate,
      current: await series([sailing.id], sailing.embark_date),
      lastYear: lastYearDate
        ? await series(
            lastYear.rows.map((r) => r.id),
            lastYearDate,
          )
        : [],
    };
  });
}
