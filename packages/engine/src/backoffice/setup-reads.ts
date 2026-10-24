import { sql } from 'kysely';
import type { VsDatabase } from '@vs/db';
import type { EngineContext } from '../internal';

/** Read models for the inventory, schedule and rates screens. */

export interface InventoryCell {
  categoryId: string;
  /** Pool bucket: cabins in the pool, and what is held or booked from it. */
  pool: { total: number; held: number; booked: number; stopSale: boolean; overcommit: number };
  /** Every unreleased allotment on the leg, summed. */
  allotted: { total: number; held: number; booked: number };
  blocked: number;
  free: number;
}

export interface InventoryLeg {
  id: string;
  departDate: string;
  arriveDate: string;
  from: string;
  to: string;
  status: string;
  cells: InventoryCell[];
}

/** Per leg departing in [from, to] and per category: the counters behind availability. */
export async function getInventoryGrid(
  db: VsDatabase,
  ctx: EngineContext,
  input: { vesselId: string; from: string; to: string },
) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
      leg_id: string;
      depart_date: string;
      arrive_date: string;
      from_code: string;
      to_code: string;
      status: string;
      category_id: string;
      pool_total: number | null;
      pool_held: number | null;
      pool_booked: number | null;
      stop_sale: boolean | null;
      overcommit: number | null;
      allot_total: number;
      allot_held: number;
      allot_booked: number;
      blocked: number;
    }>`
      select l.id as leg_id, l.depart_date::text, l.arrive_date::text, fp.code as from_code, tp.code as to_code, l.status,
             c.id as category_id,
             p.total as pool_total, p.held as pool_held, p.booked as pool_booked, p.stop_sale, p.overcommit,
             coalesce(sum(a.total) filter (where a.kind = 'allotment' and a.released_at is null), 0)::int as allot_total,
             coalesce(sum(a.held) filter (where a.kind = 'allotment' and a.released_at is null), 0)::int as allot_held,
             coalesce(sum(a.booked) filter (where a.kind = 'allotment' and a.released_at is null), 0)::int as allot_booked,
             coalesce(sum(a.total) filter (where a.kind = 'block' and a.released_at is null), 0)::int as blocked
      from vs.leg l
      join vs.port fp on fp.id = l.from_port_id
      join vs.port tp on tp.id = l.to_port_id
      join vs.cabin_category c on c.vessel_id = l.vessel_id
      left join vs.inventory_bucket p on p.leg_id = l.id and p.category_id = c.id and p.kind = 'pool'
      left join vs.inventory_bucket a on a.leg_id = l.id and a.category_id = c.id and a.kind <> 'pool'
      where l.vessel_id = ${input.vesselId} and l.depart_date between ${input.from}::date and ${input.to}::date
      group by l.id, fp.code, tp.code, c.id, p.id
      order by l.depart_date, l.id, c.sort_order, c.code`.execute(tx);
    const legs = new Map<string, InventoryLeg>();
    for (const r of rows) {
      let leg = legs.get(r.leg_id);
      if (!leg) {
        leg = {
          id: r.leg_id,
          departDate: r.depart_date,
          arriveDate: r.arrive_date,
          from: r.from_code,
          to: r.to_code,
          status: r.status,
          cells: [],
        };
        legs.set(r.leg_id, leg);
      }
      const pool = {
        total: r.pool_total ?? 0,
        held: r.pool_held ?? 0,
        booked: r.pool_booked ?? 0,
        stopSale: r.stop_sale ?? false,
        overcommit: r.overcommit ?? 0,
      };
      leg.cells.push({
        categoryId: r.category_id,
        pool,
        allotted: { total: r.allot_total, held: r.allot_held, booked: r.allot_booked },
        blocked: r.blocked,
        free:
          r.status === 'open' && !pool.stopSale
            ? Math.max(0, pool.total - pool.held - pool.booked)
            : 0,
      });
    }
    const blocks = await sql<{
      id: string;
      kind: string;
      categoryId: string;
      count: number;
      reason: string;
      firstDate: string;
      lastDate: string;
      legs: number;
      createdAt: Date;
    }>`
      select k.id, k.kind, k.category_id as "categoryId", k.count, k.reason,
             min(l.depart_date)::text as "firstDate", max(l.depart_date)::text as "lastDate",
             count(distinct l.id)::int as legs, k.created_at as "createdAt"
      from vs.cabin_block k
      join vs.inventory_bucket b on b.block_id = k.id
      join vs.leg l on l.id = b.leg_id
      where k.vessel_id = ${input.vesselId} and k.status = 'active'
      group by k.id
      having max(l.arrive_date) >= ${input.from}::date
      order by min(l.depart_date)`.execute(tx);
    return { legs: [...legs.values()], blocks: blocks.rows };
  });
}

