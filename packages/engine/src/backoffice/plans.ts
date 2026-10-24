import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { pgErrorCode } from '@vs/shared';
import { audit } from '../audit';
import {
  cairoToday,
  emitEvents,
  lockVessel,
  parseInput,
  type EngineContext,
  type Tx,
} from '../internal';
import {
  createRatePlanInput,
  createSupplement,
  createSupplementInput,
  minorUnits,
} from '../pricing/setup';
import { dateSchema } from '../schedule/setup';

/**
 * Rate plans and supplements (Batch 8, step 4). A plan sells only through the channel contracts
 * that list it; "sell in the back office" makes sure the ship has a back-office contract and adds
 * the plan to it. Quotes and bookings keep their own prices, so edits reach new quotes only, and
 * every edit emits rate.changed.
 */

function refuse(reason: string, extra: Record<string, unknown> = {}): never {
  throw new DomainError('VALIDATION_FAILED', { message: reason, details: { reason, ...extra } });
}

function inUse(reason: string): never {
  throw new DomainError('INVALID_STATE', { message: reason, details: { reason } });
}

async function friendly<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (pgErrorCode(error) === '23505') refuse('code_taken');
    throw error;
  }
}

async function planChanged(tx: Tx, ctx: EngineContext, planId: string, cause: string) {
  const plan = await tx
    .updateTable('rate_plan')
    .set((eb) => ({ version: eb('version', '+', 1n) }))
    .where('id', '=', planId)
    .returning(['id', 'vessel_id', 'version'])
    .executeTakeFirstOrThrow();
  await emitEvents(tx, ctx, [
    {
      type: 'rate.changed',
      resource: 'rate_plan',
      resourceId: plan.id,
      version: plan.version,
      payload: { vessel_id: plan.vessel_id, cause },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface PlanContract {
  id: string;
  channel: string;
  channelType: string;
  active: boolean;
  ratePlanIds: string[];
}

export async function getPlans(db: VsDatabase, ctx: EngineContext, vesselId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows: plans } = await sql<{
      id: string;
      code: string;
      name: string;
      market: string;
      currency: string;
      board: string;
      pricingUnit: 'per_person' | 'per_cabin';
      pricingPeriod: 'per_night' | 'per_package';
      minNights: number;
      childPolicyId: string;
      cancellationPolicyId: string;
      paymentPolicyId: string;
      inclusions: { en?: string[]; ar?: string[] };
      exclusions: { en?: string[]; ar?: string[] };
      active: boolean;
      rates: number;
      used: number;
    }>`
      select r.id, r.code, r.name, r.market, r.currency, r.board,
             r.pricing_unit as "pricingUnit", r.pricing_period as "pricingPeriod",
             r.min_nights as "minNights", r.child_policy_id as "childPolicyId",
             r.cancellation_policy_id as "cancellationPolicyId",
             r.payment_policy_id as "paymentPolicyId", r.inclusions, r.exclusions, r.active,
             (select count(*)::int from vs.rate x where x.rate_plan_id = r.id) as rates,
             (select count(*)::int from vs.quote q where q.rate_plan_id = r.id)
               + (select count(*)::int from vs.booking b where b.rate_plan_id = r.id) as used
      from vs.rate_plan r where r.vessel_id = ${vesselId}
      order by r.active desc, r.market, r.code`.execute(tx);
    const { rows: contracts } = await sql<PlanContract>`
      select k.id, c.name as channel, c.type as "channelType", k.active,
             coalesce(array(select p.rate_plan_id from vs.channel_contract_rate_plan p
                            where p.contract_id = k.id), '{}') as "ratePlanIds"
      from vs.channel_contract k join vs.channel c on c.id = k.channel_id
      where k.vessel_id = ${vesselId} and k.active
      order by (c.type = 'back_office') desc, c.name`.execute(tx);
    return { plans, contracts };
  });
}

// ---------------------------------------------------------------------------
// The back-office contract
// ---------------------------------------------------------------------------

/**
 * The ship's active back-office contract, created when missing: the office sells from the pool,
 * guests pay the company, every cabin category. The company's back-office channel too.
 */
async function backOfficeContract(tx: Tx, ctx: EngineContext, vesselId: string): Promise<string> {
  let channel = await tx
    .selectFrom('channel')
    .select('id')
    .where('type', '=', 'back_office')
    .executeTakeFirst();
  if (!channel)
    channel = await tx
      .insertInto('channel')
      .values({
        operator_id: ctx.operatorId,
        code: 'back-office',
        name: 'Back office (phone, WhatsApp, walk-in)',
        type: 'back_office',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  const existing = await tx
    .selectFrom('channel_contract')
    .select('id')
    .where('channel_id', '=', channel.id)
    .where('vessel_id', '=', vesselId)
    .where('active', '=', true)
    .executeTakeFirst();
  if (existing) return existing.id;
  const settings = await tx.selectFrom('operator_setting').selectAll().executeTakeFirstOrThrow();
  const contract = await tx
    .insertInto('channel_contract')
    .values({
      operator_id: ctx.operatorId,
      channel_id: channel.id,
      vessel_id: vesselId,
      allocation: 'pool',
      payment_mode: 'vessel_prepaid',
      checkout_hold_minutes: settings.checkout_hold_minutes,
      option_hold_hours: settings.option_hold_hours,
      request_sla_hours: settings.request_sla_hours,
      valid_from: await cairoToday(tx),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await sql`
    insert into vs.channel_contract_category (operator_id, contract_id, category_id)
    select ${ctx.operatorId}, ${contract.id}, c.id from vs.cabin_category c
    where c.vessel_id = ${vesselId}`.execute(tx);
  await audit(tx, ctx.operatorId, ctx.actor, {
    action: 'channel_contract.created',
    entity: 'channel_contract',
    entityId: contract.id,
    after: { ...contract, note: 'back office, created with a rate plan' },
  });
  return contract.id;
}

// ---------------------------------------------------------------------------
// Rate plans
// ---------------------------------------------------------------------------

export const addRatePlanInput = createRatePlanInput.extend({
  /** Make sure the ship's back-office contract sells this plan (created if missing). */
  sellInBackOffice: z.boolean().default(true),
});

export async function addRatePlan(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof addRatePlanInput>,
) {
  const data = parseInput(addRatePlanInput, input);
  return friendly(() =>
    db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
      await lockVessel(tx, data.vesselId);
      const plan = await tx
        .insertInto('rate_plan')
        .values({
          operator_id: ctx.operatorId,
          vessel_id: data.vesselId,
          code: data.code,
          name: data.name,
          market: data.market,
          currency: data.currency,
          board: data.board,
          pricing_unit: data.pricingUnit,
          pricing_period: data.pricingPeriod,
          min_nights: data.minNights,
          child_policy_id: data.childPolicyId,
          cancellation_policy_id: data.cancellationPolicyId,
          payment_policy_id: data.paymentPolicyId,
          inclusions: JSON.stringify(data.inclusions),
          exclusions: JSON.stringify(data.exclusions),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (data.sellInBackOffice) {
        const contractId = await backOfficeContract(tx, ctx, data.vesselId);
        await tx
          .insertInto('channel_contract_rate_plan')
          .values({ operator_id: ctx.operatorId, contract_id: contractId, rate_plan_id: plan.id })
          .execute();
      }
      await audit(tx, ctx.operatorId, ctx.actor, {
        action: 'rate_plan.created',
        entity: 'rate_plan',
        entityId: plan.id,
        after: { ...plan, sell_in_back_office: data.sellInBackOffice },
      });
      return plan;
    }),
  );
}

export const updateRatePlanInput = createRatePlanInput
  .omit({ vesselId: true, code: true })
  .extend({ ratePlanId: z.uuid(), active: z.boolean() });

/**
 * Everything but the code. Market, currency and how prices are counted (per person / cabin,
 * per night / package) stay fixed once the plan has prices: the prices would mean something else.
 */
export async function updateRatePlan(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateRatePlanInput>,
) {
  const data = parseInput(updateRatePlanInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('rate_plan')
      .selectAll()
      .where('id', '=', data.ratePlanId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Rate plan not found' });
    const basics =
      before.market !== data.market ||
      before.currency !== data.currency ||
      before.pricing_unit !== data.pricingUnit ||
      before.pricing_period !== data.pricingPeriod;
    if (basics) {
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from vs.rate where rate_plan_id = ${data.ratePlanId}`.execute(tx);
      if (rows[0]!.n > 0) inUse('plan_has_rates');
    }
    await tx
      .updateTable('rate_plan')
      .set({
        name: data.name,
        market: data.market,
        currency: data.currency,
        board: data.board,
        pricing_unit: data.pricingUnit,
        pricing_period: data.pricingPeriod,
        min_nights: data.minNights,
        child_policy_id: data.childPolicyId,
        cancellation_policy_id: data.cancellationPolicyId,
        payment_policy_id: data.paymentPolicyId,
        inclusions: JSON.stringify(data.inclusions),
        exclusions: JSON.stringify(data.exclusions),
        active: data.active,
      })
      .where('id', '=', data.ratePlanId)
      .execute();
    await planChanged(tx, ctx, data.ratePlanId, 'rate_plan.updated');
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'rate_plan.updated',
      entity: 'rate_plan',
      entityId: data.ratePlanId,
      before: { name: before.name, active: before.active, market: before.market },
      after: { name: data.name, active: data.active, market: data.market },
    });
  });
}

export const setPlanContractsInput = z.object({
  ratePlanId: z.uuid(),
  /** The ship's active contracts that sell this plan; the others stop selling it. */
  contractIds: z.array(z.uuid()),
});

/** Which channels sell the plan. A contract must keep at least one plan. */
export async function setPlanContracts(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof setPlanContractsInput>,
) {
  const data = parseInput(setPlanContractsInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const plan = await tx
      .selectFrom('rate_plan')
      .select(['id', 'vessel_id'])
      .where('id', '=', data.ratePlanId)
      .forUpdate()
      .executeTakeFirst();
    if (!plan) throw new DomainError('NOT_FOUND', { message: 'Rate plan not found' });
    const contracts = await tx
      .selectFrom('channel_contract')
      .select('id')
      .where('vessel_id', '=', plan.vessel_id)
      .where('active', '=', true)
      .forUpdate()
      .execute();
    const ids = new Set(contracts.map((c) => c.id));
    if (data.contractIds.some((id) => !ids.has(id))) refuse('unknown_contract');
    for (const contract of contracts) {
      const wanted = data.contractIds.includes(contract.id);
      if (wanted)
        await sql`
          insert into vs.channel_contract_rate_plan (operator_id, contract_id, rate_plan_id)
          values (${ctx.operatorId}, ${contract.id}, ${plan.id}) on conflict do nothing`.execute(
          tx,
        );
      else {
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from vs.channel_contract_rate_plan
          where contract_id = ${contract.id} and rate_plan_id <> ${plan.id}`.execute(tx);
        const has = await sql`
          select 1 from vs.channel_contract_rate_plan
          where contract_id = ${contract.id} and rate_plan_id = ${plan.id}`.execute(tx);
        if (has.rows.length === 0) continue;
        if (rows[0]!.n === 0) refuse('contract_needs_plan');
        await sql`
          delete from vs.channel_contract_rate_plan
          where contract_id = ${contract.id} and rate_plan_id = ${plan.id}`.execute(tx);
      }
    }
    await planChanged(tx, ctx, plan.id, 'rate_plan.contracts');
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'rate_plan.contracts_set',
      entity: 'rate_plan',
      entityId: plan.id,
      after: { contract_ids: data.contractIds },
    });
  });
}

/** A plan set up by mistake: only while it has no rates, quotes or bookings. */
export async function deleteRatePlan(db: VsDatabase, ctx: EngineContext, ratePlanId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('rate_plan')
      .selectAll()
      .where('id', '=', ratePlanId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Rate plan not found' });
    const { rows } = await sql<{ n: number }>`
      select (select count(*)::int from vs.rate where rate_plan_id = ${ratePlanId})
           + (select count(*)::int from vs.quote where rate_plan_id = ${ratePlanId})
           + (select count(*)::int from vs.booking where rate_plan_id = ${ratePlanId})
           + (select count(*)::int from vs.supplement where rate_plan_id = ${ratePlanId}) as n`.execute(
      tx,
    );
    if (rows[0]!.n > 0) inUse('plan_in_use');
    const sole = await sql<{ n: number }>`
      select count(*)::int as n from vs.channel_contract_rate_plan p
      where p.rate_plan_id = ${ratePlanId}
        and not exists (select from vs.channel_contract_rate_plan o
                        where o.contract_id = p.contract_id and o.rate_plan_id <> ${ratePlanId})`.execute(
      tx,
    );
    if (sole.rows[0]!.n > 0) refuse('contract_needs_plan');
    await tx
      .deleteFrom('channel_contract_rate_plan')
      .where('rate_plan_id', '=', ratePlanId)
      .execute();
    await tx.deleteFrom('rate_plan').where('id', '=', ratePlanId).execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'rate_plan.deleted',
      entity: 'rate_plan',
      entityId: ratePlanId,
      before: { code: before.code, name: before.name },
    });
  });
}

