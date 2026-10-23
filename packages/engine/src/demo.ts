import type { VsDatabase } from '@vs/db';
import { addDays, isoWeekday, type BusinessDate } from '@vs/shared';
import { cairoToday, type EngineContext } from './internal';
import { changeCapacity } from './inventory/capacity';
import {
  createCancellationPolicy,
  createChannel,
  createChildPolicy,
  createContract,
  createPaymentPolicy,
  createRatePlan,
  createSeason,
  createSupplement,
  setRates,
} from './pricing/setup';
import {
  createCabinCategory,
  createPort,
  createSailingPattern,
  createScheduleTemplate,
  createVessel,
} from './schedule/setup';

/** Ports seeded for every demo operator (prompt § Batch 1, plus Cairo). */
export const DEMO_PORTS = [
  { code: 'LXR', nameEn: 'Luxor', nameAr: 'الأقصر' },
  { code: 'ESN', nameEn: 'Esna', nameAr: 'إسنا' },
  { code: 'EDF', nameEn: 'Edfu', nameAr: 'إدفو' },
  { code: 'KOM', nameEn: 'Kom Ombo', nameAr: 'كوم أمبو' },
  { code: 'ASW', nameEn: 'Aswan', nameAr: 'أسوان' },
  { code: 'DEN', nameEn: 'Dendera', nameAr: 'دندرة' },
  { code: 'ABY', nameEn: 'Abydos', nameAr: 'أبيدوس' },
  { code: 'ABS', nameEn: 'Abu Simbel', nameAr: 'أبو سمبل' },
  { code: 'CAI', nameEn: 'Cairo', nameAr: 'القاهرة' },
] as const;

/** 4 categories, 30 cabins. */
export const DEMO_CATEGORIES = [
  {
    code: 'STD',
    nameEn: 'Standard',
    nameAr: 'قياسية',
    deck: 'Main',
    maxAdults: 3,
    maxOccupancy: 3,
    cabins: 12,
    firstNumber: 101,
  },
  {
    code: 'SUP',
    nameEn: 'Superior',
    nameAr: 'سوبيريور',
    deck: 'Upper',
    maxAdults: 3,
    maxOccupancy: 3,
    cabins: 10,
    firstNumber: 201,
  },
  {
    code: 'JS',
    nameEn: 'Junior Suite',
    nameAr: 'جناح صغير',
    deck: 'Upper',
    maxAdults: 2,
    maxOccupancy: 3,
    cabins: 6,
    firstNumber: 301,
  },
  {
    code: 'RS',
    nameEn: 'Royal Suite',
    nameAr: 'جناح ملكي',
    deck: 'Sun',
    maxAdults: 2,
    maxOccupancy: 4,
    cabins: 2,
    firstNumber: 401,
  },
] as const;

export type DemoCategoryCode = (typeof DEMO_CATEGORIES)[number]['code'];

/**
 * Weekly Luxor ⇄ Aswan cycle starting Monday at Luxor. Guests board and leave only at Luxor and
 * Aswan, so there are two legs: A Luxor→Aswan (Mon, 4 nights) and B Aswan→Luxor (Fri, 3 nights).
 * Esna, Edfu and Kom Ombo are calls; making Esna a boarding stop is a data change.
 */
const DEMO_STOPS: { port: string; day: number; boarding: boolean }[] = [
  { port: 'LXR', day: 0, boarding: true },
  { port: 'ESN', day: 0, boarding: false },
  { port: 'EDF', day: 1, boarding: false },
  { port: 'KOM', day: 2, boarding: false },
  { port: 'ASW', day: 4, boarding: true },
  { port: 'KOM', day: 5, boarding: false },
  { port: 'EDF', day: 5, boarding: false },
  { port: 'ESN', day: 6, boarding: false },
  { port: 'LXR', day: 7, boarding: true },
];

