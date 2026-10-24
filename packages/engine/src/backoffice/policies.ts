import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { addDays, pgErrorCode, type BusinessDate } from '@vs/shared';
import { audit } from '../audit';
import { emitEvents, lockVessel, parseInput, type EngineContext, type Tx } from '../internal';
import {
  createCancellationPolicyInput,
  createChildPolicyInput,
  createPaymentPolicyInput,
  createSeasonInput,
} from '../pricing/setup';

/**
 * Seasons and policies (Batch 8, step 3). Quotes and bookings keep a copy of the policies they
 * were sold with, so an edit here changes new quotes only. Every edit that changes prices or
 * terms bumps the affected rate plans and emits rate.changed, so channels refresh.
 */

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface SeasonRow {
  id: string;
  code: string;
  name: string;
  periods: { from: string; to: string }[];
  rates: number;
}

export async function getSeasons(
  db: VsDatabase,
  ctx: EngineContext,
  vesselId: string,
): Promise<{ seasons: SeasonRow[]; uncovered: { from: string; to: string }[] }> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows: seasons } = await sql<SeasonRow>`
      select s.id, s.code, s.name,
             coalesce((select jsonb_agg(jsonb_build_object('from', lower(p.during)::text,
                                                           'to', (upper(p.during) - 1)::text)
                                        order by lower(p.during))
                       from vs.season_period p where p.season_id = s.id), '[]') as periods,
             (select count(*)::int from vs.rate r where r.season_id = s.id) as rates
      from vs.season s where s.vessel_id = ${vesselId} order by s.code`.execute(tx);
    // Nights the ship sails from today on that no season covers: they cannot be priced.
    const { rows: nights } = await sql<{ d: string }>`
      select d::date::text as d
      from vs.leg l,
           generate_series(greatest(l.depart_date, (now() at time zone 'Africa/Cairo')::date),
                           l.arrive_date - 1, interval '1 day') d
      where l.vessel_id = ${vesselId} and l.status <> 'cancelled'
        and not exists (select from vs.season_period p
                        where p.vessel_id = l.vessel_id and p.during @> d::date)
      group by d order by d`.execute(tx);
    const uncovered: { from: string; to: string }[] = [];
    for (const { d } of nights) {
      const last = uncovered[uncovered.length - 1];
      if (last && addDays(last.to as BusinessDate, 1) === d) last.to = d;
      else uncovered.push({ from: d, to: d });
    }
    return { seasons, uncovered };
  });
}

