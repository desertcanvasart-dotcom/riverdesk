import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { ageOn, type BusinessDate } from '@vs/shared';
import { audit } from '../audit';
import { parseInput, type EngineContext, type Tx } from '../internal';
import { dateSchema } from '../schedule/setup';
import {
  computePrice,
  type CategoryRates,
  type ChildBand,
  type PriceLine,
  type PriceResult,
} from './compute';

const cabinSchema = z.object({
  categoryId: z.uuid(),
  adults: z.number().int().min(0).max(10),
  /** Ages on the embark date … */
  childAges: z.array(z.number().int().min(0).max(17)).default([]),
  /** … or dates of birth; the age on the embark date is computed. */
  childBirthDates: z.array(dateSchema).default([]),
});

export const priceSailingInput = z.object({
  channelId: z.uuid(),
  sailingId: z.uuid(),
  market: z.string().regex(/^[a-z][a-z_]{1,31}$/),
  /** Needed only when the contract offers more than one plan for the market. */
  ratePlanId: z.uuid().optional(),
  cabins: z.array(cabinSchema).min(1).max(20),
});

export type PriceSailingInput = z.input<typeof priceSailingInput>;

export interface PricedSailing extends PriceResult {
  channelId: string;
  contractId: string;
  vesselId: string;
  sailingId: string;
  ratePlanId: string;
  seasonId: string;
  market: string;
  embarkDate: BusinessDate;
  nights: number;
  /** Cabins with ages resolved on the embark date. */
  cabins: { categoryId: string; adults: number; childAges: number[] }[];
  policies: Record<string, unknown>;
  holdTtl: { checkoutMinutes: number; optionHours: number };
}

function forbid(message: string, details: Record<string, unknown> = {}): never {
  throw new DomainError('CONTRACT_FORBIDS', { message, details });
}

/**
 * Prices one sailing for the given cabins, adults and child ages, under the channel's contract
 * (spec § Pricing). Read-only. Refusals: SAILING_CLOSED, CONTRACT_FORBIDS, INVALID_OCCUPANCY,
 * NO_RATE_FOR_SEASON.
 */
