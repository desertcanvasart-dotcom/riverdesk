import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import { parseInput, type EngineContext, type Tx } from '../internal';

/**
 * OAuth client credentials for the channel API. A client belongs to one channel of one company.
 * Secrets are random 32-byte strings shown once; only their SHA-256 hash is stored. Two can be
 * active at once so a channel can rotate without downtime.
 */

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const newSecret = () => `vss_${randomBytes(32).toString('base64url')}`;

async function insertSecret(tx: Tx, ctx: EngineContext, apiClientId: string) {
  const secret = newSecret();
  const row = await tx
    .insertInto('api_client_secret')
    .values({
      operator_id: ctx.operatorId,
      api_client_id: apiClientId,
      secret_hash: hash(secret),
      hint: secret.slice(-4),
    })
    .returning(['id', 'hint'])
    .executeTakeFirstOrThrow();
  return { secretId: row.id, secret, hint: row.hint };
}

export const createApiClientInput = z.object({
  channelId: z.uuid(),
  name: z.string().min(1).max(100),
  rateLimitPerMinute: z.number().int().min(1).max(100_000).optional(),
});

/** Returns the client id and its first secret — the only time the secret is ever shown. */
export async function createApiClient(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createApiClientInput>,
) {
  const data = parseInput(createApiClientInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const channel = await tx
      .selectFrom('channel')
      .select(['id', 'active'])
      .where('id', '=', data.channelId)
      .executeTakeFirst();
    if (!channel) throw new DomainError('NOT_FOUND', { message: 'Channel not found' });
    const client = await tx
      .insertInto('api_client')
      .values({
        operator_id: ctx.operatorId,
        channel_id: data.channelId,
        client_id: `vsc_${randomBytes(12).toString('hex')}`,
        name: data.name,
        rate_limit_per_minute: data.rateLimitPerMinute ?? 600,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const secret = await insertSecret(tx, ctx, client.id);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'api_client.created',
      entity: 'api_client',
      entityId: client.id,
      after: {
        client_id: client.client_id,
        channel_id: client.channel_id,
        name: client.name,
        secret_hint: secret.hint,
      },
    });
    return { apiClientId: client.id, clientId: client.client_id, secret: secret.secret };
  });
}

export const addApiClientSecretInput = z.object({ apiClientId: z.uuid() });

/** Rotation step 1: a second active secret (refused when two are already active). */
export async function addApiClientSecret(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof addApiClientSecretInput>,
) {
  const data = parseInput(addApiClientSecretInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const client = await tx
      .selectFrom('api_client')
      .select('id')
      .where('id', '=', data.apiClientId)
      .forUpdate()
      .executeTakeFirst();
    if (!client) throw new DomainError('NOT_FOUND', { message: 'API client not found' });
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from vs.api_client_secret where api_client_id = ${client.id} and revoked_at is null`.execute(
      tx,
    );
    if (rows[0]!.n >= 2)
      throw new DomainError('INVALID_STATE', {
        message: 'Two secrets are already active; revoke one first',
      });
    const secret = await insertSecret(tx, ctx, client.id);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'api_client.secret_added',
      entity: 'api_client',
      entityId: client.id,
      after: { secret_hint: secret.hint },
    });
    return { secretId: secret.secretId, secret: secret.secret };
  });
}

export const revokeApiClientSecretInput = z.object({ secretId: z.uuid() });

/** Rotation step 2: revoke the old secret. */
export async function revokeApiClientSecret(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof revokeApiClientSecretInput>,
) {
  const data = parseInput(revokeApiClientSecretInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const secret = await tx
      .updateTable('api_client_secret')
      .set({ revoked_at: sql<Date>`now()` })
      .where('id', '=', data.secretId)
      .where('revoked_at', 'is', null)
      .returning(['api_client_id', 'hint'])
      .executeTakeFirst();
    if (!secret) throw new DomainError('NOT_FOUND', { message: 'Active secret not found' });
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'api_client.secret_revoked',
      entity: 'api_client',
      entityId: secret.api_client_id,
      after: { secret_hint: secret.hint },
    });
    return { revoked: true };
  });
}

export interface AuthenticatedClient {
  apiClientId: string;
  operatorId: string;
  channelId: string;
}

/**
 * Token endpoint check. Finds the client by its public id through the allow-listed lookup (the
 * tenant is not known yet), then compares the secret's hash in constant time.
 */
export async function authenticateClient(
  db: VsDatabase,
  clientId: string,
  secret: string,
): Promise<AuthenticatedClient | null> {
  if (!/^vsc_[a-z0-9]{16,40}$/.test(clientId) || secret.length < 10 || secret.length > 200)
    return null;
  const { rows } = await db.withLookupTx((tx) =>
    sql<{
      api_client_id: string;
      operator_id: string;
      channel_id: string;
      secret_hashes: string[];
    }>`
      select * from vs.resolve_api_client(${clientId})`.execute(tx),
  );
  const client = rows[0];
  if (!client) return null;
  const given = Buffer.from(hash(secret), 'hex');
  const match = client.secret_hashes.find((h) => timingSafeEqual(Buffer.from(h, 'hex'), given));
  if (!match) return null;
  await db.withTenantTx(
    client.operator_id,
    { type: 'channel', id: client.channel_id },
    ({ db: tx }) =>
      tx
        .updateTable('api_client_secret')
        .set({ last_used_at: sql<Date>`now()` })
        .where('secret_hash', '=', match)
        .execute(),
  );
  return {
    apiClientId: client.api_client_id,
    operatorId: client.operator_id,
    channelId: client.channel_id,
  };
}

/**
 * Fixed one-minute window per client (Postgres-backed). Returns whether this request is allowed
 * and, when it is not, the seconds until the window resets.
 */
export async function consumeRateLimit(db: VsDatabase, ctx: EngineContext, apiClientId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{ hits: number; limit: number; reset_in: number }>`
      with hit as (
        insert into vs.rate_limit_counter (operator_id, api_client_id, window_start, hits)
        values (${ctx.operatorId}, ${apiClientId}, date_trunc('minute', now()), 1)
        on conflict (api_client_id, window_start) do update set hits = vs.rate_limit_counter.hits + 1
        returning hits
      )
      select hit.hits, c.rate_limit_per_minute as limit,
             ceil(extract(epoch from date_trunc('minute', now()) + interval '1 minute' - now()))::int as reset_in
      from hit, vs.api_client c where c.id = ${apiClientId}`.execute(tx);
    const row = rows[0]!;
    return {
      allowed: row.hits <= row.limit,
      limit: row.limit,
      remaining: Math.max(0, row.limit - row.hits),
      retryAfter: Math.max(1, row.reset_in),
    };
  });
}

/** Worker housekeeping: drop rate-limit windows older than an hour. */
export async function pruneRateLimits(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const result =
      await sql`delete from vs.rate_limit_counter where window_start < now() - interval '1 hour'`.execute(
        tx,
      );
    return { pruned: Number(result.numAffectedRows ?? 0) };
  });
}
