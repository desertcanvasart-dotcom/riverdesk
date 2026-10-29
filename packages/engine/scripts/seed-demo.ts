import { readFileSync } from 'node:fs';
import { loadConfig, required, systemActor } from '@vs/shared';
import {
  createDemoActivity,
  createDemoInvoicing,
  createDemoOperations,
  createDemoPricing,
  createDemoVessel,
  DEMO_OPERATOR_ID,
  getBranding,
  setLogo,
  updateBranding,
  generateSchedule,
  openDatabase,
} from '../src/index';

// Local only: adds the demo vessel, its pricing and some sample activity to the seeded demo
// operator through the engine (as the back-office role), and generates 18 months of schedule.
// Re-runnable: each part is created only once.
const config = loadConfig();
const host = new URL(required(config, 'DATABASE_URL_ADMIN')).hostname;
if (!['127.0.0.1', 'localhost', '::1'].includes(host) || config.VS_ENV === 'hosted') {
  throw new Error('seed-demo runs against the local database only');
}
const db = openDatabase('vs_backoffice', { config });
const ctx = { operatorId: DEMO_OPERATOR_ID, actor: systemActor('seed') };
try {
  const existing = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx.selectFrom('vessel').select('id').where('code', '=', 'NILEDEMO').executeTakeFirst(),
  );
  const vesselId = existing?.id ?? (await createDemoVessel(db, ctx)).vesselId;
  const result = await generateSchedule(db, ctx, { vesselId });
  console.log(
    `demo vessel ${vesselId}: ${result.legsCreated} legs, ${result.sailingsCreated} sailings created (until ${result.until})`,
  );
  const plans = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx.selectFrom('rate_plan').select('id').where('vessel_id', '=', vesselId).execute(),
  );
  if (plans.length === 0) {
    const pricing = await createDemoPricing(db, ctx, vesselId);
    console.log(
      `demo pricing: ${pricing.ratePlanIds.length} rate plans, channels nilecrz and back office`,
    );
  }
  const bookings = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx.selectFrom('booking').select('id').limit(1).execute(),
  );
  if (bookings.length === 0) {
    const channels = await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => ({
      nilecrz: (
        await tx
          .selectFrom('channel')
          .select('id')
          .where('code', '=', 'nilecrz')
          .executeTakeFirstOrThrow()
      ).id,
      backOffice: (
        await tx
          .selectFrom('channel')
          .select('id')
          .where('code', '=', 'back-office')
          .executeTakeFirstOrThrow()
      ).id,
    }));
    await createDemoActivity(db, ctx, vesselId, channels);
    console.log(
      'demo activity: bookings, holds, a request, an allotment, a cancellation and an amendment',
    );
  }
  // Branding: the default colours with a sample emblem and contact block, set once.
  if (!(await getBranding(db, ctx)).logo) {
    await updateBranding(db, ctx, {
      phone: '+20 95 123 4567',
      whatsapp: '+20 100 123 4567',
      email: 'reservations@demo-nile.test',
      website: 'https://demo-nile.test',
      addressAr: 'كورنيش النيل، الأقصر',
      addressEn: 'Corniche El Nil, Luxor',
    });
    const logo = readFileSync(new URL('./demo-logo.png', import.meta.url)).toString('base64');
    await setLogo(db, ctx, { base64: logo });
    console.log('demo branding: logo and contact details');
  }
  // On board (D3): the vessel's day and the port guide, once.
  const day = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx
      .selectFrom('vessel')
      .select(['boarding_time', 'muster_stations'])
      .where('id', '=', vesselId)
      .executeTakeFirst(),
  );
  if (!day?.boarding_time || Object.keys(day.muster_stations as object).length === 0) {
    await createDemoOperations(db, ctx, vesselId);
    console.log('demo operations: boarding and meal times, berths and visits');
  }
  // Invoicing: issuer details, invoices, receipts, a credit note and account codes, once.
  const receipts = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx.selectFrom('receipt').select('id').where('booking_id', 'is', null).limit(1).execute(),
  );
  if (receipts.length === 0) {
    await createDemoInvoicing(db, ctx);
    console.log('demo invoicing: invoices, receipts, a credit note and account codes');
  }
} finally {
  await db.close();
}
