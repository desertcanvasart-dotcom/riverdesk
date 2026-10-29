import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { addDays, currencySchema } from '@vs/shared';
import { audit } from '../audit';
import { emitEvents, parseInput, type EngineContext } from '../internal';
import { dateSchema } from '../schedule/setup';

/** Money in minor units: an integer (number or bigint), never a float (rule 10). */
export const minorUnits = z
  .union([z.bigint(), z.number().int()])
  .transform((value) => BigInt(value))
  .refine((value) => value >= 0n, 'Must not be negative');
const bps = z.number().int().min(0).max(10_000);
const upperCode = z.string().regex(/^[A-Z][A-Z0-9_-]{0,23}$/);

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------
export const createSeasonInput = z.object({
  vesselId: z.uuid(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,15}$/),
  name: z.string().min(1).max(100),
  /** Inclusive date ranges. A date may belong to only one season of the vessel. */
  periods: z.array(z.object({ from: dateSchema, to: dateSchema })).min(1),
});

export async function createSeason(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createSeasonInput>,
) {
  const data = parseInput(createSeasonInput, input);
  if (data.periods.some((p) => p.to < p.from))
    throw new DomainError('VALIDATION_FAILED', { message: 'A period ends before it starts' });
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
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
    for (const period of data.periods) {
      await sql`
        insert into vs.season_period (operator_id, vessel_id, season_id, during)
        values (${ctx.operatorId}, ${data.vesselId}, ${season.id}, daterange(${period.from}::date, ${addDays(period.to, 1)}::date))`.execute(
        tx,
      );
    }
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'season.created',
      entity: 'season',
      entityId: season.id,
      after: { ...season, periods: data.periods },
    });
    return season;
  });
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------
const bandSchema = z
  .object({
    ageFrom: z.number().int().min(0),
    ageTo: z.number().int().min(0),
    basis: z.enum(['free', 'percent_of_adult', 'fixed', 'included']),
    percentBps: bps.optional(),
    fixedAmount: minorUnits.optional(),
    fixedCurrency: currencySchema.optional(),
    requiresTwoAdults: z.boolean().default(false),
  })
  .refine((b) => b.ageTo >= b.ageFrom, 'ageTo before ageFrom')
  .refine(
    (b) => (b.basis === 'percent_of_adult') === (b.percentBps !== undefined),
    'percentBps goes with percent_of_adult',
  )
  .refine(
    (b) => (b.basis === 'fixed') === (b.fixedAmount !== undefined && b.fixedCurrency !== undefined),
    'fixedAmount and fixedCurrency go with fixed',
  );

export const createChildPolicyInput = z.object({
  name: z.string().min(1).max(100),
  adultFromAge: z.number().int().min(1).max(18).default(12),
  maxChildrenPerCabin: z.number().int().min(0).max(6).default(2),
  bands: z.array(bandSchema).min(1),
});

/** Bands must cover every age from 0 to adultFromAge − 1 exactly once. */
export async function createChildPolicy(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createChildPolicyInput>,
) {
  const data = parseInput(createChildPolicyInput, input);
  const bands = [...data.bands].sort((a, b) => a.ageFrom - b.ageFrom);
  let next = 0;
  for (const band of bands) {
    if (band.ageFrom !== next)
      throw new DomainError('VALIDATION_FAILED', {
        message: `Child bands must cover age ${next} exactly once`,
      });
    next = band.ageTo + 1;
  }
  if (next !== data.adultFromAge) {
    throw new DomainError('VALIDATION_FAILED', {
      message: `Child bands must end at age ${data.adultFromAge - 1}`,
    });
  }
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
    await tx
      .insertInto('child_policy_band')
      .values(
        bands.map((band) => ({
          operator_id: ctx.operatorId,
          child_policy_id: policy.id,
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
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'child_policy.created',
      entity: 'child_policy',
      entityId: policy.id,
      after: { ...policy, bands },
    });
    return policy;
  });
}

export const createCancellationPolicyInput = z.object({
  name: z.string().min(1).max(100),
  rules: z.array(z.object({ fromDays: z.number().int().min(0), penaltyBps: bps })).min(1),
  amendmentFees: z
    .array(
      z.object({
        changeKind: z.enum(['any', 'date', 'category', 'occupancy', 'cabins', 'guests']),
        fromDays: z.number().int().min(0).default(0),
        feeKind: z.enum(['flat', 'percent']),
        amount: minorUnits.optional(),
        currency: currencySchema.optional(),
        percentBps: bps.optional(),
      }),
    )
    .default([]),
});