// ---------------------------------------------------------------------------
// Supplements
// ---------------------------------------------------------------------------

export async function addSupplement(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createSupplementInput>,
) {
  const supplement = await friendly(() => createSupplement(db, ctx, input));
  await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    planChanged(tx, ctx, supplement.rate_plan_id, 'supplement.created'),
  );
  return supplement;
}

export const updateSupplementInput = z.object({
  supplementId: z.uuid(),
  kind: z.enum(['gala', 'peak', 'other']),
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  dateFrom: dateSchema,
  dateTo: dateSchema,
  amountAdult: minorUnits,
  amountChild: minorUnits,
  mandatory: z.boolean(),
});

export async function updateSupplement(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateSupplementInput>,
) {
  const data = parseInput(updateSupplementInput, input);
  if (data.dateTo < data.dateFrom) refuse('dates_backwards');
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('supplement')
      .selectAll()
      .where('id', '=', data.supplementId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Supplement not found' });
    await tx
      .updateTable('supplement')
      .set({
        kind: data.kind,
        name_en: data.nameEn,
        name_ar: data.nameAr,
        date_from: data.dateFrom,
        date_to: data.dateTo,
        amount_adult: data.amountAdult,
        amount_child: data.amountChild,
        mandatory: data.mandatory,
      })
      .where('id', '=', data.supplementId)
      .execute();
    await planChanged(tx, ctx, before.rate_plan_id, 'supplement.updated');
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'supplement.updated',
      entity: 'supplement',
      entityId: data.supplementId,
      before: {
        date_from: before.date_from,
        date_to: before.date_to,
        amount_adult: before.amount_adult.toString(),
      },
      after: {
        date_from: data.dateFrom,
        date_to: data.dateTo,
        amount_adult: data.amountAdult.toString(),
      },
    });
  });
}

