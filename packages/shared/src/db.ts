import pg from 'pg';
import { Kysely, PostgresDialect, WithSchemaPlugin, sql, type Transaction } from 'kysely';
import { DomainError } from '@vs/contracts';
import type { Actor } from './actor';
import { isUuid } from './ids';
import type { PgConnection } from './config';
import type { Logger } from './logger';

const INT8_OID = 20;
const DATE_OID = 1082;

/** bigint columns come back as BigInt (money, counters); date columns stay 'YYYY-MM-DD' strings. */
const typeParsers = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8_OID) return (value: string) => BigInt(value);
    if (oid === DATE_OID) return (value: string) => value;
    return pg.types.getTypeParser(oid, format);
  },
} as pg.CustomTypesConfig;

/** SQLSTATEs that mean "run the whole transaction again" (rule 5). */
const RETRYABLE = new Set(['40P01', '40001']);

export interface TenantTx<DB> {
  db: Transaction<DB>;
  operatorId: string;
  actor: Actor;
  /** 0 on the first run, 1..maxRetries on retries. */
  attempt: number;
}

export interface TxOptions {
  maxRetries?: number;
  onRetry?: (info: { attempt: number; code: string }) => void;
}

export interface Database<DB> {
  pool: pg.Pool;
  kysely: Kysely<DB>;
  /**
   * Runs `fn` in one transaction as this connection's runtime role with
   * `app.operator_id` set for RLS, retrying the whole transaction up to 3 times (with jitter)
   * on deadlock or serialization failure, then failing with RETRY_LATER.
   */
  withTenantTx<T>(
    operatorId: string,
    actor: Actor,
    fn: (tx: TenantTx<DB>) => Promise<T>,
    options?: TxOptions,
  ): Promise<T>;
  /**
   * A transaction with no tenant set: RLS returns no rows, so it is only useful for the
   * allow-listed SECURITY DEFINER lookups (staff login, the worker's operator list).
   */
  withLookupTx<T>(fn: (db: Transaction<DB>) => Promise<T>, options?: TxOptions): Promise<T>;
  close(): Promise<void>;
}

export function pgErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

function backoffMs(attempt: number): number {
  // Full jitter: uniform in [5, 40·2^attempt] ms.
  return 5 + Math.random() * 40 * 2 ** attempt;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function withRetries<T>(
  run: (attempt: number) => Promise<T>,
  options: TxOptions,
  logger: Logger | undefined,
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      const code = pgErrorCode(error);
      if (!code || !RETRYABLE.has(code)) throw error;
      if (attempt >= maxRetries) {
        throw new DomainError('RETRY_LATER', { cause: error, details: { attempts: attempt + 1 } });
      }
      logger?.warn({ code, attempt: attempt + 1 }, 'transaction conflict; retrying');
      options.onRetry?.({ attempt: attempt + 1, code });
      await sleep(backoffMs(attempt));
    }
  }
}

export function createDatabase<DB>(
  connection: PgConnection & { max?: number; applicationName?: string },
  options: { logger?: Logger; schema?: string } = {},
): Database<DB> {
  const pool = new pg.Pool({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    ssl: connection.ssl ? { rejectUnauthorized: false } : false,
    max: connection.max ?? 10,
    application_name: connection.applicationName ?? connection.user,
    types: typeParsers,
  });
  pool.on('error', (error) => options.logger?.error({ err: error }, 'idle database client error'));
  const kysely = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: options.schema ? [new WithSchemaPlugin(options.schema)] : [],
  });

  return {
    pool,
    kysely,
    withTenantTx(operatorId, actor, fn, txOptions = {}) {
      if (!isUuid(operatorId)) {
        return Promise.reject(
          new DomainError('VALIDATION_FAILED', { message: 'Invalid operator id' }),
        );
      }
      return withRetries(
        (attempt) =>
          kysely.transaction().execute(async (db) => {
            await sql`select set_config('app.operator_id', ${operatorId}, true)`.execute(db);
            return fn({ db, operatorId, actor, attempt });
          }),
        txOptions,
        options.logger,
      );
    },
    withLookupTx(fn, txOptions = {}) {
      return withRetries(() => kysely.transaction().execute(fn), txOptions, options.logger);
    },
    async close() {
      await kysely.destroy();
    },
  };
}