export async function createCancellationPolicy(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createCancellationPolicyInput>,
) {
  const data = parseInput(createCancellationPolicyInput, input);
  if (!data.rules.some((rule) => rule.fromDays === 0)) {
    throw new DomainError('VALIDATION_FAILED', {
      message: 'A rule for 0 days before embarkation is required',
    });
  }
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const policy = await tx
      .insertInto('cancellation_policy')
      .values({ operator_id: ctx.operatorId, name: data.name })
      .returningAll()
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('cancellation_rule')
      .values(
        data.rules.map((rule) => ({
          operator_id: ctx.operatorId,
          cancellation_policy_id: policy.id,
          from_days: rule.fromDays,
          penalty_bps: rule.penaltyBps,
        })),
      )
      .execute();
    if (data.amendmentFees.length > 0) {
      await tx
        .insertInto('amendment_fee_rule')
        .values(
          data.amendmentFees.map((fee) => ({
            operator_id: ctx.operatorId,
            cancellation_policy_id: policy.id,
            change_kind: fee.changeKind,
            from_days: fee.fromDays,
            fee_kind: fee.feeKind,
            amount: fee.amount ?? null,
            currency: fee.currency ?? null,
            percent_bps: fee.percentBps ?? null,
          })),
        )
        .execute();
    }
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'cancellation_policy.created',
      entity: 'cancellation_policy',
      entityId: policy.id,
      after: { ...policy, rules: data.rules },
    });
    return policy;
  });
}

export const createPaymentPolicyInput = z.object({
  name: z.string().min(1).max(100),
  depositBps: bps.default(2500),
  balanceDueDays: z.number().int().min(0).default(30),
  autoCancelOverdue: z.boolean().default(false),
  autoCancelAfterDays: z.number().int().min(0).optional(),
});

export async function createPaymentPolicy(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createPaymentPolicyInput>,
) {
  const data = parseInput(createPaymentPolicyInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const policy = await tx
      .insertInto('payment_policy')
      .values({
        operator_id: ctx.operatorId,
        name: data.name,
        deposit_bps: data.depositBps,
        balance_due_days: data.balanceDueDays,
        auto_cancel_overdue: data.autoCancelOverdue,
        auto_cancel_after_days: data.autoCancelAfterDays ?? null,
      })
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

// ---------------------------------------------------------------------------
// Rate plans, rates, supplements
// ---------------------------------------------------------------------------
const bilingual = z.object({
  en: z.array(z.string()).default([]),
  ar: z.array(z.string()).default([]),
});

export const createRatePlanInput = z.object({
  vesselId: z.uuid(),
  code: upperCode,
  name: z.string().min(1).max(100),
  market: z.string().regex(/^[a-z][a-z_]{1,31}$/),
  currency: currencySchema,
  board: z.string().min(1).max(50).default('full_board'),
  pricingUnit: z.enum(['per_person', 'per_cabin']),
  pricingPeriod: z.enum(['per_night', 'per_package']),
  minNights: z.number().int().min(1).default(1),
  childPolicyId: z.uuid(),
  cancellationPolicyId: z.uuid(),
  paymentPolicyId: z.uuid(),
  inclusions: bilingual.default({ en: [], ar: [] }),
  exclusions: bilingual.default({ en: [], ar: [] }),
});

export async function createRatePlan(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createRatePlanInput>,
) {
  const data = parseInput(createRatePlanInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
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
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'rate_plan.created',
      entity: 'rate_plan',
      entityId: plan.id,
      after: plan,
    });
    return plan;
  });
}

export const setRatesInput = z.object({
  ratePlanId: z.uuid(),
  rates: z
    .array(
      z.object({
        categoryId: z.uuid(),
        seasonId: z.uuid(),
        sailingPatternId: z.uuid().optional(),
        basis: z.enum(['single', 'double', 'triple']).optional(),
        amount: minorUnits,
      }),
    )
    .min(1)
    .max(2000),
});

/**
 * Creates or replaces rates. Existing quotes and bookings keep their frozen prices; new quotes
 * use the new amounts. Emits rate.changed for the plan.
 */
