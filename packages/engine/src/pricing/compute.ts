import { DomainError } from '@vs/contracts';
import { addDays, mulDivHalfUp, type BusinessDate } from '@vs/shared';

/**
 * Pure price arithmetic (spec § Pricing). All amounts are integer minor units in the rate plan's
 * currency. Rounding: each line is rounded once, half-up; totals are sums of rounded lines.
 */

export interface PlanTerms {
  currency: string;
  pricingUnit: 'per_person' | 'per_cabin';
  pricingPeriod: 'per_night' | 'per_package';
}

export interface ChildBand {
  ageFrom: number;
  ageTo: number;
  basis: 'free' | 'percent_of_adult' | 'fixed' | 'included';
  percentBps: number | null;
  fixedAmount: bigint | null;
  fixedCurrency: string | null;
  requiresTwoAdults: boolean;
}

export interface ChildTerms {
  adultFromAge: number;
  maxChildrenPerCabin: number;
  bands: ChildBand[];
}

export interface CategoryTerms {
  id: string;
  code: string;
  maxAdults: number;
  maxOccupancy: number;
}

/** Rates for one category in the season: by basis (per person) or `cabin` (per cabin). */
export type CategoryRates = Partial<Record<'single' | 'double' | 'triple' | 'cabin', bigint>>;

export interface SupplementTerms {
  code: string;
  name: string;
  dateFrom: BusinessDate;
  dateTo: BusinessDate;
  amountAdult: bigint;
  amountChild: bigint;
}

export interface Adjustment {
  kind: 'none' | 'markup' | 'commission';
  bps: number;
}

export interface CabinRequest {
  categoryId: string;
  adults: number;
  /** Ages on the embark date. */
  childAges: number[];
}

export type LineKind = 'adult' | 'child' | 'cabin' | 'supplement' | 'markup' | 'commission';

export interface PriceLine {
  cabin: number;
  kind: LineKind;
  label: string;
  /** For guest lines: 'single' | 'double' | 'triple' | 'child_band' | 'child_as_adult' ... */
  basis?: string;
  age?: number;
  unitAmount: bigint;
  quantity: number;
  amount: bigint;
  /** Commission lines are information for the channel; they are not part of the total. */
  inTotal: boolean;
}

export interface PriceResult {
  currency: string;
  lines: PriceLine[];
  total: bigint;
  netTotal: bigint;
}

function invalid(cabin: number, message: string, details: Record<string, unknown> = {}): never {
  throw new DomainError('INVALID_OCCUPANCY', { message, details: { cabin, ...details } });
}

/** Nights of a stay that fall inside a supplement's dates: embark … the night before disembarking. */
export function nightsInRange(
  embark: BusinessDate,
  nights: number,
  from: BusinessDate,
  to: BusinessDate,
): number {
  let count = 0;
  for (let i = 0; i < nights; i += 1) {
    const night = addDays(embark, i);
    if (night >= from && night <= to) count += 1;
  }
  return count;
}

function basisFor(payers: number): 'single' | 'double' | 'triple' {
  return payers === 1 ? 'single' : payers === 2 ? 'double' : 'triple';
}

function noRate(details: Record<string, unknown>): never {
  throw new DomainError('NO_RATE_FOR_SEASON', { details });
}

