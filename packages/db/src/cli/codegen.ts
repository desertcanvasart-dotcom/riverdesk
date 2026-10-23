import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adminOptions, assertLocal } from './env';

// Regenerates src/generated/types.ts from the local database (schema vs). CI fails if the
// committed file differs from a fresh run.
const { adminUrl } = adminOptions();
assertLocal(adminUrl);
const outFile = fileURLToPath(new URL('../generated/types.ts', import.meta.url));
execFileSync(
  'kysely-codegen',
  [
    '--dialect=postgres',
    '--default-schema=vs',
    '--include-pattern=vs.*',
    '--date-parser=string',
    '--type-mapping={"int8":"bigint"}',
    `--out-file=${outFile}`,
  ],
  { stdio: 'inherit', env: { ...process.env, DATABASE_URL: adminUrl } },
);