/** Quotes and bookings keep the supplements they were priced with, so removing one is safe. */
export async function deleteSupplement(db: VsDatabase, ctx: EngineContext, supplementId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('supplement')
      .selectAll()
      .where('id', '=', supplementId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Supplement not found' });
    await tx.deleteFrom('supplement').where('id', '=', supplementId).execute();
    await planChanged(tx, ctx, before.rate_plan_id, 'supplement.deleted');
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'supplement.deleted',
      entity: 'supplement',
      entityId: supplementId,
      before: { code: before.code, name_en: before.name_en },
    });
  });
}

// ---------------------------------------------------------------------------
// Getting started: what a ship still needs before the office can sell it
// ---------------------------------------------------------------------------

export type SetupStep =
  | 'categories'
  | 'cabins'
  | 'route'
  | 'itineraries'
  | 'departures'
  | 'seasons'
  | 'policies'
  | 'plan'
  | 'prices'
  | 'backOffice';

export interface ShipSetup {
  vesselId: string;
  name: string;
  /** Steps in order with whether each is done; `detail` is a count where it helps. */
  steps: { step: SetupStep; done: boolean; detail?: number }[];
}

/**
 * For every active ship, the setup steps in order. Prices count as done when every active plan
 * has a price for each category and season (and each basis the category takes, and each
 * itinerary for package plans).
 */
