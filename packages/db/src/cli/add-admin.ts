import { parseArgs } from 'node:util';
import pg from 'pg';
import { setPlatformAdmin } from '../platform';
import { adminOptions } from './env';

// Platform admin: let an email into the platform area (/platform in the back office).
//   pnpm platform:add-admin --email you@example.com [--remove]
// Hosted: prefix with VS_ENV_FILE=.env.hosted.
const { values } = parseArgs({
  options: { email: { type: 'string' }, remove: { type: 'boolean', default: false } },
});
if (!values.email) {
  console.error('Missing --email');
  process.exit(1);
}
const { adminUrl, ssl } = adminOptions();
const client = new pg.Client({
  connectionString: adminUrl,
  ssl: ssl ? { rejectUnauthorized: false } : undefined,
});
await client.connect();
try {
  await setPlatformAdmin(client, values.email, values.remove);
  console.log(
    values.remove
      ? `${values.email} can no longer open the platform area.`
      : `${values.email} can open the platform area after signing in with two-step verification.`,
  );
} finally {
  await client.end();
}
