import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import { addDays, formatMinor, money, type BusinessDate } from '@vs/shared';
import { priceSailing } from '../src/index';
import { pricingWorld, type PricingWorld } from './helpers/pricing-world';

type Cabin = {
  cat: 'STD' | 'SUP' | 'JS' | 'RS';
  adults: number;
  ages?: number[];
  births?: (embark: BusinessDate) => string[];
};
interface Case {
  name: string;
  channel?: keyof PricingWorld['channels'];
  market?: string;
  pattern: 'LXR-4' | 'LXR-7' | 'ASW-3' | 'ASW-7';
  /** Days after M. */
  embark: number;
  cabins: Cabin[];
  /** Expected total in minor units, worked out by hand (comment), or the expected refusal. */
  total?: number;
  net?: number;
  error?: ErrorCode;
  why: string;
}

const yearsBefore = (date: BusinessDate, years: number) =>
  `${Number(date.slice(0, 4)) - years}${date.slice(4)}`;

// Season LOW for embark M … M+13, HIGH for M+14 … M+27. NIGHT plan unless the market says otherwise.
const CASES: Case[] = [
  {
    name: 'Double, 2 adults',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2 }],
    total: 80000,
    why: '2 × 100.00 × 4 nights',
  },
  {
    name: 'Single, 1 adult',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 1 }],
    total: 60000,
    why: '150.00 × 4',
  },
  {
    name: 'Triple, 3 adults',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 3 }],
    total: 96000,
    why: '3 × 80.00 × 4',
  },
  {
    name: 'Infant (1) free',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2, ages: [1] }],
    total: 80000,
    why: '800.00 + 0',
  },
  {
    name: 'Child 3 at 25%',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2, ages: [3] }],
    total: 90000,
    why: '800.00 + 25% × 400.00',
  },
  {
    name: 'Child 7 at 50%',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2, ages: [7] }],
    total: 100000,
    why: '800.00 + 50% × 400.00',
  },
  {
    name: 'Child 11 (top of band) at 50%',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2, ages: [11] }],
    total: 100000,
    why: 'as above',
  },
  {
    name: 'Child 12 pays adult: triple basis',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2, ages: [12] }],
    total: 96000,
    why: '3 × 80.00 × 4',
  },
  {
    name: 'Child turning 6 on the embark date',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2, births: (e) => [yearsBefore(e, 6)] }],
    total: 100000,
    why: 'age 6 → 50%',
  },
  {
    name: 'Child turning 6 the day after embarking',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [
      { cat: 'STD', adults: 2, births: (e) => [addDays(yearsBefore(e, 6) as BusinessDate, 1)] },
    ],
    total: 90000,
    why: 'still 5 → 25%',
  },
  {
    name: 'One adult + child 7: both pay adult double',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 1, ages: [7] }],
    total: 80000,
    why: 'band needs two adults → 2 × 100.00 × 4',
  },
  {
    name: 'One adult + child 3: both pay adult double',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 1, ages: [3] }],
    total: 80000,
    why: 'same rule for the 25% band',
  },
  {
    name: 'One adult + infant: single, infant free',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 1, ages: [0] }],
    total: 60000,
    why: '150.00 × 4',
  },
  {
    name: '4 guests in a triple cabin',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2, ages: [7, 3] }],
    error: 'INVALID_OCCUPANCY',
    why: 'max occupancy 3',
  },
  {
    name: 'No adult in the cabin',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 0, ages: [7] }],
    error: 'INVALID_OCCUPANCY',
    why: 'at least one adult',
  },
  {
    name: '4 adults',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 4 }],
    error: 'INVALID_OCCUPANCY',
    why: 'max 3 adults',
  },
  {
    name: '3 adults in a junior suite',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'JS', adults: 3 }],
    error: 'INVALID_OCCUPANCY',
    why: 'JS max 2 adults',
  },
  {
    name: 'Two cabins',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [
      { cat: 'STD', adults: 2 },
      { cat: 'JS', adults: 2 },
    ],
    total: 240000,
    why: '800.00 + 2 × 200.00 × 4',
  },
  {
    name: '7 nights from Luxor',
    pattern: 'LXR-7',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2 }],
    total: 140000,
    why: '2 × 100.00 × 7',
  },
  {
    name: '7 nights from Aswan crossing into HIGH: priced on the embark season',
    pattern: 'ASW-7',
    embark: 11,
    cabins: [{ cat: 'STD', adults: 2 }],
    total: 150000,
    why: 'embarks M+11 (LOW): 2 × 100.00 × 7 + gala M+16 2 × 50.00',
  },
  {
    name: 'Gala inside; a gala on the disembark day is not charged',
    pattern: 'LXR-4',
    embark: 14,
    cabins: [{ cat: 'STD', adults: 2 }],
    total: 106000,
    why: 'HIGH 2 × 120.00 × 4 + gala M+16 2 × 50.00 (gala M+18 is disembarkation)',
  },
  {
    name: 'Gala inside with a child',
    pattern: 'LXR-4',
    embark: 14,
    cabins: [{ cat: 'STD', adults: 2, ages: [7] }],
    total: 132500,
    why: '960.00 + 50% × 480.00 + 2 × 50.00 + 25.00',
  },
  {
    name: 'Gala on the embark night',
    pattern: 'ASW-3',
    embark: 18,
    cabins: [{ cat: 'STD', adults: 2 }],
    total: 82000,
    why: '2 × 120.00 × 3 + gala M+18 2 × 50.00',
  },
  {
    name: 'Both galas in 7 nights',
    pattern: 'LXR-7',
    embark: 14,
    cabins: [{ cat: 'STD', adults: 2 }],
    total: 188000,
    why: '2 × 120.00 × 7 + 2 galas × 2 × 50.00',
  },
  {
    name: 'Gala outside the sailing',
    pattern: 'ASW-3',
    embark: 11,
    cabins: [{ cat: 'STD', adults: 2 }],
    total: 60000,
    why: '2 × 100.00 × 3, no gala',
  },
  {
    name: 'Half-up rounding on a child line',
    pattern: 'ASW-3',
    embark: 4,
    cabins: [{ cat: 'SUP', adults: 2, ages: [7] }],
    total: 75008,
    why: '2 × 100.01 × 3 = 600.06; 50% × 300.03 = 150.015 → 150.02',
  },
  {
    name: 'Markup 10%',
    channel: 'markup',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2 }],
    total: 88000,
    net: 88000,
    why: '800.00 + 80.00',
  },
  {
    name: 'Markup rounding half-up',
    channel: 'markup',
    pattern: 'ASW-3',
    embark: 4,
    cabins: [{ cat: 'SUP', adults: 2, ages: [7] }],
    total: 82509,
    why: '750.08 + 10% (75.008 → 75.01)',
  },
  {
    name: 'Commission 15%: price unchanged, net lower',
    channel: 'commission',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2 }],
    total: 80000,
    net: 68000,
    why: '800.00; commission 120.00',
  },
  {
    name: 'Package rate, double',
    market: 'international_eur',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2 }],
    total: 100000,
    why: 'EUR 2 × 500.00',
  },
  {
    name: 'Package rate with child 7',
    market: 'international_eur',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2, ages: [7] }],
    total: 125000,
    why: '1000.00 + 50% × 500.00',
  },
  {
    name: '7-night package',
    market: 'international_eur',
    pattern: 'LXR-7',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2 }],
    total: 160000,
    why: '2 × 800.00',
  },
  {
    name: 'Package without a single rate',
    market: 'international_eur',
    pattern: 'ASW-3',
    embark: 4,
    cabins: [{ cat: 'STD', adults: 1 }],
    error: 'NO_RATE_FOR_SEASON',
    why: 'ASW-3 has only a double rate',
  },
  {
    name: 'Per cabin: child included',
    market: 'egyptian_resident',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2, ages: [7] }],
    total: 300000,
    why: 'EGP 3,000.00 per cabin',
  },
  {
    name: 'Per cabin: 3 adults, same price',
    market: 'egyptian_resident',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 3 }],
    total: 300000,
    why: 'per cabin',
  },
  {
    name: 'Per cabin: royal suite, 2 adults + 2 children',
    market: 'egyptian_resident',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'RS', adults: 2, ages: [4, 9] }],
    total: 900000,
    why: 'EGP 9,000.00',
  },
  {
    name: 'No season on the embark date',
    pattern: 'LXR-4',
    embark: 28,
    cabins: [{ cat: 'STD', adults: 2 }],
    error: 'NO_RATE_FOR_SEASON',
    why: 'seasons end at M+27',
  },
  {
    name: 'Category not in the contract',
    channel: 'limited',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'JS', adults: 2 }],
    error: 'CONTRACT_FORBIDS',
    why: 'contract has STD only',
  },
  {
    name: 'Market with no plan in the contract',
    channel: 'limited',
    market: 'international_eur',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2 }],
    error: 'CONTRACT_FORBIDS',
    why: 'contract has NIGHT only',
  },
  {
    name: 'Stop sell on the contract',
    channel: 'stopped',
    pattern: 'LXR-4',
    embark: 0,
    cabins: [{ cat: 'STD', adults: 2 }],
    error: 'CONTRACT_FORBIDS',
    why: 'stop_sell',
  },
  {
    name: 'Cancelled departure',
    pattern: 'LXR-4',
    embark: 35,
    cabins: [{ cat: 'STD', adults: 2 }],
    error: 'SAILING_CLOSED',
    why: 'leg cancelled',
  },
];