/** Templates (with stops), sailing patterns, ports, departures in a range and past exceptions. */
export async function getScheduleSetup(
  db: VsDatabase,
  ctx: EngineContext,
  input: { vesselId: string; from: string; to: string },
) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const ports = await tx
      .selectFrom('port')
      .select(['id', 'code', 'name_en', 'name_ar'])
      .where('active', '=', true)
      .orderBy('code')
      .execute();
    const templates = await sql<{
      id: string;
      name: string;
      cycleDays: number;
      validFrom: string;
      validTo: string | null;
      active: boolean;
      stops: {
        seq: number;
        port: string;
        dayOffset: number;
        embark: boolean;
        disembark: boolean;
      }[];
    }>`
      select t.id, t.name, t.cycle_days as "cycleDays", t.valid_from::text as "validFrom", t.valid_to::text as "validTo", t.active,
             (select jsonb_agg(jsonb_build_object('seq', s.seq, 'port', p.code, 'dayOffset', s.day_offset,
                                                  'embark', s.embark_allowed, 'disembark', s.disembark_allowed) order by s.seq)
              from vs.schedule_template_stop s join vs.port p on p.id = s.port_id where s.template_id = t.id) as stops
      from vs.schedule_template t where t.vessel_id = ${input.vesselId} order by t.valid_from, t.name`.execute(
      tx,
    );
    const patterns = await sql<{
      id: string;
      code: string;
      nameEn: string;
      nameAr: string;
      nights: number;
      templateId: string;
      embarkStopSeq: number;
      disembarkStopSeq: number;
      active: boolean;
    }>`
      select id, code, name_en as "nameEn", name_ar as "nameAr", nights, template_id as "templateId",
             embark_stop_seq as "embarkStopSeq", disembark_stop_seq as "disembarkStopSeq", active
      from vs.sailing_pattern where vessel_id = ${input.vesselId} order by code`.execute(tx);
    const departures = await sql<{
      id: string;
      departDate: string;
      arriveDate: string;
      from: string;
      to: string;
      status: string;
      booked: number;
      held: number;
    }>`
      select l.id, l.depart_date::text as "departDate", l.arrive_date::text as "arriveDate",
             fp.code as from, tp.code as to, l.status,
             coalesce((select sum(b.booked) from vs.inventory_bucket b where b.leg_id = l.id), 0)::int as booked,
             coalesce((select sum(b.held) from vs.inventory_bucket b where b.leg_id = l.id), 0)::int as held
      from vs.leg l join vs.port fp on fp.id = l.from_port_id join vs.port tp on tp.id = l.to_port_id
      where l.vessel_id = ${input.vesselId} and l.depart_date between ${input.from}::date and ${input.to}::date
      order by l.depart_date, l.id`.execute(tx);
    const exceptions = await sql<{
      id: string;
      kind: string;
      dateFrom: string;
      dateTo: string;
      reason: string;
      createdAt: Date;
    }>`
      select id, kind, date_from::text as "dateFrom", date_to::text as "dateTo", reason, created_at as "createdAt"
      from vs.schedule_exception where vessel_id = ${input.vesselId} order by created_at desc limit 50`.execute(
      tx,
    );
    const horizon = await sql<{ last: string | null }>`
      select max(depart_date)::text as last from vs.leg where vessel_id = ${input.vesselId}`.execute(
      tx,
    );
    return {
      ports,
      templates: templates.rows.map((t) => ({ ...t, stops: t.stops ?? [] })),
      patterns: patterns.rows,
      departures: departures.rows,
      exceptions: exceptions.rows,
      lastDeparture: horizon.rows[0]?.last ?? null,
    };
  });
}

