import { parseArgs } from 'node:util';
import pg from 'pg';
import { createCompany } from '../platform';
import { adminOptions } from './env';

// Platform admin: add a cruise company and invite its first owner.
//   pnpm platform:create-company --name "Nile Dream Cruises" --slug nile-dream --prefix NDM \
//     --owner-email owner@niledream.com --owner-name "Mona Hassan" [--locale ar|en]
// Hosted: prefix with VS_ENV_FILE=.env.hosted.
const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    slug: { type: 'string' },
    prefix: { type: 'string' },
    'owner-email': { type: 'string' },
    'owner-name': { type: 'string' },
    locale: { type: 'string', default: 'ar' },
  },
});
for (const key of ['name', 'slug', 'prefix', 'owner-email', 'owner-name'] as const) {
  if (!values[key]) {
    console.error(`Missing --${key}`);
    process.exit(1);
  }
}
const { adminUrl, ssl } = adminOptions();
const client = new pg.Client({
  connectionString: adminUrl,
  ssl: ssl ? { rejectUnauthorized: false } : undefined,
});
await client.connect();
try {
  const created = await createCompany(client, {
    name: values.name!,
    slug: values.slug!,
    bookingRefPrefix: values.prefix!,
    ownerEmail: values['owner-email']!,
    ownerName: values['owner-name']!,
    locale: values.locale === 'en' ? 'en' : 'ar',
  });
  console.log(`Created company ${values.name} (${created.operatorId}).`);
  console.log(
    `Invited ${values['owner-email']} as owner: they sign in to the back office with that email (valid 14 days).`,
  );
} finally {
  await client.end();
}