/** 4 and 7 nights from Luxor; 3 and 7 nights from Aswan (docs/decisions.md, pilot cruises). */
const DEMO_PATTERNS = [
  {
    code: 'LXR-4',
    nameEn: '4 nights from Luxor',
    nameAr: '٤ ليال من الأقصر',
    embark: 0,
    disembark: 4,
    offset: 0,
  },
  {
    code: 'LXR-7',
    nameEn: '7 nights from Luxor',
    nameAr: '٧ ليال من الأقصر',
    embark: 0,
    disembark: 8,
    offset: 0,
  },
  {
    code: 'ASW-3',
    nameEn: '3 nights from Aswan',
    nameAr: '٣ ليال من أسوان',
    embark: 4,
    disembark: 8,
    offset: 0,
  },
  {
    code: 'ASW-7',
    nameEn: '7 nights from Aswan',
    nameAr: '٧ ليال من أسوان',
    embark: 4,
    disembark: 4,
    offset: 1,
  },
] as const;

export interface DemoVessel {
  vesselId: string;
  templateId: string;
  ports: Record<string, string>;
  categories: Record<DemoCategoryCode, string>;
  cabins: Record<DemoCategoryCode, string[]>;
  patterns: Record<(typeof DEMO_PATTERNS)[number]['code'], string>;
  validFrom: BusinessDate;
}

/** Today in Cairo, by the database clock. */
export async function todayInCairo(db: VsDatabase): Promise<BusinessDate> {
  return db.withLookupTx((tx) => cairoToday(tx));
}

export function nextMonday(from: BusinessDate): BusinessDate {
  const weekday = isoWeekday(from);
  return weekday === 1 ? from : addDays(from, 8 - weekday);
}

/**
 * Creates the demo vessel through the engine: ports, vessel, categories, cabins (from
 * `cabinsFrom`, default today), the weekly template and the four sailing patterns. Does not
 * generate the schedule.
 */
export async function createDemoVessel(
  db: VsDatabase,
  ctx: EngineContext,
  options: {
    code?: string;
    validFrom?: BusinessDate;
    cabinsFrom?: BusinessDate;
    cabins?: Partial<Record<DemoCategoryCode, number>>;
  } = {},
): Promise<DemoVessel> {
  const today = await todayInCairo(db);
  const validFrom = options.validFrom ?? nextMonday(today);
  const cabinsFrom = options.cabinsFrom ?? today;

  const existingPorts = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx.selectFrom('port').select(['id', 'code']).execute(),
  );
  const ports: Record<string, string> = Object.fromEntries(
    existingPorts.map((port) => [port.code, port.id]),
  );
  for (const port of DEMO_PORTS) {
    if (!ports[port.code]) ports[port.code] = (await createPort(db, ctx, port)).id;
  }

  const vessel = await createVessel(db, ctx, {
    code: options.code ?? 'NILEDEMO',
    name: 'MS Nile Demo',
    type: 'cruise_ship',
    maxGuests: 70,
  });

  const categories = {} as Record<DemoCategoryCode, string>;
  const cabins = {} as Record<DemoCategoryCode, string[]>;
  for (const [index, category] of DEMO_CATEGORIES.entries()) {
    const created = await createCabinCategory(db, ctx, {
      vesselId: vessel.id,
      code: category.code,
      nameEn: category.nameEn,
      nameAr: category.nameAr,
      deck: category.deck,
      maxAdults: category.maxAdults,
      maxOccupancy: category.maxOccupancy,
      sortOrder: index,
    });
    categories[category.code] = created.id;
    cabins[category.code] = [];
    const count = options.cabins?.[category.code] ?? category.cabins;
    for (let n = 0; n < count; n += 1) {
      const { cabinId } = await changeCapacity(db, ctx, {
        vesselId: vessel.id,
        effectiveFrom: cabinsFrom,
        change: {
          kind: 'add',
          number: String(category.firstNumber + n),
          categoryId: created.id,
          deck: category.deck,
        },
        reason: 'Initial fleet setup',
      });
      cabins[category.code].push(cabinId);
    }
  }

  const template = await createScheduleTemplate(db, ctx, {
    vesselId: vessel.id,
    name: 'Luxor ⇄ Aswan weekly',
    cycleDays: 7,
    validFrom,
    stops: DEMO_STOPS.map((stop) => ({
      portId: ports[stop.port]!,
      dayOffset: stop.day,
      embarkAllowed: stop.boarding,
      disembarkAllowed: stop.boarding,
    })),
  });

  const patterns = {} as DemoVessel['patterns'];
  for (const pattern of DEMO_PATTERNS) {
    const created = await createSailingPattern(db, ctx, {
      templateId: template.id,
      code: pattern.code,
      nameEn: pattern.nameEn,
      nameAr: pattern.nameAr,
      embarkStopSeq: pattern.embark,
      disembarkStopSeq: pattern.disembark,
      disembarkCycleOffset: pattern.offset,
    });
    patterns[pattern.code] = created.id;
  }

  return {
    vesselId: vessel.id,
    templateId: template.id,
    ports,
    categories,
    cabins,
    patterns,
    validFrom,
  };
}

