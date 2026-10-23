import type { VsDatabase } from '@vs/db';
import { addDays, isoWeekday, type BusinessDate } from '@vs/shared';
import { cairoToday, type EngineContext } from './internal';
import { changeCapacity } from './inventory/capacity';
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