export async function priceSailingInTx(tx: Tx, input: PriceSailingInput): Promise<PricedSailing> {
  const data = parseInput(priceSailingInput, input);

  const channel = await tx
    .selectFrom('channel')
    .selectAll()
    .where('id', '=', data.channelId)
    .executeTakeFirst();
  if (!channel) throw new DomainError('NOT_FOUND', { message: 'Channel not found' });
  if (!channel.active) forbid('The channel is not active');

  const sailing = await tx
    .selectFrom('sailing')
    .selectAll()
    .where('id', '=', data.sailingId)
    .executeTakeFirst();
  if (!sailing) throw new DomainError('NOT_FOUND', { message: 'Sailing not found' });
  const { rows: closedLegs } = await sql<{ n: number }>`
    select count(*)::int as n from vs.sailing_leg sl join vs.leg l on l.id = sl.leg_id
    where sl.sailing_id = ${sailing.id} and l.status <> 'open'`.execute(tx);
  if (sailing.status !== 'open' || closedLegs[0]!.n > 0) {
    throw new DomainError('SAILING_CLOSED', {
      details: { sailingId: sailing.id, status: sailing.status },
    });
  }
  const embarkDate = sailing.embark_date as BusinessDate;

  const contract = await tx
    .selectFrom('channel_contract')
    .selectAll()
    .where('channel_id', '=', channel.id)
    .where('vessel_id', '=', sailing.vessel_id)
    .where('active', '=', true)
    .executeTakeFirst();
  if (!contract) forbid('No contract for this vessel');
  if (contract.valid_from > embarkDate || (contract.valid_to && contract.valid_to < embarkDate)) {
    forbid('The contract does not cover this date');
  }
  if (contract.stop_sell) forbid('Sales are stopped for this channel');

  const allowedCategories = new Set(
    (
      await tx
        .selectFrom('channel_contract_category')
        .select('category_id')
        .where('contract_id', '=', contract.id)
        .execute()
    ).map((r) => r.category_id),
  );
  for (const cabin of data.cabins) {
    if (!allowedCategories.has(cabin.categoryId))
      forbid('The contract does not include this category', { categoryId: cabin.categoryId });
  }

  const plans = await tx
    .selectFrom('channel_contract_rate_plan as cr')
    .innerJoin('rate_plan as rp', 'rp.id', 'cr.rate_plan_id')
    .selectAll('rp')
    .where('cr.contract_id', '=', contract.id)
    .where('rp.active', '=', true)
    .where('rp.market', '=', data.market)
    .execute();
  const plan = data.ratePlanId
    ? plans.find((p) => p.id === data.ratePlanId)
    : plans.length === 1
      ? plans[0]
      : undefined;
  if (!plan) {
    if (!data.ratePlanId && plans.length > 1) {
      throw new DomainError('VALIDATION_FAILED', {
        message: 'Several rate plans match; give ratePlanId',
      });
    }
    forbid('The contract has no rate plan for this market', { market: data.market });
  }
  if (sailing.nights < plan.min_nights) {
    throw new DomainError('NO_RATE_FOR_SEASON', {
      details: { reason: 'min_nights', minNights: plan.min_nights },
    });
  }

  const season = await sql<{ season_id: string }>`
    select season_id from vs.season_period
    where vessel_id = ${sailing.vessel_id} and during @> ${embarkDate}::date`.execute(tx);
  const seasonId = season.rows[0]?.season_id;
  if (!seasonId)
    throw new DomainError('NO_RATE_FOR_SEASON', { details: { reason: 'no_season', embarkDate } });

  const categoryIds = [...new Set(data.cabins.map((c) => c.categoryId))];
  const categories = await tx
    .selectFrom('cabin_category')
    .selectAll()
    .where('id', 'in', categoryIds)
    .execute();
  const rateRows = await tx
    .selectFrom('rate')
    .select(['category_id', 'basis', 'amount', 'sailing_pattern_id'])
    .where('rate_plan_id', '=', plan.id)
    .where('season_id', '=', seasonId)
    .where('category_id', 'in', categoryIds)
    .execute();
  const rates = new Map<string, CategoryRates>();
  for (const row of rateRows) {
    if (plan.pricing_period === 'per_package' && row.sailing_pattern_id !== sailing.pattern_id)
      continue;
    const entry = rates.get(row.category_id) ?? {};
    entry[(row.basis ?? 'cabin') as keyof CategoryRates] = row.amount;
    rates.set(row.category_id, entry);
  }

  const childPolicy = await tx
    .selectFrom('child_policy')
    .selectAll()
    .where('id', '=', plan.child_policy_id)
    .executeTakeFirstOrThrow();
  const bands = await tx
    .selectFrom('child_policy_band')
    .selectAll()
    .where('child_policy_id', '=', childPolicy.id)
    .orderBy('age_from')
    .execute();
  const supplements = await tx
    .selectFrom('supplement')
    .selectAll()
    .where('rate_plan_id', '=', plan.id)
    .where('mandatory', '=', true)
    .where('date_from', '<=', sailing.disembark_date)
    .where('date_to', '>=', sailing.embark_date)
    .orderBy('date_from')
    .orderBy('code')
    .execute();

  const cabins = data.cabins.map((cabin) => ({
    categoryId: cabin.categoryId,
    adults: cabin.adults,
    childAges: [...cabin.childAges, ...cabin.childBirthDates.map((dob) => ageOn(dob, embarkDate))],
  }));
  const priced = computePrice({
    plan: {
      currency: plan.currency,
      pricingUnit: plan.pricing_unit as 'per_person' | 'per_cabin',
      pricingPeriod: plan.pricing_period as 'per_night' | 'per_package',
    },
    child: {
      adultFromAge: childPolicy.adult_from_age,
      maxChildrenPerCabin: childPolicy.max_children_per_cabin,
      bands: bands.map((b): ChildBand => ({
        ageFrom: b.age_from,
        ageTo: b.age_to,
        basis: b.basis as ChildBand['basis'],
        percentBps: b.percent_bps,
        fixedAmount: b.fixed_amount,
        fixedCurrency: b.fixed_currency,
        requiresTwoAdults: b.requires_two_adults,
      })),
    },
    categories: new Map(
      categories.map((c) => [
        c.id,
        { id: c.id, code: c.code, maxAdults: c.max_adults, maxOccupancy: c.max_occupancy },
      ]),
    ),
    rates,
    supplements: supplements.map((s) => ({
      code: s.code,
      name: s.name_en,
      dateFrom: s.date_from as BusinessDate,
      dateTo: s.date_to as BusinessDate,
      amountAdult: s.amount_adult,
      amountChild: s.amount_child,
    })),
    adjustment: {
      kind: contract.price_adjustment as 'none' | 'markup' | 'commission',
      bps: contract.adjustment_bps,
    },
    embarkDate,
    nights: sailing.nights,
    cabins,
  });

  return {
    ...priced,
    channelId: channel.id,
    contractId: contract.id,
    vesselId: sailing.vessel_id,
    sailingId: sailing.id,
    ratePlanId: plan.id,
    seasonId,
    market: data.market,
    embarkDate,
    nights: sailing.nights,
    cabins,
    policies: await policySnapshot(tx, plan, childPolicy, bands, contract),
    holdTtl: {
      checkoutMinutes: contract.checkout_hold_minutes,
      optionHours: contract.option_hold_hours,
    },
  };
}

