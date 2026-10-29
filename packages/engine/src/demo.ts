import type { VsDatabase } from '@vs/db';
import { addDays, isoWeekday, type BusinessDate } from '@vs/shared';
import { cairoToday, type EngineContext } from './internal';
import { applyAmendment, quoteAmendment } from './booking/amendments';
import { createAllotment } from './booking/allotments';
import { cancelBooking } from './booking/cancel';
import { confirmHold, createHold } from './booking/holds';
import { createRequest } from './booking/requests';
import { changeCapacity } from './inventory/capacity';
import type { GuestInput } from './booking/common';
import { createQuote } from './pricing/quote';
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
/** Times are Cairo local; they print on the daily programme and the guest's pre-departure sheet. */
const DEMO_STOPS: {
  port: string;
  day: number;
  boarding: boolean;
  arrive?: string;
  depart?: string;
}[] = [
  { port: 'LXR', day: 0, boarding: true, arrive: '08:00', depart: '15:00' },
  { port: 'ESN', day: 0, boarding: false, arrive: '19:00', depart: '22:00' },
  { port: 'EDF', day: 1, boarding: false, arrive: '07:00', depart: '11:00' },
  { port: 'KOM', day: 2, boarding: false, arrive: '08:00', depart: '10:30' },
  { port: 'ASW', day: 4, boarding: true, arrive: '08:00', depart: '13:00' },
  { port: 'KOM', day: 5, boarding: false, arrive: '08:00', depart: '10:00' },
  { port: 'EDF', day: 5, boarding: false, arrive: '15:00', depart: '17:00' },
  { port: 'ESN', day: 6, boarding: false, arrive: '08:00', depart: '11:00' },
  { port: 'LXR', day: 7, boarding: true, arrive: '08:00' },
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
    /** Fill this company's own vessel (it must have no cabins yet) instead of a new one. */
    vesselId?: string;
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

  const vessel = options.vesselId
    ? { id: options.vesselId }
    : await createVessel(db, ctx, {
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
      arriveTime: stop.arrive,
      departTime: stop.depart,
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
  // A company with several demo vessels keeps one nilecrz channel, with a contract per vessel.
  const existingNilecrz = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx.selectFrom('channel').select('id').where('code', '=', 'nilecrz').executeTakeFirst(),
  );
  const nilecrz =
    existingNilecrz ??
    (await createChannel(db, ctx, {
      code: 'nilecrz',
      name: 'nilecrz',
      type: 'portal',
    }));
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
  // A company created with platform:create-company already has its back-office channel.
  const existingBackOffice = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx.selectFrom('channel').select('id').where('type', '=', 'back_office').executeTakeFirst(),
  );
  const backOffice =
    existingBackOffice ??
    (await createChannel(db, ctx, {
      code: 'back-office',
      name: 'Back office (phone, WhatsApp, walk-in)',
      type: 'back_office',
    }));
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

/** The seeded demo operator (packages/db/seed). */
export const DEMO_OPERATOR_ID = '019a0000-0000-7000-8000-000000000001';

/**
 * Sample activity for the demo operator, all through the engine: confirmed bookings, open holds,
 * a prepaid booking waiting for payment, an agency allotment booking, a pending request, one
 * cancellation and one amendment. For looking around locally; tests do not use it.
 */
export async function createDemoActivity(
  db: VsDatabase,
  ctx: EngineContext,
  vesselId: string,
  channels: { nilecrz: string; backOffice: string },
) {
  const { categories, plans } = await db.withTenantTx(
    ctx.operatorId,
    ctx.actor,
    async ({ db: tx }) => ({
      categories: Object.fromEntries(
        (
          await tx
            .selectFrom('cabin_category')
            .select(['id', 'code'])
            .where('vessel_id', '=', vesselId)
            .execute()
        ).map((c) => [c.code, c.id]),
      ) as Record<DemoCategoryCode, string>,
      plans: (
        await tx.selectFrom('rate_plan').select('id').where('vessel_id', '=', vesselId).execute()
      ).map((p) => p.id),
    }),
  );
  const monday = nextMonday(await todayInCairo(db));
  const sailing = async (pattern: string, offset: number) => {
    const row = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
      tx
        .selectFrom('sailing')
        .innerJoin('sailing_pattern', 'sailing_pattern.id', 'sailing.pattern_id')
        .select('sailing.id')
        .where('sailing.vessel_id', '=', vesselId)
        .where('sailing_pattern.code', '=', pattern)
        .where('sailing.embark_date', '=', addDays(monday, offset))
        .executeTakeFirstOrThrow(),
    );
    return row.id;
  };
  const quote = (
    channelId: string,
    sailingId: string,
    cabins: { cat: DemoCategoryCode; adults?: number; ages?: number[] }[],
  ) =>
    createQuote(db, ctx, {
      channelId,
      sailingId,
      market: 'international',
      cabins: cabins.map((c) => ({
        categoryId: categories[c.cat],
        adults: c.adults ?? 2,
        childAges: c.ages ?? [],
      })),
    });
  // Made-up check-in details, so the reception's screens and documents look real (Batch D2).
  const NATIONALITIES = ['GB', 'DE', 'US', 'FR', 'IT', 'ES', 'NL', 'AU'];
  const DIETS: GuestInput['dietary'][] = [['vegetarian'], [], ['gluten_free'], [], ['halal'], []];
  let seq = 0;
  const guests = (names: string[][]) =>
    names.map(([first, last], i): GuestInput => {
      seq += 1;
      return {
        cabin: 0,
        firstName: first!,
        lastName: last!,
        lead: i === 0,
        nationality: NATIONALITIES[seq % NATIONALITIES.length],
        passportNumber: `X${String(4_100_000 + seq * 7_919).slice(0, 7)}`,
        passportCountry: NATIONALITIES[seq % NATIONALITIES.length],
        // Every fifth passport runs out soon after the cruise: reception sees a warning.
        passportExpiresOn: (seq % 5 === 0
          ? addDays(monday, 120)
          : addDays(monday, 2_000 + seq * 30)) as GuestInput['passportExpiresOn'],
        visaType: 'e_visa',
        dietary: DIETS[seq % DIETS.length],
        ...(i === 0
          ? {
              arrivalFlight: `MS ${700 + seq}`,
              phone: `+44 7700 900${100 + seq}`,
              // Flying home (Batch D3): the disembarkation and transfer list.
              departureFlight: `MS ${800 + seq}`,
              departureTime: `${String(12 + (seq % 9)).padStart(2, '0')}:${seq % 2 ? '30' : '05'}`,
            }
          : {}),
        ...(seq === 3 ? { occasion: 'honeymoon' as const } : {}),
        ...(seq === 2 ? { occasion: 'birthday' as const, occasionDate: addDays(monday, 23) } : {}),
        ...(seq === 4 ? { allergies: 'Shellfish' } : {}),
      };
    });
  const book = async (
    channelId: string,
    pattern: string,
    offset: number,
    cabins: Parameters<typeof quote>[2],
    who: string[][],
    ref?: string,
  ) => {
    const q = await quote(channelId, await sailing(pattern, offset), cabins);
    const hold = await createHold(db, ctx, { channelId, quoteId: q.id, kind: 'option' });
    return confirmHold(db, ctx, {
      holdId: hold.holdId,
      guests: guests(who),
      ...(ref ? { channelRef: ref } : {}),
    });
  };

  // nilecrz bookings, confirmed at once (nilecrz collects payment).
  await book(
    channels.nilecrz,
    'LXR-4',
    0,
    [{ cat: 'STD' }],
    [
      ['Emma', 'Clarke'],
      ['James', 'Clarke'],
    ],
    'NC-50211',
  );
  await book(
    channels.nilecrz,
    'LXR-7',
    0,
    [{ cat: 'SUP', ages: [8] }],
    [
      ['Lukas', 'Weber'],
      ['Anna', 'Weber'],
    ],
    'NC-50214',
  );
  await book(
    channels.nilecrz,
    'ASW-3',
    4,
    [{ cat: 'JS' }, { cat: 'STD', adults: 1 }],
    [['Sofia', 'Rossi']],
    'NC-50230',
  );
  await book(
    channels.nilecrz,
    'ASW-7',
    11,
    [{ cat: 'RS' }],
    [
      ['Hiro', 'Tanaka'],
      ['Yuki', 'Tanaka'],
    ],
    'NC-50247',
  );
  await book(
    channels.nilecrz,
    'LXR-4',
    14,
    [{ cat: 'STD', ages: [4] }],
    [['Marie', 'Dubois']],
    'NC-50260',
  );
  const amended = await book(
    channels.nilecrz,
    'LXR-7',
    21,
    [{ cat: 'STD' }],
    [['Carlos', 'Mendes']],
    'NC-50275',
  );
  const cancelled = await book(
    channels.nilecrz,
    'LXR-4',
    28,
    [{ cat: 'SUP' }],
    [['Olga', 'Ivanova']],
    'NC-50290',
  );

  // Open holds: two options and a checkout in progress.
  await createHold(db, ctx, {
    channelId: channels.nilecrz,
    quoteId: (
      await quote(channels.nilecrz, await sailing('LXR-4', 7), [{ cat: 'STD' }, { cat: 'STD' }])
    ).id,
    kind: 'option',
  });
  await createHold(db, ctx, {
    channelId: channels.nilecrz,
    quoteId: (await quote(channels.nilecrz, await sailing('ASW-3', 18), [{ cat: 'JS' }])).id,
    kind: 'option',
  });
  await createHold(db, ctx, {
    channelId: channels.nilecrz,
    quoteId: (await quote(channels.nilecrz, await sailing('LXR-7', 35), [{ cat: 'SUP' }])).id,
    kind: 'checkout',
  });

  // A phone booking taken in the back office: prepaid, waiting for the deposit (24 h hold).
  await book(
    channels.backOffice,
    'LXR-7',
    14,
    [{ cat: 'JS', ages: [10] }],
    [
      ['Ahmed', 'Mostafa'],
      ['Nour', 'Mostafa'],
    ],
  );

  // An agency with credit and its own allotment of 2 standard cabins on weeks 3–6.
  const agency = await createChannel(db, ctx, {
    code: 'cairo-travel',
    name: 'Cairo Travel (agent)',
    type: 'agent',
    creditAllowed: true,
    creditLimit: 2_000_000,
    creditCurrency: 'USD',
  });
  await createContract(db, ctx, {
    channelId: agency.id,
    vesselId,
    allocation: 'pool',
    paymentMode: 'credit',
    priceAdjustment: 'commission',
    adjustmentBps: 1000,
    validFrom: monday,
    categoryIds: Object.values(categories),
    ratePlanIds: plans,
  });
  const allotmentLegs = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx
      .selectFrom('leg')
      .select('id')
      .where('vessel_id', '=', vesselId)
      .where('depart_date', '>=', addDays(monday, 14))
      .where('depart_date', '<', addDays(monday, 42))
      .execute(),
  );
  await createAllotment(db, ctx, {
    channelId: agency.id,
    vesselId,
    legIds: allotmentLegs.map((l) => l.id),
    categories: [{ categoryId: categories.STD, cabins: 2 }],
  });
  await book(
    agency.id,
    'LXR-4',
    21,
    [{ cat: 'STD' }],
    [
      ['Mohamed', 'Ali'],
      ['Sara', 'Ali'],
    ],
  );

  // An agency that books on request: one request waiting for staff.
  const requests = await createChannel(db, ctx, {
    code: 'aswan-tours',
    name: 'Aswan Tours (on request)',
    type: 'agent',
    creditAllowed: true,
    creditLimit: 2_000_000,
    creditCurrency: 'USD',
  });
  await createContract(db, ctx, {
    channelId: requests.id,
    vesselId,
    allocation: 'on_request',
    paymentMode: 'credit',
    validFrom: monday,
    categoryIds: Object.values(categories),
    ratePlanIds: plans,
  });
  await createRequest(db, ctx, {
    channelId: requests.id,
    quoteId: (
      await quote(requests.id, await sailing('ASW-7', 25), [{ cat: 'SUP' }, { cat: 'SUP' }])
    ).id,
    guests: guests([['Group', 'Leader']]),
  });

  // One cancellation (penalty by the policy) and one amendment (7 nights → 4 nights).
  await cancelBooking(db, ctx, { bookingId: cancelled.bookingId, reason: 'Guest changed plans' });
  const change = await quoteAmendment(db, ctx, {
    bookingId: amended.bookingId,
    sailingId: await sailing('LXR-4', 21),
  });
  await applyAmendment(db, ctx, {
    bookingId: amended.bookingId,
    revision: 1,
    amendmentQuoteId: change.quote.id,
  });
}