export function computePrice(options: {
  plan: PlanTerms;
  child: ChildTerms;
  categories: Map<string, CategoryTerms>;
  rates: Map<string, CategoryRates>;
  supplements: SupplementTerms[];
  adjustment: Adjustment;
  embarkDate: BusinessDate;
  nights: number;
  cabins: CabinRequest[];
}): PriceResult {
  const { plan, child } = options;
  const period = plan.pricingPeriod === 'per_night' ? options.nights : 1;
  const lines: PriceLine[] = [];

  options.cabins.forEach((request, cabin) => {
    const category = options.categories.get(request.categoryId);
    if (!category) invalid(cabin, 'Unknown category');
    const children = request.childAges;
    if (request.adults < 1) invalid(cabin, 'Every cabin needs at least one adult');
    if (request.adults > category.maxAdults)
      invalid(cabin, `At most ${category.maxAdults} adults in ${category.code}`);
    if (request.adults + children.length > category.maxOccupancy) {
      invalid(cabin, `At most ${category.maxOccupancy} guests in ${category.code}`);
    }
    if (children.length > child.maxChildrenPerCabin)
      invalid(cabin, `At most ${child.maxChildrenPerCabin} children per cabin`);
    if (children.some((age) => !Number.isInteger(age) || age < 0 || age > 17))
      invalid(cabin, 'Child ages must be 0–17');

    // Who pays the adult rate: adults, children at or above the adult age, and children whose
    // band needs two adults when there is only one.
    const asAdults: { age: number }[] = [];
    const banded: { age: number; band: ChildBand }[] = [];
    for (const age of children) {
      if (age >= child.adultFromAge) {
        asAdults.push({ age });
        continue;
      }
      const band = child.bands.find((b) => age >= b.ageFrom && age <= b.ageTo);
      if (!band) invalid(cabin, `No child band for age ${age}`);
      if (band.requiresTwoAdults && request.adults < 2) asAdults.push({ age });
      else banded.push({ age, band });
    }
    const payers = request.adults + asAdults.length;
    const rates = options.rates.get(category.id) ?? {};
    const cabinLines: PriceLine[] = [];

    if (plan.pricingUnit === 'per_person') {
      const basis = basisFor(payers);
      const rate = rates[basis] ?? noRate({ cabin, category: category.code, basis });
      for (let i = 0; i < request.adults; i += 1) {
        cabinLines.push({
          cabin,
          kind: 'adult',
          label: `Adult (${basis})`,
          basis,
          unitAmount: rate,
          quantity: period,
          amount: rate * BigInt(period),
          inTotal: true,
        });
      }
      for (const { age } of asAdults) {
        cabinLines.push({
          cabin,
          kind: 'child',
          label: `Child ${age} at adult rate (${basis})`,
          basis: 'child_as_adult',
          age,
          unitAmount: rate,
          quantity: period,
          amount: rate * BigInt(period),
          inTotal: true,
        });
      }
      for (const { age, band } of banded) {
        let amount = 0n;
        let unit = 0n;
        if (band.basis === 'percent_of_adult') {
          // A percentage of the adult double rate (spec § Pricing), rounded once.
          const double =
            rates.double ?? noRate({ cabin, category: category.code, basis: 'double' });
          unit = double;
          amount = mulDivHalfUp(double * BigInt(period), BigInt(band.percentBps!), 10_000n);
        } else if (band.basis === 'fixed') {
          if (band.fixedCurrency !== plan.currency)
            noRate({ cabin, reason: 'child band currency differs from the rate plan' });
          unit = band.fixedAmount!;
          amount = band.fixedAmount! * BigInt(period);
        }
        cabinLines.push({
          cabin,
          kind: 'child',
          label: `Child ${age} (${band.basis})`,
          basis: band.basis,
          age,
          unitAmount: unit,
          quantity: period,
          amount,
          inTotal: true,
        });
      }
    } else {
      const rate = rates.cabin ?? noRate({ cabin, category: category.code, basis: 'cabin' });
      cabinLines.push({
        cabin,
        kind: 'cabin',
        label: `Cabin ${category.code}`,
        unitAmount: rate,
        quantity: period,
        amount: rate * BigInt(period),
        inTotal: true,
      });
      // A per-cabin price covers everyone in the cabin; only `fixed` child bands add to it.
      for (const { age } of asAdults) {
        cabinLines.push({
          cabin,
          kind: 'child',
          label: `Child ${age} (included)`,
          basis: 'included',
          age,
          unitAmount: 0n,
          quantity: period,
          amount: 0n,
          inTotal: true,
        });
      }
      for (const { age, band } of banded) {
        if (band.basis === 'fixed' && band.fixedCurrency !== plan.currency)
          noRate({ cabin, reason: 'child band currency differs from the rate plan' });
        const unit = band.basis === 'fixed' ? band.fixedAmount! : 0n;
        const basis = band.basis === 'fixed' ? 'fixed' : 'included';
        cabinLines.push({
          cabin,
          kind: 'child',
          label: `Child ${age} (${basis})`,
          basis,
          age,
          unitAmount: unit,
          quantity: period,
          amount: unit * BigInt(period),
          inTotal: true,
        });
      }
    }

    // Supplements: per night that falls in the range, per adult-rate guest and per child who is
    // not free.
    const payingChildren = banded.filter(({ band }) => band.basis !== 'free').length;
    for (const supplement of options.supplements) {
      const nights = nightsInRange(
        options.embarkDate,
        options.nights,
        supplement.dateFrom,
        supplement.dateTo,
      );
      if (nights === 0) continue;
      if (payers > 0 && supplement.amountAdult > 0n) {
        const quantity = payers * nights;
        cabinLines.push({
          cabin,
          kind: 'supplement',
          label: `${supplement.name} (adult)`,
          basis: supplement.code,
          unitAmount: supplement.amountAdult,
          quantity,
          amount: supplement.amountAdult * BigInt(quantity),
          inTotal: true,
        });
      }
      if (payingChildren > 0 && supplement.amountChild > 0n) {
        const quantity = payingChildren * nights;
        cabinLines.push({
          cabin,
          kind: 'supplement',
          label: `${supplement.name} (child)`,
          basis: supplement.code,
          unitAmount: supplement.amountChild,
          quantity,
          amount: supplement.amountChild * BigInt(quantity),
          inTotal: true,
        });
      }
    }

    // Channel rule, one line per cabin, rounded once.
    const base = cabinLines.reduce((sum, line) => sum + line.amount, 0n);
    if (options.adjustment.kind !== 'none' && options.adjustment.bps > 0) {
      const amount = mulDivHalfUp(base, BigInt(options.adjustment.bps), 10_000n);
      cabinLines.push({
        cabin,
        kind: options.adjustment.kind,
        label: options.adjustment.kind === 'markup' ? 'Channel markup' : 'Channel commission',
        unitAmount: base,
        quantity: 1,
        amount,
        inTotal: options.adjustment.kind === 'markup',
      });
    }
    lines.push(...cabinLines);
  });

  const total = lines.filter((line) => line.inTotal).reduce((sum, line) => sum + line.amount, 0n);
  const commission = lines
    .filter((line) => line.kind === 'commission')
    .reduce((sum, line) => sum + line.amount, 0n);
  return { currency: plan.currency, lines, total, netTotal: total - commission };
}