async function policySnapshot(
  tx: Tx,
  plan: {
    id: string;
    code: string;
    name: string;
    board: string;
    market: string;
    currency: string;
    pricing_unit: string;
    pricing_period: string;
    inclusions: unknown;
    exclusions: unknown;
    cancellation_policy_id: string;
    payment_policy_id: string;
  },
  childPolicy: { name: string; adult_from_age: number; max_children_per_cabin: number },
  bands: {
    age_from: number;
    age_to: number;
    basis: string;
    percent_bps: number | null;
    fixed_amount: bigint | null;
    fixed_currency: string | null;
    requires_two_adults: boolean;
  }[],
  contract: {
    payment_mode: string;
    allocation: string;
    price_adjustment: string;
    adjustment_bps: number;
  },
) {
  const cancellation = await tx
    .selectFrom('cancellation_policy')
    .selectAll()
    .where('id', '=', plan.cancellation_policy_id)
    .executeTakeFirstOrThrow();
  const rules = await tx
    .selectFrom('cancellation_rule')
    .select(['from_days', 'penalty_bps'])
    .where('cancellation_policy_id', '=', cancellation.id)
    .orderBy('from_days', 'desc')
    .execute();
  const fees = await tx
    .selectFrom('amendment_fee_rule')
    .select(['change_kind', 'from_days', 'fee_kind', 'amount', 'currency', 'percent_bps'])
    .where('cancellation_policy_id', '=', cancellation.id)
    .execute();
  const payment = await tx
    .selectFrom('payment_policy')
    .selectAll()
    .where('id', '=', plan.payment_policy_id)
    .executeTakeFirstOrThrow();
  return {
    rate_plan: {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      board: plan.board,
      market: plan.market,
      currency: plan.currency,
      pricing_unit: plan.pricing_unit,
      pricing_period: plan.pricing_period,
    },
    inclusions: plan.inclusions,
    exclusions: plan.exclusions,
    cancellation: { name: cancellation.name, rules },
    amendment_fees: fees.map((f) => ({ ...f, amount: f.amount?.toString() ?? null })),
    payment: {
      name: payment.name,
      deposit_bps: payment.deposit_bps,
      balance_due_days: payment.balance_due_days,
      bank_transfer_hold_hours: payment.bank_transfer_hold_hours,
      card_hold_minutes: payment.card_hold_minutes,
      auto_cancel_overdue: payment.auto_cancel_overdue,
      auto_cancel_after_days: payment.auto_cancel_after_days,
    },
    child: {
      name: childPolicy.name,
      adult_from_age: childPolicy.adult_from_age,
      max_children_per_cabin: childPolicy.max_children_per_cabin,
      bands: bands.map((b) => ({ ...b, fixed_amount: b.fixed_amount?.toString() ?? null })),
    },
    contract: {
      payment_mode: contract.payment_mode,
      allocation: contract.allocation,
      price_adjustment: contract.price_adjustment,
      adjustment_bps: contract.adjustment_bps,
    },
  };
}

export async function priceSailing(
  db: VsDatabase,
  ctx: EngineContext,
  input: PriceSailingInput,
): Promise<PricedSailing> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) => priceSailingInTx(tx, input));
}