export async function getPolicies(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows: children } = await sql<{
      id: string;
      name: string;
      adultFromAge: number;
      maxChildrenPerCabin: number;
      plans: number;
      bands: {
        ageFrom: number;
        ageTo: number;
        basis: 'free' | 'percent_of_adult' | 'fixed' | 'included';
        percentBps: number | null;
        fixedAmount: string | null;
        fixedCurrency: string | null;
        requiresTwoAdults: boolean;
      }[];
    }>`
      select p.id, p.name, p.adult_from_age as "adultFromAge",
             p.max_children_per_cabin as "maxChildrenPerCabin",
             (select count(*)::int from vs.rate_plan r where r.child_policy_id = p.id) as plans,
             coalesce((select jsonb_agg(jsonb_build_object(
                         'ageFrom', b.age_from, 'ageTo', b.age_to, 'basis', b.basis,
                         'percentBps', b.percent_bps, 'fixedAmount', b.fixed_amount::text,
                         'fixedCurrency', b.fixed_currency, 'requiresTwoAdults', b.requires_two_adults)
                       order by b.age_from)
                       from vs.child_policy_band b where b.child_policy_id = p.id), '[]') as bands
      from vs.child_policy p order by p.name`.execute(tx);
    const { rows: cancellation } = await sql<{
      id: string;
      name: string;
      plans: number;
      rules: { fromDays: number; penaltyBps: number }[];
      fees: {
        changeKind: 'any' | 'date' | 'category' | 'occupancy' | 'cabins' | 'guests';
        fromDays: number;
        feeKind: 'flat' | 'percent';
        amount: string | null;
        currency: string | null;
        percentBps: number | null;
      }[];
    }>`
      select p.id, p.name,
             (select count(*)::int from vs.rate_plan r where r.cancellation_policy_id = p.id) as plans,
             coalesce((select jsonb_agg(jsonb_build_object('fromDays', r.from_days, 'penaltyBps', r.penalty_bps)
                                        order by r.from_days desc)
                       from vs.cancellation_rule r where r.cancellation_policy_id = p.id), '[]') as rules,
             coalesce((select jsonb_agg(jsonb_build_object(
                         'changeKind', f.change_kind, 'fromDays', f.from_days, 'feeKind', f.fee_kind,
                         'amount', f.amount::text, 'currency', f.currency, 'percentBps', f.percent_bps)
                       order by f.change_kind, f.from_days desc)
                       from vs.amendment_fee_rule f where f.cancellation_policy_id = p.id), '[]') as fees
      from vs.cancellation_policy p order by p.name`.execute(tx);
    const { rows: payment } = await sql<{
      id: string;
      name: string;
      plans: number;
      depositBps: number;
      balanceDueDays: number;
      bankTransferHoldHours: number;
      cardHoldMinutes: number;
      autoCancelOverdue: boolean;
      autoCancelAfterDays: number | null;
    }>`
      select p.id, p.name, p.deposit_bps as "depositBps", p.balance_due_days as "balanceDueDays",
             p.bank_transfer_hold_hours as "bankTransferHoldHours",
             p.card_hold_minutes as "cardHoldMinutes", p.auto_cancel_overdue as "autoCancelOverdue",
             p.auto_cancel_after_days as "autoCancelAfterDays",
             (select count(*)::int from vs.rate_plan r where r.payment_policy_id = p.id) as plans
      from vs.payment_policy p order by p.name`.execute(tx);
    return { children, cancellation, payment };
  });
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function refuse(reason: string, extra: Record<string, unknown> = {}): never {
  throw new DomainError('VALIDATION_FAILED', { message: reason, details: { reason, ...extra } });
}

/** Database refusals the screen can explain: a code twice, overlapping season dates. */
async function friendly<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = pgErrorCode(error);
    if (code === '23505') refuse('code_taken');
    if (code === '23P01') refuse('season_overlap');
    throw error;
  }
}

type PlanFilter =
  | { vesselId: string }
  | { childPolicyId: string }
  | { cancellationPolicyId: string }
  | { paymentPolicyId: string };

/** The rate plans affected by a change get a new version and a rate.changed event. */
async function ratesChanged(tx: Tx, ctx: EngineContext, filter: PlanFilter, cause: string) {
  const [column, value] = Object.entries(filter)[0] as [string, string];
  const col = {
    vesselId: 'vessel_id',
    childPolicyId: 'child_policy_id',
    cancellationPolicyId: 'cancellation_policy_id',
    paymentPolicyId: 'payment_policy_id',
  }[column] as 'vessel_id' | 'child_policy_id' | 'cancellation_policy_id' | 'payment_policy_id';
  const plans = await tx
    .updateTable('rate_plan')
    .set((eb) => ({ version: eb('version', '+', 1n) }))
    .where(col, '=', value)
    .returning(['id', 'vessel_id', 'version'])
    .execute();
  await emitEvents(
    tx,
    ctx,
    plans.map((plan) => ({
      type: 'rate.changed',
      resource: 'rate_plan',
      resourceId: plan.id,
      version: plan.version,
      payload: { vessel_id: plan.vessel_id, cause },
    })),
  );
}