/** Rounds amount × bps / 10000 to a whole currency unit (minor units, 2 decimals). */
function demoAmount(base: bigint, ...factorsBps: number[]): bigint {
  let value = base;
  for (const bps of factorsBps) value = (value * BigInt(bps) + 5000n) / 10000n;
  return ((value + 50n) / 100n) * 100n;
}

/**
 * Demo pricing for the demo vessel (prompt § Batch 2 seed): rate plans for the international
 * (USD) and Egyptian/resident (EGP) markets, per person per package; high season October–April
 * and low season May–September across the horizon; the pilot child policy; gala dinners on
 * 24 and 31 December; channels nilecrz (pool, no markup, channel collects payment) and the
 * operator's back office.
 */
export async function createDemoPricing(db: VsDatabase, ctx: EngineContext, vesselId: string) {
  const { categories, patterns } = await db.withTenantTx(
    ctx.operatorId,
    ctx.actor,
    async ({ db: tx }) => ({
      categories: await tx
        .selectFrom('cabin_category')
        .select(['id', 'code'])
        .where('vessel_id', '=', vesselId)
        .execute(),
      patterns: await tx
        .selectFrom('sailing_pattern')
        .select(['id', 'code'])
        .where('vessel_id', '=', vesselId)
        .execute(),
    }),
  );
  const today = await todayInCairo(db);
  const year = Number(today.slice(0, 4));
  const startYear = Number(today.slice(5, 7)) >= 10 ? year : year - 1;
  const highPeriods: { from: BusinessDate; to: BusinessDate }[] = [];
  const lowPeriods: { from: BusinessDate; to: BusinessDate }[] = [];
  for (let y = startYear; y < startYear + 3; y += 1) {
    highPeriods.push({ from: `${y}-10-01` as BusinessDate, to: `${y + 1}-04-30` as BusinessDate });
    lowPeriods.push({
      from: `${y + 1}-05-01` as BusinessDate,
      to: `${y + 1}-09-30` as BusinessDate,
    });
  }
  const high = await createSeason(db, ctx, {
    vesselId,
    code: 'HIGH',
    name: 'High season (Oct–Apr)',
    periods: highPeriods,
  });
  const low = await createSeason(db, ctx, {
    vesselId,
    code: 'LOW',
    name: 'Low season (May–Sep)',
    periods: lowPeriods,
  });

  const child = await createChildPolicy(db, ctx, {
    name: 'Pilot child policy',
    adultFromAge: 12,
    maxChildrenPerCabin: 2,
    bands: [
      { ageFrom: 0, ageTo: 1, basis: 'free' },
      {
        ageFrom: 2,
        ageTo: 5,
        basis: 'percent_of_adult',
        percentBps: 2500,
        requiresTwoAdults: true,
      },
      {
        ageFrom: 6,
        ageTo: 11,
        basis: 'percent_of_adult',
        percentBps: 5000,
        requiresTwoAdults: true,
      },
    ],
  });
  const cancellation = await createCancellationPolicy(db, ctx, {
    name: 'Standard cancellation',
    rules: [
      { fromDays: 60, penaltyBps: 0 },
      { fromDays: 30, penaltyBps: 2500 },
      { fromDays: 15, penaltyBps: 5000 },
      { fromDays: 0, penaltyBps: 10000 },
    ],
  });
  const payment = await createPaymentPolicy(db, ctx, {
    name: 'Deposit 25%, balance 30 days before',
  });
  const policies = {
    childPolicyId: child.id,
    cancellationPolicyId: cancellation.id,
    paymentPolicyId: payment.id,
  };
  const inclusions = {
    en: ['Full board on board', 'Guided visits as per itinerary', 'Transfers in Luxor and Aswan'],
    ar: [
      'إقامة كاملة على متن المركب',
      'زيارات بصحبة مرشد حسب البرنامج',
      'الانتقالات في الأقصر وأسوان',
    ],
  };
  const exclusions = {
    en: ['Drinks', 'Tips', 'Visa'],
    ar: ['المشروبات', 'الإكراميات', 'التأشيرة'],
  };

  // Double rate per person, low season, standard cabin; other cells derive from it.
  const markets = [
    {
      code: 'INTL',
      name: 'International (USD)',
      market: 'international',
      currency: 'USD',
      gala: [7500n, 3750n],
      base: { 'LXR-4': 45000n, 'LXR-7': 75000n, 'ASW-3': 35000n, 'ASW-7': 75000n },
    },
    {
      code: 'EGY',
      name: 'Egyptian & resident (EGP)',
      market: 'egyptian_resident',
      currency: 'EGP',
      gala: [250000n, 125000n],
      base: { 'LXR-4': 1200000n, 'LXR-7': 2000000n, 'ASW-3': 950000n, 'ASW-7': 2000000n },
    },
  ] as const;
  const categoryFactor: Record<string, number> = { STD: 10000, SUP: 12000, JS: 16000, RS: 25000 };
  const plans: string[] = [];
  for (const m of markets) {
    const plan = await createRatePlan(db, ctx, {
      vesselId,
      code: m.code,
      name: m.name,
      market: m.market,
      currency: m.currency,
      pricingUnit: 'per_person',
      pricingPeriod: 'per_package',
      ...policies,
      inclusions,
      exclusions,
    });
    plans.push(plan.id);
    const rates = [];
    for (const pattern of patterns) {
      const base = m.base[pattern.code as keyof typeof m.base];
      for (const category of categories) {
        for (const [season, seasonBps] of [
          [low.id, 10000],
          [high.id, 13000],
        ] as const) {
          const double = demoAmount(base, categoryFactor[category.code]!, seasonBps);
          rates.push({
            categoryId: category.id,
            seasonId: season,
            sailingPatternId: pattern.id,
            basis: 'double' as const,
            amount: double,
          });
          rates.push({
            categoryId: category.id,
            seasonId: season,
            sailingPatternId: pattern.id,
            basis: 'single' as const,
            amount: demoAmount(double, 15000),
          });
          if (category.code === 'STD' || category.code === 'SUP') {
            rates.push({
              categoryId: category.id,
              seasonId: season,
              sailingPatternId: pattern.id,
              basis: 'triple' as const,
              amount: demoAmount(double, 9000),
            });
          }
        }
      }
    }
    await setRates(db, ctx, { ratePlanId: plan.id, rates });
    for (let y = startYear; y < startYear + 3; y += 1) {
      for (const day of ['24', '31']) {
        await createSupplement(db, ctx, {
          ratePlanId: plan.id,
          code: `GALA-${y}-12-${day}`,
          kind: 'gala',
          nameEn: day === '24' ? 'Christmas Eve gala dinner' : "New Year's Eve gala dinner",
          nameAr: day === '24' ? 'عشاء ليلة عيد الميلاد' : 'عشاء ليلة رأس السنة',
          dateFrom: `${y}-12-${day}`,
          dateTo: `${y}-12-${day}`,
          amountAdult: m.gala[0],
          amountChild: m.gala[1],
        });
      }
    }
  }

  const allCategories = categories.map((c) => c.id);
  const nilecrz = await createChannel(db, ctx, {
    code: 'nilecrz',
    name: 'nilecrz',
    type: 'portal',
  });
  await createContract(db, ctx, {
    channelId: nilecrz.id,
    vesselId,
    allocation: 'pool',
    paymentMode: 'channel_collected',
    priceAdjustment: 'none',
    validFrom: today,
    categoryIds: allCategories,
    ratePlanIds: plans,
  });
  const backOffice = await createChannel(db, ctx, {
    code: 'back-office',
    name: 'Back office (phone, WhatsApp, walk-in)',
    type: 'back_office',
  });
  await createContract(db, ctx, {
    channelId: backOffice.id,
    vesselId,
    allocation: 'pool',
    paymentMode: 'vessel_prepaid',
    validFrom: today,
    categoryIds: allCategories,
    ratePlanIds: plans,
  });
  return { ratePlanIds: plans, channels: { nilecrz: nilecrz.id, backOffice: backOffice.id } };
}