export async function getSetupChecklist(
  db: VsDatabase,
  ctx: EngineContext,
): Promise<{ ships: ShipSetup[]; team: number; opsEmail: boolean }> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
      id: string;
      name: string;
      categories: number;
      cabins: number;
      routes: number;
      itineraries: number;
      departures: number;
      uncovered: number;
      seasons: number;
      plans: number;
      missingPrices: number;
      backOffice: number;
    }>`
      select v.id, v.name,
        (select count(*)::int from vs.cabin_category c where c.vessel_id = v.id) as categories,
        (select count(*)::int from vs.cabin c where c.vessel_id = v.id
           and exists (select from vs.cabin_period p where p.cabin_id = c.id
                       and (upper_inf(p.during) or upper(p.during) > (now() at time zone 'Africa/Cairo')::date))) as cabins,
        (select count(*)::int from vs.schedule_template t where t.vessel_id = v.id and t.active) as routes,
        (select count(*)::int from vs.sailing_pattern p where p.vessel_id = v.id and p.active) as itineraries,
        (select count(*)::int from vs.leg l where l.vessel_id = v.id and l.status <> 'cancelled'
           and l.depart_date >= (now() at time zone 'Africa/Cairo')::date) as departures,
        (select count(distinct d)::int
           from vs.leg l, generate_series(greatest(l.depart_date, (now() at time zone 'Africa/Cairo')::date),
                                          l.arrive_date - 1, interval '1 day') d
           where l.vessel_id = v.id and l.status <> 'cancelled'
             and not exists (select from vs.season_period p
                             where p.vessel_id = v.id and p.during @> d::date)) as uncovered,
        (select count(*)::int from vs.season s where s.vessel_id = v.id) as seasons,
        (select count(*)::int from vs.rate_plan r where r.vessel_id = v.id and r.active) as plans,
        (select count(*)::int
           from vs.rate_plan r
           join vs.cabin_category c on c.vessel_id = r.vessel_id
           join vs.season s on s.vessel_id = r.vessel_id
           cross join lateral (
             select b from unnest(case when r.pricing_unit = 'per_cabin' then array[null::text]
                                       else (array['single', 'double', 'triple'])[1:c.max_adults] end) b) basis
           left join vs.sailing_pattern sp on r.pricing_period = 'per_package'
             and sp.vessel_id = r.vessel_id and sp.active
           where r.vessel_id = v.id and r.active
             and (r.pricing_period = 'per_night' or sp.id is not null)
             and not exists (
               select from vs.rate x where x.rate_plan_id = r.id and x.category_id = c.id
                 and x.season_id = s.id and x.basis is not distinct from basis.b
                 and x.sailing_pattern_id is not distinct from sp.id)) as "missingPrices",
        (select count(*)::int from vs.channel_contract k
           join vs.channel ch on ch.id = k.channel_id and ch.type = 'back_office'
           where k.vessel_id = v.id and k.active
             and exists (select from vs.channel_contract_rate_plan p where p.contract_id = k.id)) as "backOffice"
      from vs.vessel v where v.active order by v.name`.execute(tx);
    const policies = await sql<{ n: number }>`
      select least((select count(*) from vs.child_policy), (select count(*) from vs.cancellation_policy),
                   (select count(*) from vs.payment_policy))::int as n`.execute(tx);
    const team = await sql<{ n: number }>`
      select (select count(*)::int from vs.staff_user where active)
           + (select count(*)::int from vs.staff_invitation where accepted_at is null and expires_at > now()) as n`.execute(
      tx,
    );
    const settings = await tx.selectFrom('operator_setting').select('ops_email').executeTakeFirst();
    return {
      ships: rows.map((r) => ({
        vesselId: r.id,
        name: r.name,
        steps: [
          { step: 'categories', done: r.categories > 0 },
          { step: 'cabins', done: r.cabins > 0 },
          { step: 'route', done: r.routes > 0 },
          { step: 'itineraries', done: r.itineraries > 0 },
          { step: 'departures', done: r.departures > 0 },
          { step: 'seasons', done: r.seasons > 0 && r.uncovered === 0, detail: r.uncovered },
          { step: 'policies', done: policies.rows[0]!.n > 0 },
          { step: 'plan', done: r.plans > 0 },
          { step: 'prices', done: r.plans > 0 && r.missingPrices === 0, detail: r.missingPrices },
          { step: 'backOffice', done: r.backOffice > 0 },
        ],
      })),
      team: team.rows[0]!.n,
      opsEmail: Boolean(settings?.ops_email),
    };
  });
}