/** Seasons, rate plans with their rates and policies, supplements: everything prices come from. */
export async function getRatesSetup(db: VsDatabase, ctx: EngineContext, vesselId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const seasons = await sql<{
      id: string;
      code: string;
      name: string;
      periods: { from: string; to: string }[];
    }>`
      select s.id, s.code, s.name,
             coalesce((select jsonb_agg(jsonb_build_object('from', lower(p.during), 'to', upper(p.during) - 1) order by lower(p.during))
                       from vs.season_period p where p.season_id = s.id), '[]') as periods
      from vs.season s where s.vessel_id = ${vesselId} order by s.code`.execute(tx);
    const plans = await sql<{
      id: string;
      code: string;
      name: string;
      market: string;
      currency: string;
      pricingUnit: string;
      pricingPeriod: string;
      board: string | null;
      minNights: number | null;
      active: boolean;
      cancellationPolicy: string;
      childPolicy: string;
      paymentPolicy: string;
    }>`
      select r.id, r.code, r.name, r.market, r.currency, r.pricing_unit as "pricingUnit", r.pricing_period as "pricingPeriod",
             r.board, r.min_nights as "minNights", r.active,
             cp.name as "cancellationPolicy", ch.name as "childPolicy", pp.name as "paymentPolicy"
      from vs.rate_plan r
      join vs.cancellation_policy cp on cp.id = r.cancellation_policy_id
      join vs.child_policy ch on ch.id = r.child_policy_id
      join vs.payment_policy pp on pp.id = r.payment_policy_id
      where r.vessel_id = ${vesselId} order by r.market, r.code`.execute(tx);
    const rates = await sql<{
      ratePlanId: string;
      categoryId: string;
      seasonId: string;
      sailingPatternId: string | null;
      basis: string | null;
      amount: bigint;
    }>`
      select rate_plan_id as "ratePlanId", category_id as "categoryId", season_id as "seasonId",
             sailing_pattern_id as "sailingPatternId", basis, amount
      from vs.rate where vessel_id = ${vesselId}`.execute(tx);
    const supplements = await sql<{
      id: string;
      ratePlanId: string;
      code: string;
      kind: 'gala' | 'peak' | 'other';
      nameEn: string;
      nameAr: string;
      dateFrom: string;
      dateTo: string;
      amountAdult: bigint;
      amountChild: bigint;
      mandatory: boolean;
    }>`
      select s.id, s.rate_plan_id as "ratePlanId", s.code, s.kind, s.name_en as "nameEn", s.name_ar as "nameAr",
             s.date_from::text as "dateFrom", s.date_to::text as "dateTo", s.amount_adult as "amountAdult",
             s.amount_child as "amountChild", s.mandatory
      from vs.supplement s join vs.rate_plan r on r.id = s.rate_plan_id
      where r.vessel_id = ${vesselId} order by s.date_from`.execute(tx);
    const cancellation = await sql<{
      id: string;
      name: string;
      rules: { fromDays: number; penaltyBps: number }[];
    }>`
      select p.id, p.name,
             coalesce((select jsonb_agg(jsonb_build_object('fromDays', r.from_days, 'penaltyBps', r.penalty_bps) order by r.from_days desc)
                       from vs.cancellation_rule r where r.cancellation_policy_id = p.id), '[]') as rules
      from vs.cancellation_policy p order by p.name`.execute(tx);
    const children = await sql<{
      id: string;
      name: string;
      adultFromAge: number;
      bands: {
        ageFrom: number;
        ageTo: number;
        basis: string;
        percentBps: number | null;
        requiresTwoAdults: boolean;
      }[];
    }>`
      select p.id, p.name, p.adult_from_age as "adultFromAge",
             coalesce((select jsonb_agg(jsonb_build_object('ageFrom', b.age_from, 'ageTo', b.age_to, 'basis', b.basis,
                                                           'percentBps', b.percent_bps, 'requiresTwoAdults', b.requires_two_adults)
                                        order by b.age_from)
                       from vs.child_policy_band b where b.child_policy_id = p.id), '[]') as bands
      from vs.child_policy p order by p.name`.execute(tx);
    const payment = await sql<{
      id: string;
      name: string;
      depositBps: number;
      balanceDueDays: number;
    }>`
      select id, name, deposit_bps as "depositBps", balance_due_days as "balanceDueDays"
      from vs.payment_policy order by name`.execute(tx);
    const patterns = await tx
      .selectFrom('sailing_pattern')
      .select(['id', 'code', 'nights'])
      .where('vessel_id', '=', vesselId)
      .orderBy('code')
      .execute();
    return {
      seasons: seasons.rows,
      patterns,
      plans: plans.rows,
      rates: rates.rows,
      supplements: supplements.rows,
      policies: { cancellation: cancellation.rows, children: children.rows, payment: payment.rows },
    };
  });
}

/** The vessel's cabins with the category each has today (Cairo) and from when. */
export async function listCabins(db: VsDatabase, ctx: EngineContext, vesselId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
      id: string;
      number: string;
      deck: string | null;
      accessible: boolean;
      categoryId: string | null;
      until: string | null;
    }>`
      select c.id, c.number, c.deck, c.accessible, p.category_id as "categoryId",
             case when upper_inf(p.during) then null else (upper(p.during) - 1)::text end as until
      from vs.cabin c
      left join lateral (
        select category_id, during from vs.cabin_period
        where cabin_id = c.id
          and (upper_inf(during) or upper(during) > (now() at time zone 'Africa/Cairo')::date)
        order by lower(during) limit 1) p on true
      where c.vessel_id = ${vesselId}
      order by c.deck nulls last, c.number`.execute(tx);
    return rows;
  });
}