describe('priceSailing: hand-computed cases', () => {
  let world: PricingWorld;
  const results: {
    name: string;
    currency: string;
    expected: string;
    actual: string;
    ok: boolean;
  }[] = [];

  beforeAll(async () => {
    world = await pricingWorld();
  }, 120_000);

  afterAll(async () => {
    const path = process.env.PRICING_REPORT;
    if (path) {
      const rows = results.map(
        (r, i) => `| ${i + 1} | ${r.name} | ${r.expected} | ${r.actual} | ${r.ok ? '✓' : '✗'} |`,
      );
      writeFileSync(
        path,
        [
          '| # | Case | Expected | Actual | |',
          '| ---: | --- | ---: | ---: | :---: |',
          ...rows,
        ].join('\n') + '\n',
      );
    }
    await world.close();
  });

  it(`has at least 25 cases`, () => {
    expect(CASES.length).toBeGreaterThanOrEqual(25);
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const embark = addDays(world.M, c.embark);
    const sailingId = await world.sailing(c.pattern, embark);
    const market = c.market ?? 'international';
    const run = priceSailing(world.db, world.ctx, {
      channelId: world.channels[c.channel ?? 'nilecrz'],
      sailingId,
      market,
      cabins: c.cabins.map((cabin) => ({
        categoryId: world.demo.categories[cabin.cat],
        adults: cabin.adults,
        childAges: cabin.ages ?? [],
        childBirthDates: cabin.births?.(embark) ?? [],
      })),
    });
    const currency =
      market === 'international_eur' ? 'EUR' : market === 'egyptian_resident' ? 'EGP' : 'USD';
    if (c.error) {
      const error = await run.then(
        () => undefined,
        (e: unknown) => e,
      );
      const actual = isDomainError(error) ? error.code : String(error ?? 'priced');
      results.push({ name: c.name, currency, expected: c.error, actual, ok: actual === c.error });
      expect(actual).toBe(c.error);
      return;
    }
    const priced = await run;
    const fmt = (n: bigint) => formatMinor(money(n, priced.currency));
    const expected = `${fmt(BigInt(c.total!))}${c.net !== undefined ? ` (net ${fmt(BigInt(c.net))})` : ''}`;
    const actual = `${fmt(priced.total)}${c.net !== undefined ? ` (net ${fmt(priced.netTotal)})` : ''}`;
    results.push({ name: c.name, currency, expected, actual, ok: expected === actual });
    expect(priced.currency).toBe(currency);
    expect(priced.total).toBe(BigInt(c.total!));
    expect(priced.netTotal).toBe(BigInt(c.net ?? c.total!));
    // Totals are sums of rounded lines.
    expect(priced.lines.filter((l) => l.inTotal).reduce((s, l) => s + l.amount, 0n)).toBe(
      priced.total,
    );
  });
});