export async function setRates(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof setRatesInput>,
) {
  const data = parseInput(setRatesInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const plan = await tx
      .selectFrom('rate_plan')
      .selectAll()
      .where('id', '=', data.ratePlanId)
      .forUpdate()
      .executeTakeFirst();
    if (!plan) throw new DomainError('NOT_FOUND', { message: 'Rate plan not found' });
    for (const rate of data.rates) {
      if ((plan.pricing_unit === 'per_person') !== (rate.basis !== undefined)) {
        throw new DomainError('VALIDATION_FAILED', {
          message: 'Per-person rates need a basis; per-cabin rates have none',
        });
      }
      if ((plan.pricing_period === 'per_package') !== (rate.sailingPatternId !== undefined)) {
        throw new DomainError('VALIDATION_FAILED', {
          message: 'Package rates need a sailing pattern; nightly rates have none',
        });
      }
    }
    for (const rate of data.rates) {
      await sql`
        insert into vs.rate (operator_id, vessel_id, rate_plan_id, category_id, season_id, sailing_pattern_id, basis, amount)
        values (${ctx.operatorId}, ${plan.vessel_id}, ${plan.id}, ${rate.categoryId}, ${rate.seasonId},
                ${rate.sailingPatternId ?? null}, ${rate.basis ?? null}, ${rate.amount})
        on conflict (rate_plan_id, category_id, season_id,
                     coalesce(sailing_pattern_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(basis, '-'))
        do update set amount = excluded.amount`.execute(tx);
    }
    const updated = await tx
      .updateTable('rate_plan')
      .set((eb) => ({ version: eb('version', '+', 1n) }))
      .where('id', '=', plan.id)
      .returning('version')
      .executeTakeFirstOrThrow();
    await emitEvents(tx, ctx, [
      {
        type: 'rate.changed',
        resource: 'rate_plan',
        resourceId: plan.id,
        version: updated.version,
        payload: { vessel_id: plan.vessel_id, rates: data.rates.length },
      },
    ]);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'rates.set',
      entity: 'rate_plan',
      entityId: plan.id,
      after: { rates: data.rates.map((r) => ({ ...r, amount: r.amount.toString() })) },
    });
    return { ratePlanId: plan.id, version: updated.version };
  });
}

export const createSupplementInput = z.object({
  ratePlanId: z.uuid(),
  code: upperCode,
  kind: z.enum(['gala', 'peak', 'other']),
  nameEn: z.string().min(1).max(100),
  nameAr: z.string().min(1).max(100),
  dateFrom: dateSchema,
  dateTo: dateSchema,
  amountAdult: minorUnits,
  amountChild: minorUnits,
  mandatory: z.boolean().default(true),
});

export async function createSupplement(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createSupplementInput>,
) {
  const data = parseInput(createSupplementInput, input);
  if (data.dateTo < data.dateFrom)
    throw new DomainError('VALIDATION_FAILED', { message: 'dateTo is before dateFrom' });
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const supplement = await tx
      .insertInto('supplement')
      .values({
        operator_id: ctx.operatorId,
        rate_plan_id: data.ratePlanId,
        code: data.code,
        kind: data.kind,
        name_en: data.nameEn,
        name_ar: data.nameAr,
        date_from: data.dateFrom,
        date_to: data.dateTo,
        amount_adult: data.amountAdult,
        amount_child: data.amountChild,
        mandatory: data.mandatory,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'supplement.created',
      entity: 'supplement',
      entityId: supplement.id,
      after: supplement,
    });
    return supplement;
  });
}

// ---------------------------------------------------------------------------
// Channels and contracts
// ---------------------------------------------------------------------------
export const createChannelInput = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
  name: z.string().min(1).max(100),
  type: z.enum(['back_office', 'agent', 'portal', 'api']),
  creditAllowed: z.boolean().default(false),
  creditLimit: minorUnits.optional(),
  creditCurrency: currencySchema.optional(),
});

export async function createChannel(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createChannelInput>,
) {
  const data = parseInput(createChannelInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const channel = await tx
      .insertInto('channel')
      .values({
        operator_id: ctx.operatorId,
        code: data.code,
        name: data.name,
        type: data.type,
        credit_allowed: data.creditAllowed,
        credit_limit: data.creditLimit ?? null,
        credit_currency: data.creditCurrency ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'channel.created',
      entity: 'channel',
      entityId: channel.id,
      after: channel,
    });
    return channel;
  });
}

export const createContractInput = z.object({
  channelId: z.uuid(),
  vesselId: z.uuid(),
  allocation: z.enum(['pool', 'allotment', 'on_request']),
  paymentMode: z.enum(['channel_collected', 'vessel_prepaid', 'credit']),
  priceAdjustment: z.enum(['none', 'markup', 'commission']).default('none'),
  adjustmentBps: bps.default(0),
  visibleFreeCap: z.number().int().min(0).optional(),
  /** Defaults come from operator settings. */
  checkoutHoldMinutes: z.number().int().positive().optional(),
  optionHoldHours: z.number().int().positive().optional(),
  requestSlaHours: z.number().int().positive().optional(),
  stopSell: z.boolean().default(false),
  validFrom: dateSchema,
  validTo: dateSchema.optional(),
  categoryIds: z.array(z.uuid()).min(1),
  ratePlanIds: z.array(z.uuid()).min(1),
  /** Invoicing: days the agency has to pay an invoice (else the company default). */
  creditTermsDays: z.number().int().min(0).max(365).optional(),
  contractRef: z.string().trim().min(1).max(60).optional(),
  /** Over the credit limit: block (a request for approval) or warn (confirm, and say so). */
  creditLimitMode: z.enum(['warn', 'block']).default('block'),
});

