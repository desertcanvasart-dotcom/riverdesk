import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadConfig, required, systemActor } from '@vs/shared';
import {
  createDemoActivity,
  createDemoFolios,
  createDemoInvoicing,
  createDemoOperations,
  createDemoPricing,
  createDemoVessel,
  generateSchedule,
  openDatabase,
} from '../src/index';

// Sample data for an existing company, at the owner's request, so every screen can be seen
// filled: its vessel's cabins, route and 18 months of departures, prices and channels, bookings,
// invoices and receipts, on-board settings, and extras with a closed and paid folio. The same
// builders as seed-demo, but the company's own vessel is filled and its own name is the invoice
// issuer (no made-up registration or bank numbers, no demo logo). Each part runs once.
//   pnpm --filter @vs/engine seed-company --slug onc
// Hosted: VS_ENV_FILE=.env.hosted pnpm --filter @vs/engine seed-company --slug onc --confirm-hosted
const { values } = parseArgs({
  options: { slug: { type: 'string' }, 'confirm-hosted': { type: 'boolean' } },
});
const config = loadConfig();
if (!values.slug) throw new Error('usage: seed-company --slug <company slug>');
if (config.VS_ENV === 'hosted' && !values['confirm-hosted']) {
  console.error(
    'This writes sample data into a company on the hosted database: add --confirm-hosted',
  );
  process.exit(1);
}
const admin = new pg.Client({
  connectionString: required(config, 'DATABASE_URL_ADMIN'),
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});
await admin.connect();
const db = openDatabase('vs_backoffice', { config });
try {
  await admin.query('set role vs_owner');
  const company = (
    await admin.query<{ id: string; name: string }>(
      `select id, name from vs.operator where slug = $1`,
      [values.slug],
    )
  ).rows[0];
  await admin.query('reset role');
  if (!company) throw new Error(`No company with slug ${values.slug}`);
  const ctx = { operatorId: company.id, actor: systemActor('seed-company') };
  const tx = <T>(fn: Parameters<typeof db.withTenantTx<T>>[2]) =>
    db.withTenantTx(ctx.operatorId, ctx.actor, fn);

  // The company's first vessel: filled if it has no cabins yet, else used as it is.
  const vessels = await tx(({ db: t }) =>
    t
      .selectFrom('vessel as v')
      .select([
        'v.id',
        'v.name',
        (eb) =>
          eb
            .selectFrom('cabin_category as c')
            .select((e) => e.fn.countAll<number>().as('n'))
            .whereRef('c.vessel_id', '=', 'v.id')
            .as('categories'),
      ])
      .orderBy('v.created_at')
      .execute(),
  );
  let vesselId = vessels[0]?.id;
  if (!vesselId || Number(vessels[0]!.categories) === 0) {
    const demo = await createDemoVessel(db, ctx, vesselId ? { vesselId } : { code: 'SAMPLE' });
    vesselId = demo.vesselId;
    console.log(
      `${company.name}: cabins, route and itineraries on ${vessels[0]?.name ?? 'a new vessel'}`,
    );
  }
  const schedule = await generateSchedule(db, ctx, { vesselId });
  console.log(
    `schedule: ${schedule.legsCreated} legs, ${schedule.sailingsCreated} sailings created`,
  );

  const plans = await tx(({ db: t }) =>
    t.selectFrom('rate_plan').select('id').where('vessel_id', '=', vesselId).execute(),
  );
  if (plans.length === 0) {
    const pricing = await createDemoPricing(db, ctx, vesselId);
    console.log(`pricing: ${pricing.ratePlanIds.length} rate plans, nilecrz and back office`);
  }

  const bookings = await tx(({ db: t }) => t.selectFrom('booking').select('id').limit(1).execute());
  if (bookings.length === 0) {
    const channel = (code: string) =>
      tx(({ db: t }) =>
        t.selectFrom('channel').select('id').where('code', '=', code).executeTakeFirstOrThrow(),
      );
    await createDemoActivity(db, ctx, vesselId, {
      nilecrz: (await channel('nilecrz')).id,
      backOffice: (await channel('back-office')).id,
    });
    console.log('activity: bookings, holds, a request, an allotment, a cancellation, an amendment');
  }

  const day = await tx(({ db: t }) =>
    t.selectFrom('vessel').select('boarding_time').where('id', '=', vesselId).executeTakeFirst(),
  );
  if (!day?.boarding_time) {
    await createDemoOperations(db, ctx, vesselId);
    console.log('on board: times, muster stations, berths and visits');
  }

  const receipts = await tx(({ db: t }) =>
    t.selectFrom('receipt').select('id').where('booking_id', 'is', null).limit(1).execute(),
  );
  if (receipts.length === 0) {
    await createDemoInvoicing(db, ctx, { legalNameEn: company.name, legalNameAr: company.name });
    console.log('invoicing: invoices, receipts, a credit note, account codes');
  }

  const extras = await tx(({ db: t }) =>
    t.selectFrom('extra_item').select('id').limit(1).execute(),
  );
  if (extras.length === 0) {
    await createDemoFolios(db, ctx, vesselId);
    console.log('extras: price list, folios, one closed and paid');
  }
} finally {
  await db.close();
  await admin.end();
}
