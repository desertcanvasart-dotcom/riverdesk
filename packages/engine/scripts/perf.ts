/**
 * Performance check (Batch 7). Local database only.
 *
 * Seeds a company with the pilot vessel (18 months of schedule) and 20 synthetic vessels, books
 * background occupancy, then measures:
 *   - availability for a 90-day search (target p95 < 300 ms), staff and channel views;
 *   - hold, confirm and amend under 20 concurrent clients (target p95 < 800 ms).
 *   pnpm --filter @vs/engine perf [--vessels 20] [--clients 20] [--rounds 10]
 */
import { parseArgs } from 'node:util';
import pg from 'pg';
import { sql } from 'kysely';
import { createCompany } from '@vs/db/platform';
import { addDays, loadConfig, required, systemActor, type BusinessDate } from '@vs/shared';
import {
  applyAmendment,
  channelAvailability,
  confirmHold,
  createDemoPricing,
  createDemoVessel,
  createHold,
  createQuote,
  generateSchedule,
  getAvailability,
  openDatabase,
  quoteAmendment,
  todayInCairo,
  type EngineContext,
  type VsDatabase,
} from '../src/index';

const { values } = parseArgs({
  options: {
    vessels: { type: 'string', default: '20' },
    clients: { type: 'string', default: '20' },
    rounds: { type: 'string', default: '10' },
    background: { type: 'string', default: '300' },
  },
});
const config = loadConfig();
if (config.VS_ENV === 'hosted')
  throw new Error('The performance check runs on the local database only');

const p = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
function summary(name: string, samples: number[], target: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  const row = {
    name,
    n: sorted.length,
    p50: Math.round(p(sorted, 0.5)),
    p95: Math.round(p(sorted, 0.95)),
    max: Math.round(sorted.at(-1)!),
    target,
  };
  return { ...row, ok: row.p95 < target };
}
async function timed<T>(samples: number[], fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  samples.push(performance.now() - t0);
  return result;
}
const pick = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)]!;

// --- Seed -------------------------------------------------------------------------------------
const admin = new pg.Client({
  connectionString: required(config, 'DATABASE_URL_ADMIN'),
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});
await admin.connect();
const stamp = Date.now().toString(36);
const company = await createCompany(admin, {
  name: `Perf Nile Cruises ${stamp}`,
  slug: `perf-${stamp}`,
  bookingRefPrefix: 'PRF',
  ownerEmail: `perf-${stamp}@example.test`,
  ownerName: 'Perf Owner',
});
await admin.end();

const backoffice = openDatabase('vs_backoffice', { config, max: 10 });
const api = openDatabase('vs_api', { config, max: 25 });
const ctx: EngineContext = { operatorId: company.operatorId, actor: systemActor('perf') };
const vesselCount = Number(values.vessels) + 1;
const today = await todayInCairo(backoffice);
const until = addDays(today, 545);

console.log(`Seeding ${vesselCount} vessels with 18 months of schedule…`);
const seedStart = performance.now();
const fleet: { vesselId: string; categories: string[]; nilecrz: string }[] = [];
for (let i = 0; i < vesselCount; i += 1) {
  const demo = await createDemoVessel(backoffice, ctx, {
    code: i === 0 ? 'PILOT' : `SYN${String(i).padStart(2, '0')}`,
  });
  await generateSchedule(backoffice, ctx, { vesselId: demo.vesselId, until });
  const pricing = await createDemoPricing(backoffice, ctx, demo.vesselId);
  fleet.push({
    vesselId: demo.vesselId,
    categories: Object.values(demo.categories),
    nilecrz: pricing.channels.nilecrz,
  });
}
const counts = await backoffice.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
  const { rows } = await sql<{ legs: number; sailings: number; buckets: number }>`
    select (select count(*) from vs.leg)::int as legs, (select count(*) from vs.sailing)::int as sailings,
           (select count(*) from vs.inventory_bucket)::int as buckets`.execute(tx);
  return rows[0]!;
});
const sailingsByVessel = new Map<string, string[]>();
for (const v of fleet) {
  sailingsByVessel.set(
    v.vesselId,
    await backoffice.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) =>
      (
        await tx
          .selectFrom('sailing')
          .select('id')
          .where('vessel_id', '=', v.vesselId)
          .where('status', '=', 'open')
          .where('embark_date', '>', addDays(today, 2))
          .execute()
      ).map((s) => s.id),
    ),
  );
}
console.log(
  `Seeded ${counts.legs} legs, ${counts.sailings} sailings, ${counts.buckets} buckets in ${Math.round((performance.now() - seedStart) / 1000)} s`,
);

