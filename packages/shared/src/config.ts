import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

export type RuntimeRole = 'vs_backoffice' | 'vs_api' | 'vs_worker';

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

const base64Key32 = z
  .string()
  .refine((value) => Buffer.from(value, 'base64').length === 32, 'Must be 32 bytes, base64');

export const envSchema = z.object({
  VS_ENV: z.enum(['local', 'ci', 'hosted']).default('local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL_ADMIN: z.string().optional(),
  DATABASE_HOST: z.string().default('127.0.0.1'),
  DATABASE_PORT: z.coerce.number().int().positive().default(55322),
  DATABASE_SESSION_PORT: z.coerce.number().int().positive().optional(),
  DATABASE_NAME: z.string().default('postgres'),
  DATABASE_SSL: boolish.default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  SUPABASE_PROJECT_REF: z.string().optional(),

  VS_BACKOFFICE_PASSWORD: z.string().min(8).optional(),
  VS_API_PASSWORD: z.string().min(8).optional(),
  VS_WORKER_PASSWORD: z.string().min(8).optional(),

  SUPABASE_URL: z.url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),

  PASSPORT_KEY_ID: z.string().min(1).optional(),
  PASSPORT_KEY: base64Key32.optional(),
  /** Earlier keys still needed to decrypt: "id:base64,id:base64". */
  PASSPORT_PREVIOUS_KEYS: z.string().optional(),

  SEED_STAFF_PASSWORD: z.string().min(8).optional(),
  /** Base32 TOTP secret for the seeded owner and finance users (local only). */
  SEED_TOTP_SECRET: z
    .string()
    .regex(/^[A-Z2-7]{16,64}$/)
    .optional(),

  /** HS256 key for channel API access tokens (32+ random bytes, base64). */
  API_TOKEN_SECRET: z
    .string()
    .refine((value) => Buffer.from(value, 'base64').length >= 32, 'At least 32 bytes, base64')
    .optional(),
});

export type Config = z.infer<typeof envSchema>;

export function findRepoRoot(start = process.cwd()): string {
  // The turbopackIgnore comments mark runtime file lookups so Next.js does not bundle the repo.
  let dir = resolve(/*turbopackIgnore: true*/ start);
  for (;;) {
    if (existsSync(join(/*turbopackIgnore: true*/ dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(/*turbopackIgnore: true*/ start);
    dir = parent;
  }
}

let cached: Config | undefined;

/**
 * Loads `.env` from the repo root (or the file named by VS_ENV_FILE), without overriding
 * variables already set in the environment, then validates everything with zod.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && cached) return cached;
  if (env === process.env) {
    const root = findRepoRoot();
    const file = join(/*turbopackIgnore: true*/ root, process.env.VS_ENV_FILE ?? '.env');
    if (existsSync(/*turbopackIgnore: true*/ file)) loadDotenv({ path: file, quiet: true });
  }
  // An empty value (`KEY=`) means unset, so defaults and optional fields apply.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  if (env === process.env) cached = parsed.data;
  return parsed.data;
}

export function required<K extends keyof Config>(config: Config, key: K): NonNullable<Config[K]> {
  const value = config[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing configuration: ${String(key)}`);
  }
  return value as NonNullable<Config[K]>;
}

const PASSWORD_KEY: Record<RuntimeRole, keyof Config> = {
  vs_backoffice: 'VS_BACKOFFICE_PASSWORD',
  vs_api: 'VS_API_PASSWORD',
  vs_worker: 'VS_WORKER_PASSWORD',
};

export interface PgConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

/**
 * Connection settings for a runtime role. On hosted Supabase the pooler (Supavisor) expects
 * `role.projectref` as the user name. `session: true` picks the session-mode port, which the
 * worker needs for LISTEN/NOTIFY.
 */
export function roleConnection(
  config: Config,
  role: RuntimeRole,
  options: { session?: boolean } = {},
): PgConnection {
  const pooled = config.DATABASE_HOST.endsWith('pooler.supabase.com');
  const user = pooled ? `${role}.${required(config, 'SUPABASE_PROJECT_REF')}` : role;
  const port = options.session
    ? (config.DATABASE_SESSION_PORT ?? config.DATABASE_PORT)
    : config.DATABASE_PORT;
  return {
    host: config.DATABASE_HOST,
    port,
    database: config.DATABASE_NAME,
    user,
    password: String(required(config, PASSWORD_KEY[role])),
    ssl: config.DATABASE_SSL,
  };
}

/** postgres:// URL for libraries that take a connection string (Graphile Worker). */
export function connectionString(connection: PgConnection): string {
  const user = encodeURIComponent(connection.user);
  const password = encodeURIComponent(connection.password);
  const ssl = connection.ssl ? '?sslmode=no-verify' : '';
  return `postgres://${user}:${password}@${connection.host}:${connection.port}/${connection.database}${ssl}`;
}
