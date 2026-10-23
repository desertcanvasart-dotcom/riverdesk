import { loadConfig, required, systemActor } from '@vs/shared';
import { createDemoVessel, generateSchedule, openDatabase } from '../src/index';

// Local only: adds the demo vessel to the seeded demo operator through the engine (as the
// back-office role), then generates 18 months of schedule. Re-runnable.
const DEMO_OPERATOR_ID = '019a0000-0000-7000-8000-000000000001';

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
} finally {
  await db.close();
}