async function bookOne(
  db: VsDatabase,
  vessel: (typeof fleet)[number],
  samples?: Record<string, number[]>,
) {
  const sailingId = pick(sailingsByVessel.get(vessel.vesselId)!);
  const quote = await createQuote(db, ctx, {
    channelId: vessel.nilecrz,
    sailingId,
    market: 'international',
    cabins: [{ categoryId: pick(vessel.categories), adults: 2 }],
  });
  const hold = samples
    ? await timed(samples.hold!, () =>
        createHold(db, ctx, { channelId: vessel.nilecrz, quoteId: quote.id, kind: 'option' }),
      )
    : await createHold(db, ctx, { channelId: vessel.nilecrz, quoteId: quote.id, kind: 'option' });
  const guests = [{ cabin: 0, firstName: 'Perf', lastName: 'Guest', lead: true }];
  return samples
    ? timed(samples.confirm!, () => confirmHold(db, ctx, { holdId: hold.holdId, guests }))
    : confirmHold(db, ctx, { holdId: hold.holdId, guests });
}

// Background occupancy on the pilot vessel (not measured).
console.log(`Booking ${values.background} background cabins…`);
let background = 0;
const backgroundErrors: Record<string, number> = {};
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (background < Number(values.background)) {
      background += 1;
      await bookOne(api, fleet[0]!).catch((e: { code?: string }) => {
        backgroundErrors[e.code ?? 'other'] = (backgroundErrors[e.code ?? 'other'] ?? 0) + 1;
      });
    }
  }),
);

// --- Availability: 90-day search ----------------------------------------------------------------
const staffAvailability: number[] = [];
const channelAvail: number[] = [];
for (let i = 0; i < 100; i += 1) {
  const from = addDays(today, Math.floor(Math.random() * 450));
  const to = addDays(from as BusinessDate, 89);
  const vessel = i % 2 === 0 ? fleet[0]! : pick(fleet);
  await timed(staffAvailability, () =>
    getAvailability(api, ctx, { vesselId: vessel.vesselId, from, to }),
  );
  await timed(channelAvail, () =>
    channelAvailability(api, ctx, {
      channelId: vessel.nilecrz,
      vesselId: vessel.vesselId,
      from,
      to,
    }),
  );
}

// --- Hold, confirm, amend under concurrent clients ----------------------------------------------
const samples: Record<string, number[]> = { hold: [], confirm: [], amend: [] };
const errors: Record<string, number> = {};
const clients = Number(values.clients);
const rounds = Number(values.rounds);
const loadStart = performance.now();
await Promise.all(
  Array.from({ length: clients }, async (_, c) => {
    for (let r = 0; r < rounds; r += 1) {
      // Half the traffic on the pilot vessel (contention), half spread over the fleet.
      const vessel = (c + r) % 2 === 0 ? fleet[0]! : pick(fleet);
      try {
        const booking = await bookOne(api, vessel, samples);
        if (booking.status !== 'confirmed') continue;
        await timed(samples.amend!, async () => {
          const change = await quoteAmendment(api, ctx, {
            bookingId: booking.bookingId,
            sailingId: pick(sailingsByVessel.get(vessel.vesselId)!),
          });
          return applyAmendment(api, ctx, {
            bookingId: booking.bookingId,
            revision: change.revision,
            amendmentQuoteId: change.quote.id,
          });
        });
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'other';
        errors[code] = (errors[code] ?? 0) + 1;
      }
    }
  }),
);
const loadSeconds = (performance.now() - loadStart) / 1000;

const results = [
  summary('availability 90 days (staff)', staffAvailability, 300),
  summary('availability 90 days (channel)', channelAvail, 300),
  summary(`hold (${clients} concurrent clients)`, samples.hold!, 800),
  summary(`confirm (${clients} concurrent clients)`, samples.confirm!, 800),
  summary(`amend (${clients} concurrent clients)`, samples.amend!, 800),
];
console.log('\n| Operation | n | p50 ms | p95 ms | max ms | target p95 | |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of results)
  console.log(
    `| ${r.name} | ${r.n} | ${r.p50} | ${r.p95} | ${r.max} | < ${r.target} | ${r.ok ? 'ok' : 'MISSED'} |`,
  );
console.log(
  `\nLoad phase: ${loadSeconds.toFixed(1)} s. Refusals (expected under contention): ${JSON.stringify(errors)}`,
);
console.log(`Background refusals: ${JSON.stringify(backgroundErrors)}`);
console.log(`Company: ${company.operatorId}`);
await backoffice.close();
await api.close();
if (results.some((r) => !r.ok)) process.exitCode = 1;