async function usedByPlans(tx: Tx, column: string, id: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    select count(*)::int as n from vs.rate_plan where ${sql.ref(column)} = ${id}`.execute(tx);
  return rows[0]!.n;
}

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

function checkPeriods(periods: { from: string; to: string }[]) {
  if (periods.some((p) => p.to < p.from)) refuse('period_backwards');
  const sorted = [...periods].sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 1; i < sorted.length; i += 1)
    if (sorted[i]!.from <= sorted[i - 1]!.to) refuse('periods_overlap');
}

async function insertPeriods(
  tx: Tx,
  ctx: EngineContext,
  vesselId: string,
  seasonId: string,
  periods: { from: BusinessDate; to: BusinessDate }[],
) {
  for (const period of periods)
    await sql`
      insert into vs.season_period (operator_id, vessel_id, season_id, during)
      values (${ctx.operatorId}, ${vesselId}, ${seasonId},
              daterange(${period.from}::date, ${addDays(period.to, 1)}::date))`.execute(tx);
}

export async function addSeason(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createSeasonInput>,
) {
  const data = parseInput(createSeasonInput, input);
  checkPeriods(data.periods);
  return friendly(() =>
    db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
      await lockVessel(tx, data.vesselId);
      const season = await tx
        .insertInto('season')
        .values({
          operator_id: ctx.operatorId,
          vessel_id: data.vesselId,
          code: data.code,
          name: data.name,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await insertPeriods(tx, ctx, data.vesselId, season.id, data.periods);
      await ratesChanged(tx, ctx, { vesselId: data.vesselId }, 'season.created');
      await audit(tx, ctx.operatorId, ctx.actor, {
        action: 'season.created',
        entity: 'season',
        entityId: season.id,
        after: { ...season, periods: data.periods },
      });
      return season;
    }),
  );
}

export const updateSeasonInput = z.object({
  seasonId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  periods: createSeasonInput.shape.periods,
});

/** Name and dates; the code stays (rates and exports use it). New quotes use the new dates. */
export async function updateSeason(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateSeasonInput>,
) {
  const data = parseInput(updateSeasonInput, input);
  checkPeriods(data.periods);
  return friendly(() =>
    db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
      const before = await lockSeason(tx, data.seasonId);
      const { rows: oldPeriods } = await sql<{ from: string; to: string }>`
        select lower(during)::text as from, (upper(during) - 1)::text as to
        from vs.season_period where season_id = ${data.seasonId} order by lower(during)`.execute(
        tx,
      );
      await tx.deleteFrom('season_period').where('season_id', '=', data.seasonId).execute();
      await insertPeriods(tx, ctx, before.vessel_id, data.seasonId, data.periods);
      await tx
        .updateTable('season')
        .set({ name: data.name })
        .where('id', '=', data.seasonId)
        .execute();
      await ratesChanged(tx, ctx, { vesselId: before.vessel_id }, 'season.updated');
      await audit(tx, ctx.operatorId, ctx.actor, {
        action: 'season.updated',
        entity: 'season',
        entityId: data.seasonId,
        before: { name: before.name, periods: oldPeriods },
        after: { name: data.name, periods: data.periods },
      });
    }),
  );
}

/** Only a season with no rates (and so no quotes): otherwise change its dates instead. */
export async function deleteSeason(db: VsDatabase, ctx: EngineContext, seasonId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await lockSeason(tx, seasonId);
    const { rows } = await sql<{ n: number }>`
      select (select count(*)::int from vs.rate where season_id = ${seasonId})
           + (select count(*)::int from vs.quote where season_id = ${seasonId}) as n`.execute(tx);
    if (rows[0]!.n > 0)
      throw new DomainError('INVALID_STATE', {
        message: 'The season has rates',
        details: { reason: 'season_in_use' },
      });
    await tx.deleteFrom('season_period').where('season_id', '=', seasonId).execute();
    await tx.deleteFrom('season').where('id', '=', seasonId).execute();
    await ratesChanged(tx, ctx, { vesselId: before.vessel_id }, 'season.deleted');
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'season.deleted',
      entity: 'season',
      entityId: seasonId,
      before: { code: before.code, name: before.name },
    });
  });
}

async function lockSeason(tx: Tx, seasonId: string) {
  const season = await tx
    .selectFrom('season')
    .selectAll()
    .where('id', '=', seasonId)
    .executeTakeFirst();
  if (!season) throw new DomainError('NOT_FOUND', { message: 'Season not found' });
  await lockVessel(tx, season.vessel_id);
  return season;
}

// ---------------------------------------------------------------------------
// Child policies
// ---------------------------------------------------------------------------

type ChildInput = z.output<typeof createChildPolicyInput>;

/** Bands cover every age from 0 to adultFromAge − 1 exactly once. */
function checkBands(data: ChildInput) {
  const bands = [...data.bands].sort((a, b) => a.ageFrom - b.ageFrom);
  let next = 0;
  for (const band of bands) {
    if (band.ageFrom !== next) refuse('bands_gap', { age: next });
    next = band.ageTo + 1;
  }
  if (next !== data.adultFromAge) refuse('bands_end', { age: data.adultFromAge - 1 });
  return bands;
}

async function writeBands(
  tx: Tx,
  ctx: EngineContext,
  policyId: string,
  bands: ChildInput['bands'],
) {
  await tx
    .insertInto('child_policy_band')
    .values(
      bands.map((band) => ({
        operator_id: ctx.operatorId,
        child_policy_id: policyId,
        age_from: band.ageFrom,
        age_to: band.ageTo,
        basis: band.basis,
        percent_bps: band.percentBps ?? null,
        fixed_amount: band.fixedAmount ?? null,
        fixed_currency: band.fixedCurrency ?? null,
        requires_two_adults: band.requiresTwoAdults,
      })),
    )
    .execute();
}

const serialBands = (bands: ChildInput['bands']) =>
  bands.map((b) => ({ ...b, fixedAmount: b.fixedAmount?.toString() }));

export async function addChildPolicy(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createChildPolicyInput>,
) {
  const data = parseInput(createChildPolicyInput, input);
  const bands = checkBands(data);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const policy = await tx
      .insertInto('child_policy')
      .values({
        operator_id: ctx.operatorId,
        name: data.name,
        adult_from_age: data.adultFromAge,
        max_children_per_cabin: data.maxChildrenPerCabin,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeBands(tx, ctx, policy.id, bands);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'child_policy.created',
      entity: 'child_policy',
      entityId: policy.id,
      after: { ...policy, bands: serialBands(bands) },
    });
    return policy;
  });
}

export const updateChildPolicyInput = createChildPolicyInput.extend({ policyId: z.uuid() });

export async function updateChildPolicy(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateChildPolicyInput>,
) {
  const data = parseInput(updateChildPolicyInput, input);
  const bands = checkBands(data);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('child_policy')
      .selectAll()
      .where('id', '=', data.policyId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Child policy not found' });
    await tx.deleteFrom('child_policy_band').where('child_policy_id', '=', data.policyId).execute();
    await writeBands(tx, ctx, data.policyId, bands);
    await tx
      .updateTable('child_policy')
      .set({
        name: data.name,
        adult_from_age: data.adultFromAge,
        max_children_per_cabin: data.maxChildrenPerCabin,
      })
      .where('id', '=', data.policyId)
      .execute();
    await ratesChanged(tx, ctx, { childPolicyId: data.policyId }, 'child_policy.updated');
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'child_policy.updated',
      entity: 'child_policy',
      entityId: data.policyId,
      before: { name: before.name, adult_from_age: before.adult_from_age },
      after: { name: data.name, adult_from_age: data.adultFromAge, bands: serialBands(bands) },
    });
  });
}

// ---------------------------------------------------------------------------
// Cancellation policies (with amendment fees)
// ---------------------------------------------------------------------------

type CancellationInput = z.output<typeof createCancellationPolicyInput>;

function checkCancellation(data: CancellationInput) {
  if (!data.rules.some((rule) => rule.fromDays === 0)) refuse('needs_day0');
  if (new Set(data.rules.map((r) => r.fromDays)).size !== data.rules.length)
    refuse('duplicate_days');
  for (const fee of data.amendmentFees) {
    if (fee.feeKind === 'flat' && (fee.amount === undefined || !fee.currency)) refuse('fee_amount');
    if (fee.feeKind === 'percent' && fee.percentBps === undefined) refuse('fee_percent');
  }
}

async function writeCancellationRules(
  tx: Tx,
  ctx: EngineContext,
  policyId: string,
  data: CancellationInput,
) {
  await tx
    .insertInto('cancellation_rule')
    .values(
      data.rules.map((rule) => ({
        operator_id: ctx.operatorId,
        cancellation_policy_id: policyId,
        from_days: rule.fromDays,
        penalty_bps: rule.penaltyBps,
      })),
    )
    .execute();
  if (data.amendmentFees.length > 0)
    await tx
      .insertInto('amendment_fee_rule')
      .values(
        data.amendmentFees.map((fee) => ({
          operator_id: ctx.operatorId,
          cancellation_policy_id: policyId,
          change_kind: fee.changeKind,
          from_days: fee.fromDays,
          fee_kind: fee.feeKind,
          amount: fee.feeKind === 'flat' ? (fee.amount ?? null) : null,
          currency: fee.feeKind === 'flat' ? (fee.currency ?? null) : null,
          percent_bps: fee.feeKind === 'percent' ? (fee.percentBps ?? null) : null,
        })),
      )
      .execute();
}

const serialFees = (data: CancellationInput) =>
  data.amendmentFees.map((f) => ({ ...f, amount: f.amount?.toString() }));

export async function addCancellationPolicy(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createCancellationPolicyInput>,
) {
  const data = parseInput(createCancellationPolicyInput, input);
  checkCancellation(data);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const policy = await tx
      .insertInto('cancellation_policy')
      .values({ operator_id: ctx.operatorId, name: data.name })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeCancellationRules(tx, ctx, policy.id, data);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'cancellation_policy.created',
      entity: 'cancellation_policy',
      entityId: policy.id,
      after: { ...policy, rules: data.rules, fees: serialFees(data) },
    });
    return policy;
  });
}

export const updateCancellationPolicyInput = createCancellationPolicyInput.extend({
  policyId: z.uuid(),
});

export async function updateCancellationPolicy(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateCancellationPolicyInput>,
) {
  const data = parseInput(updateCancellationPolicyInput, input);
  checkCancellation(data);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('cancellation_policy')
      .selectAll()
      .where('id', '=', data.policyId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Cancellation policy not found' });
    const oldRules = await tx
      .selectFrom('cancellation_rule')
      .select(['from_days', 'penalty_bps'])
      .where('cancellation_policy_id', '=', data.policyId)
      .orderBy('from_days', 'desc')
      .execute();
    await tx
      .deleteFrom('cancellation_rule')
      .where('cancellation_policy_id', '=', data.policyId)
      .execute();
    await tx
      .deleteFrom('amendment_fee_rule')
      .where('cancellation_policy_id', '=', data.policyId)
      .execute();
    await writeCancellationRules(tx, ctx, data.policyId, data);
    await tx
      .updateTable('cancellation_policy')
      .set({ name: data.name })
      .where('id', '=', data.policyId)
      .execute();
    await ratesChanged(
      tx,
      ctx,
      { cancellationPolicyId: data.policyId },
      'cancellation_policy.updated',
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'cancellation_policy.updated',
      entity: 'cancellation_policy',
      entityId: data.policyId,
      before: { name: before.name, rules: oldRules },
      after: { name: data.name, rules: data.rules, fees: serialFees(data) },
    });
  });
}

// ---------------------------------------------------------------------------
// Payment policies
// ---------------------------------------------------------------------------

type PaymentInput = z.output<typeof createPaymentPolicyInput>;

function paymentRow(data: PaymentInput) {
  if (data.autoCancelOverdue && data.autoCancelAfterDays === undefined) refuse('auto_cancel_days');
  return {
    name: data.name,
    deposit_bps: data.depositBps,
    balance_due_days: data.balanceDueDays,
    bank_transfer_hold_hours: data.bankTransferHoldHours,
    card_hold_minutes: data.cardHoldMinutes,
    auto_cancel_overdue: data.autoCancelOverdue,
    auto_cancel_after_days: data.autoCancelOverdue ? (data.autoCancelAfterDays ?? null) : null,
  };
}

export async function addPaymentPolicy(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createPaymentPolicyInput>,
) {
  const data = parseInput(createPaymentPolicyInput, input);
  const row = paymentRow(data);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const policy = await tx
      .insertInto('payment_policy')
      .values({ operator_id: ctx.operatorId, ...row })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'payment_policy.created',
      entity: 'payment_policy',
      entityId: policy.id,
      after: policy,
    });
    return policy;
  });
}

export const updatePaymentPolicyInput = createPaymentPolicyInput.extend({ policyId: z.uuid() });

export async function updatePaymentPolicy(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updatePaymentPolicyInput>,
) {
  const data = parseInput(updatePaymentPolicyInput, input);
  const row = paymentRow(data);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('payment_policy')
      .selectAll()
      .where('id', '=', data.policyId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Payment policy not found' });
    const after = await tx
      .updateTable('payment_policy')
      .set(row)
      .where('id', '=', data.policyId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await ratesChanged(tx, ctx, { paymentPolicyId: data.policyId }, 'payment_policy.updated');
    const { created_at: _c, updated_at: _u, ...beforeRow } = before;
    const { created_at: _c2, updated_at: _u2, ...afterRow } = after;
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'payment_policy.updated',
      entity: 'payment_policy',
      entityId: data.policyId,
      before: beforeRow,
      after: afterRow,
    });
  });
}

// ---------------------------------------------------------------------------
// Deleting an unused policy
// ---------------------------------------------------------------------------

export const deletePolicyInput = z.object({
  kind: z.enum(['child', 'cancellation', 'payment']),
  policyId: z.uuid(),
});

/** A policy no rate plan uses: one set up by mistake, or replaced everywhere. */
export async function deletePolicy(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof deletePolicyInput>,
) {
  const data = parseInput(deletePolicyInput, input);
  const table = {
    child: 'child_policy',
    cancellation: 'cancellation_policy',
    payment: 'payment_policy',
  }[data.kind] as 'child_policy' | 'cancellation_policy' | 'payment_policy';
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom(table)
      .select(['id', 'name'])
      .where('id', '=', data.policyId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Policy not found' });
    if ((await usedByPlans(tx, `${table}_id`, data.policyId)) > 0)
      throw new DomainError('INVALID_STATE', {
        message: 'The policy is used by a rate plan',
        details: { reason: 'policy_in_use' },
      });
    if (data.kind === 'child')
      await tx
        .deleteFrom('child_policy_band')
        .where('child_policy_id', '=', data.policyId)
        .execute();
    if (data.kind === 'cancellation') {
      await tx
        .deleteFrom('cancellation_rule')
        .where('cancellation_policy_id', '=', data.policyId)
        .execute();
      await tx
        .deleteFrom('amendment_fee_rule')
        .where('cancellation_policy_id', '=', data.policyId)
        .execute();
    }
    await tx.deleteFrom(table).where('id', '=', data.policyId).execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: `${table}.deleted`,
      entity: table,
      entityId: data.policyId,
      before: { name: before.name },
    });
  });
}