/** Lines as stored in jsonb: bigint amounts become strings. */
function storedLines(lines: PriceLine[]) {
  return lines.map((line) => ({
    ...line,
    unitAmount: line.unitAmount.toString(),
    amount: line.amount.toString(),
  }));
}

export interface Quote {
  id: string;
  channelId: string;
  contractId: string;
  sailingId: string;
  ratePlanId: string;
  currency: string;
  total: bigint;
  netTotal: bigint;
  lines: ReturnType<typeof storedLines>;
  cabins: unknown;
  policies: Record<string, unknown>;
  expiresAt: Date;
  /** By the database clock at the time of reading. */
  status: 'valid' | 'expired';
}

/**
 * Prices and stores a quote with its lines and policy snapshots. It expires after the longest
 * hold it can back (checkout or option TTL from the contract), so a hold never outlives its quote.
 */
export async function createQuote(
  db: VsDatabase,
  ctx: EngineContext,
  input: PriceSailingInput,
): Promise<Quote> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const priced = await priceSailingInTx(tx, input);
    const { rows } = await sql<{ id: string }>`
      insert into vs.quote (operator_id, channel_id, contract_id, vessel_id, sailing_id, rate_plan_id, season_id,
                            market, currency, cabins, lines, total, net_total, policies, expires_at)
      values (${ctx.operatorId}, ${priced.channelId}, ${priced.contractId}, ${priced.vesselId}, ${priced.sailingId},
              ${priced.ratePlanId}, ${priced.seasonId}, ${priced.market}, ${priced.currency},
              ${JSON.stringify(priced.cabins)}::jsonb, ${JSON.stringify(storedLines(priced.lines))}::jsonb,
              ${priced.total}, ${priced.netTotal}, ${JSON.stringify(priced.policies)}::jsonb,
              now() + greatest(make_interval(mins => ${priced.holdTtl.checkoutMinutes}),
                               make_interval(hours => ${priced.holdTtl.optionHours})))
      returning id`.execute(tx);
    const id = rows[0]!.id;
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'quote.created',
      entity: 'quote',
      entityId: id,
      after: {
        sailing_id: priced.sailingId,
        rate_plan_id: priced.ratePlanId,
        currency: priced.currency,
        total: priced.total,
        net_total: priced.netTotal,
      },
    });
    return loadQuote(tx, id);
  });
}

export async function loadQuote(tx: Tx, quoteId: string): Promise<Quote> {
  const { rows } = await sql<{
    id: string;
    channel_id: string;
    contract_id: string;
    sailing_id: string;
    rate_plan_id: string;
    currency: string;
    total: bigint;
    net_total: bigint;
    lines: Quote['lines'];
    cabins: unknown;
    policies: Record<string, unknown>;
    expires_at: Date;
    expired: boolean;
  }>`select q.*, q.expires_at <= now() as expired from vs.quote q where q.id = ${quoteId}`.execute(
    tx,
  );
  const row = rows[0];
  if (!row) throw new DomainError('NOT_FOUND', { message: 'Quote not found' });
  return {
    id: row.id,
    channelId: row.channel_id,
    contractId: row.contract_id,
    sailingId: row.sailing_id,
    ratePlanId: row.rate_plan_id,
    currency: row.currency,
    total: row.total,
    netTotal: row.net_total,
    lines: row.lines,
    cabins: row.cabins,
    policies: row.policies,
    expiresAt: row.expires_at,
    status: row.expired ? 'expired' : 'valid',
  };
}

export const getQuoteInput = z.object({ quoteId: z.uuid() });

export async function getQuote(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof getQuoteInput>,
): Promise<Quote> {
  const data = parseInput(getQuoteInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) => loadQuote(tx, data.quoteId));
}

/**
 * The quote a hold or request is made from (Batch 3): it must exist, belong to the same channel
 * and not be expired by database time.
 */
export async function useQuote(tx: Tx, quoteId: string, channelId: string): Promise<Quote> {
  const quote = await loadQuote(tx, quoteId);
  if (quote.channelId !== channelId) forbid('The quote belongs to another channel');
  if (quote.status === 'expired') throw new DomainError('QUOTE_EXPIRED', { details: { quoteId } });
  return quote;
}
