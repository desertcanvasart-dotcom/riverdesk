import { parseArgs } from 'node:util';
import pg from 'pg';
import { createCompany } from '@vs/db/platform';
import { loadConfig, required, systemActor } from '@vs/shared';
import {
  createApiClient,
  createDemoPricing,
  createDemoVessel,
  generateSchedule,
  openDatabase,
} from '../src/index';

// The channel API sandbox (spec § Auth and limits): a separate company "sandbox" with the demo
// vessel, its pricing and schedule, a nilecrz channel, and API credentials for it.
//   pnpm sandbox:setup                 creates it once (prints the client secret once)
//   pnpm sandbox:setup --new-client    issues another client for nilecrz
// Hosted: VS_ENV_FILE=.env.hosted pnpm sandbox:setup --confirm-hosted
const { values } = parseArgs({
  options: { 'new-client': { type: 'boolean' }, 'confirm-hosted': { type: 'boolean' } },
});
const config = loadConfig();
if (config.VS_ENV === 'hosted' && !values['confirm-hosted']) {
  console.error('This creates a sandbox company in the hosted database: add --confirm-hosted');
  process.exit(1);
}
const admin = new pg.Client({
  connectionString: required(config, 'DATABASE_URL_ADMIN'),
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});
await admin.connect();
const db = openDatabase('vs_backoffice', { config });
try {
  let operatorId = (await admin
    .query<{ id: string }>(`set role vs_owner; select id from vs.operator where slug = 'sandbox'`)
    .then((r) => (Array.isArray(r) ? r[1] : r).rows[0]?.id)) as string | undefined;
  await admin.query('reset role');
  const ctx = () => ({ operatorId: operatorId!, actor: systemActor('sandbox-setup') });
  if (!operatorId) {
    const created = await createCompany(admin, {
      name: 'Sandbox Nile Cruises',
      slug: 'sandbox',
      bookingRefPrefix: 'SBX',
      ownerEmail: 'sandbox-owner@example.com',
      ownerName: 'Sandbox Owner',
      locale: 'en',
    });
    operatorId = created.operatorId;
    const demo = await createDemoVessel(db, ctx(), { code: 'SANDBOX' });
    await generateSchedule(db, ctx(), { vesselId: demo.vesselId });
    const pricing = await createDemoPricing(db, ctx(), demo.vesselId);
    const client = await createApiClient(db, ctx(), {
      channelId: pricing.channels.nilecrz,
      name: 'nilecrz sandbox',
    });
    console.log(`Sandbox company ${operatorId} with vessel ${demo.vesselId}.`);
    console.log(`nilecrz sandbox client_id=${client.clientId}`);
    console.log(`nilecrz sandbox client_secret=${client.secret}   (shown once)`);
  } else if (values['new-client']) {
    const channel = await db.withTenantTx(operatorId, systemActor('sandbox-setup'), ({ db: tx }) =>
      tx.selectFrom('channel').select('id').where('code', '=', 'nilecrz').executeTakeFirstOrThrow(),
    );
    const client = await createApiClient(db, ctx(), {
      channelId: channel.id,
      name: 'nilecrz sandbox',
    });
    console.log(`nilecrz sandbox client_id=${client.clientId}`);
    console.log(`nilecrz sandbox client_secret=${client.secret}   (shown once)`);
  } else {
    console.log(
      `Sandbox company ${operatorId} already exists. Use --new-client for another API client.`,
    );
  }
} finally {
  await db.close();
  await admin.end();
}