export async function createContract(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createContractInput>,
) {
  const data = parseInput(createContractInput, input);
  if (data.priceAdjustment === 'none' && data.adjustmentBps !== 0) {
    throw new DomainError('VALIDATION_FAILED', {
      message: 'adjustmentBps needs a markup or commission',
    });
  }
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const settings = await tx.selectFrom('operator_setting').selectAll().executeTakeFirstOrThrow();
    const contract = await tx
      .insertInto('channel_contract')
      .values({
        operator_id: ctx.operatorId,
        channel_id: data.channelId,
        vessel_id: data.vesselId,
        allocation: data.allocation,
        payment_mode: data.paymentMode,
        price_adjustment: data.priceAdjustment,
        adjustment_bps: data.adjustmentBps,
        visible_free_cap: data.visibleFreeCap ?? null,
        checkout_hold_minutes: data.checkoutHoldMinutes ?? settings.checkout_hold_minutes,
        option_hold_hours: data.optionHoldHours ?? settings.option_hold_hours,
        request_sla_hours: data.requestSlaHours ?? settings.request_sla_hours,
        stop_sell: data.stopSell,
        valid_from: data.validFrom,
        valid_to: data.validTo ?? null,
        credit_terms_days: data.creditTermsDays ?? null,
        contract_ref: data.contractRef ?? null,
        credit_limit_mode: data.creditLimitMode,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('channel_contract_category')
      .values(
        data.categoryIds.map((id) => ({
          operator_id: ctx.operatorId,
          contract_id: contract.id,
          category_id: id,
        })),
      )
      .execute();
    await tx
      .insertInto('channel_contract_rate_plan')
      .values(
        data.ratePlanIds.map((id) => ({
          operator_id: ctx.operatorId,
          contract_id: contract.id,
          rate_plan_id: id,
        })),
      )
      .execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'channel_contract.created',
      entity: 'channel_contract',
      entityId: contract.id,
      after: { ...contract, category_ids: data.categoryIds, rate_plan_ids: data.ratePlanIds },
    });
    return contract;
  });
}

export const updateContractInput = z.object({
  contractId: z.uuid(),
  stopSell: z.boolean().optional(),
  priceAdjustment: z.enum(['none', 'markup', 'commission']).optional(),
  adjustmentBps: bps.optional(),
  visibleFreeCap: z.number().int().min(0).nullable().optional(),
  active: z.boolean().optional(),
  creditTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  contractRef: z.string().trim().min(1).max(60).nullable().optional(),
  creditLimitMode: z.enum(['warn', 'block']).optional(),
  /** Extras E2: the agency pays its guests' folios. */
  folioToAgency: z.boolean().optional(),
});

export async function updateContract(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateContractInput>,
) {
  const data = parseInput(updateContractInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('channel_contract')
      .selectAll()
      .where('id', '=', data.contractId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Contract not found' });
    const after = await tx
      .updateTable('channel_contract')
      .set({
        ...(data.stopSell !== undefined ? { stop_sell: data.stopSell } : {}),
        ...(data.priceAdjustment !== undefined ? { price_adjustment: data.priceAdjustment } : {}),
        ...(data.adjustmentBps !== undefined ? { adjustment_bps: data.adjustmentBps } : {}),
        ...(data.visibleFreeCap !== undefined ? { visible_free_cap: data.visibleFreeCap } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...(data.creditTermsDays !== undefined ? { credit_terms_days: data.creditTermsDays } : {}),
        ...(data.contractRef !== undefined ? { contract_ref: data.contractRef } : {}),
        ...(data.creditLimitMode !== undefined ? { credit_limit_mode: data.creditLimitMode } : {}),
        ...(data.folioToAgency !== undefined ? { folio_to_agency: data.folioToAgency } : {}),
      })
      .where('id', '=', data.contractId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'channel_contract.updated',
      entity: 'channel_contract',
      entityId: after.id,
      before,
      after,
    });
    return after;
  });
}
