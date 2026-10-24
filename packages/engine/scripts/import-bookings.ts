/**
 * Pilot import: existing future bookings from a CSV (template: docs/pilot/import-template.csv).
 *   pnpm --filter @vs/engine import-bookings --company <slug> --file <csv> [--dry-run]
 * Hosted: VS_ENV_FILE=.env.hosted … --confirm-hosted
 * Re-runnable: bookings already imported (same external_ref on the same channel) are skipped.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadConfig, required, systemActor } from '@vs/shared';
import { importBookings, openDatabase, parseCsv } from '../src/index';

const { values } = parseArgs({
  options: {
    company: { type: 'string' },
    file: { type: 'string' },
    'dry-run': { type: 'boolean' },
    'confirm-hosted': { type: 'boolean' },
    report: { type: 'string' },
  },
});
if (!values.company || !values.file)
  throw new Error('usage: --company <slug> --file <csv> [--dry-run]');
const config = loadConfig();
if (config.VS_ENV === 'hosted' && !values['confirm-hosted']) {
  console.error('This imports into the hosted database: add --confirm-hosted');
  process.exit(1);
}
const admin = new pg.Client({
  connectionString: required(config, 'DATABASE_URL_ADMIN'),
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});
await admin.connect();
const company = await admin.query<{ id: string }>(`select id from vs.operator where slug = $1`, [
  values.company,
]);
await admin.end();
if (!company.rows[0]) throw new Error(`No company with slug ${values.company}`);

const db = openDatabase('vs_backoffice', { config });
try {
  const rows = parseCsv(readFileSync(values.file, 'utf8'));
  const results = await importBookings(
    db,
    { operatorId: company.rows[0].id, actor: systemActor('pilot-import') },
    rows,
    { dryRun: values['dry-run'] },
  );
  for (const r of results) {
    console.log(
      [
        r.externalRef,
        r.outcome,
        r.ref ?? '',
        r.status ?? '',
        r.message ?? '',
        r.warnings.join('; '),
      ].join('\t'),
    );
  }
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  console.log(
    `\n${Object.entries(counts)
      .map(([k, n]) => `${k}: ${n}`)
      .join(', ')}`,
  );
  if (values.report) {
    writeFileSync(
      values.report,
      ['external_ref,outcome,ref,status,message,warnings']
        .concat(
          results.map((r) =>
            [
              r.externalRef,
              r.outcome,
              r.ref ?? '',
              r.status ?? '',
              r.message ?? '',
              r.warnings.join('; '),
            ]
              .map((v) => `"${v.replace(/"/g, '""')}"`)
              .join(','),
          ),
        )
        .join('\n'),
    );
  }
} finally {
  await db.close();
}
