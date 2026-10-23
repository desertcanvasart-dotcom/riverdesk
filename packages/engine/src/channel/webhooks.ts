import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import {
  decryptField,
  encryptField,
  fieldKeyring,
  loadConfig,
  type FieldKeyring,
} from '@vs/shared';
import { audit } from '../audit';
import { parseInput, type EngineContext } from '../internal';
import { channelEventFilter, toEventView, type EventView } from './reads';

/**
 * Webhooks (spec § Events and webhooks): at-least-once, in order per resource, signed with
 * HMAC-SHA256 over "<timestamp>.<body>", retried with exponential backoff for 24 hours. Every
 * attempt is recorded; a delivery can be replayed.
 */

let keyring: FieldKeyring | undefined;
const keys = () => (keyring ??= fieldKeyring(loadConfig()));

export const createWebhookEndpointInput = z.object({
  channelId: z.uuid(),
  url: z.url().refine((u) => /^https?:\/\//.test(u), 'http(s) only'),
  eventTypes: z
    .array(z.string().regex(/^[a-z]+\.[a-z_]+$/))
    .min(1)
    .optional(),
});

/** Returns the signing secret once; it is stored encrypted. */
export async function createWebhookEndpoint(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createWebhookEndpointInput>,
) {
  const data = parseInput(createWebhookEndpointInput, input);
  const secret = `whsec_${randomBytes(32).toString('base64url')}`;
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    // New endpoints start at the current end of the feed: no back-fill of old events.
    const { rows } = await sql<{ txid: string; seq: string }>`
      select coalesce(max(txid), '0'::xid8)::text as txid, coalesce(max(seq), 0)::text as seq from vs.event`.execute(
      tx,
    );
    const endpoint = await tx
      .insertInto('webhook_endpoint')
      .values({
        operator_id: ctx.operatorId,
        channel_id: data.channelId,
        url: data.url,
        secret_ciphertext: encryptField(secret, keys().current),
        secret_key_id: keys().current.id,
        event_types: data.eventTypes ?? null,
        last_txid: rows[0]!.txid,
        last_seq: BigInt(rows[0]!.seq),
      })
      .returning(['id', 'url'])
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'webhook_endpoint.created',
      entity: 'webhook_endpoint',
      entityId: endpoint.id,
      after: { url: endpoint.url, event_types: data.eventTypes ?? 'all' },
    });
    return { endpointId: endpoint.id, secret };
  });
}

/**
 * Fans new events out to every active endpoint (one delivery per endpoint × event), reading the
 * feed below the safe horizon so no event is skipped. Returns the number of deliveries created.
 */
export async function dispatchWebhooks(
  db: VsDatabase,
  ctx: EngineContext,
): Promise<{ created: number }> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const endpoints = await tx
      .selectFrom('webhook_endpoint')
      .select([
        'id',
        'channel_id',
        'event_types',
        sql<string>`last_txid::text`.as('last_txid'),
        'last_seq',
      ])
      .where('active', '=', true)
      .forUpdate()
      .skipLocked()
      .execute();
    let created = 0;
    for (const endpoint of endpoints) {
      const { rows } = await sql<{ id: string; resource_id: string; txid: string; seq: bigint }>`
        select e.id, e.resource_id, e.txid::text, e.seq
        from vs.event e
        where e.txid < vs.event_horizon()
          and (e.txid, e.seq) > (${endpoint.last_txid}::xid8, ${endpoint.last_seq}::bigint)
          and ${channelEventFilter(endpoint.channel_id)}
          ${endpoint.event_types ? sql`and e.type = any(${endpoint.event_types}::text[])` : sql``}
        order by e.txid, e.seq
        limit 1000`.execute(tx);
      if (rows.length === 0) continue;
      const inserted = await tx
        .insertInto('webhook_delivery')
        .values(
          rows.map((e) => ({
            operator_id: ctx.operatorId,
            endpoint_id: endpoint.id,
            event_id: e.id,
            resource_id: e.resource_id,
            event_txid: e.txid,
            event_seq: e.seq,
          })),
        )
        .onConflict((oc) => oc.columns(['endpoint_id', 'event_id']).doNothing())
        .returning('id')
        .execute();
      created += inserted.length;
      const last = rows.at(-1)!;
      await sql`update vs.webhook_endpoint set last_txid = ${last.txid}::xid8, last_seq = ${last.seq} where id = ${endpoint.id}`.execute(
        tx,
      );
    }
    return { created };
  });
}

export interface DueDelivery {
  deliveryId: string;
  attempt: number;
  url: string;
  secret: string;
  event: EventView;
}

/**
 * Claims due deliveries (a 2-minute lease, so a crashed sender does not lose them). A delivery is
 * only due when no earlier event of the same resource is still pending for that endpoint, so
 * each resource arrives in order.
 */
export async function claimDueDeliveries(
  db: VsDatabase,
  ctx: EngineContext,
  limit = 50,
): Promise<DueDelivery[]> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
      id: string;
      attempts: number;
      url: string;
      secret_ciphertext: Buffer;
      secret_key_id: string;
      event_id: string;
    }>`
      select d.id, d.attempts, w.url, w.secret_ciphertext, w.secret_key_id, d.event_id
      from vs.webhook_delivery d
      join vs.webhook_endpoint w on w.id = d.endpoint_id and w.active
      where d.status = 'pending' and d.next_attempt_at <= now()
        and not exists (
          select from vs.webhook_delivery p
          where p.endpoint_id = d.endpoint_id and p.resource_id = d.resource_id and p.status = 'pending'
            and (p.event_txid, p.event_seq) < (d.event_txid, d.event_seq))
      order by d.event_txid, d.event_seq
      limit ${limit}
      for update of d skip locked`.execute(tx);
    if (rows.length === 0) return [];
    await sql`
      update vs.webhook_delivery
      set next_attempt_at = now() + interval '2 minutes', attempts = attempts + 1, first_attempt_at = coalesce(first_attempt_at, now())
      where id = any(${rows.map((r) => r.id)}::uuid[])`.execute(tx);
    const events = await sql<{
      id: string;
      type: string;
      resource: string;
      resource_id: string;
      resource_version: bigint;
      occurred_at: Date;
      payload: Record<string, unknown>;
      txid: string;
      seq: bigint;
    }>`
      select id, type, resource, resource_id, resource_version, occurred_at, payload, txid::text, seq
      from vs.event where id = any(${rows.map((r) => r.event_id)}::uuid[])`.execute(tx);
    const byId = new Map(events.rows.map((e) => [e.id, toEventView(e)]));
    return rows.map((r) => ({
      deliveryId: r.id,
      attempt: r.attempts + 1,
      url: r.url,
      secret: decryptField(Buffer.from(r.secret_ciphertext), r.secret_key_id, keys()),
      event: byId.get(r.event_id)!,
    }));
  });
}

/** Backoff after the n-th failed attempt: 1, 2, 4, … minutes, at most 2 hours. */
export function retryDelayMinutes(attempt: number): number {
  return Math.min(2 ** Math.max(attempt - 1, 0), 120);
}

/** Records one attempt; 2xx delivers, otherwise retry with backoff until 24 h after the first attempt. */
export async function recordDeliveryAttempt(
  db: VsDatabase,
  ctx: EngineContext,
  result: {
    deliveryId: string;
    attempt: number;
    statusCode: number | null;
    error: string | null;
    durationMs: number;
  },
) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await tx
      .insertInto('webhook_attempt')
      .values({
        operator_id: ctx.operatorId,
        delivery_id: result.deliveryId,
        attempt: result.attempt,
        status_code: result.statusCode,
        error: result.error?.slice(0, 500) ?? null,
        duration_ms: result.durationMs,
      })
      .execute();
    const ok = result.statusCode !== null && result.statusCode >= 200 && result.statusCode < 300;
    await sql`
      update vs.webhook_delivery set
        status = case when ${ok} then 'delivered'
                      when first_attempt_at < now() - interval '24 hours' then 'dead'
                      else 'pending' end,
        delivered_at = case when ${ok} then now() else delivered_at end,
        next_attempt_at = now() + make_interval(mins => ${retryDelayMinutes(result.attempt)}),
        last_status_code = ${result.statusCode},
        last_error = ${result.error?.slice(0, 500) ?? null}
      where id = ${result.deliveryId}`.execute(tx);
  });
}

export const replayWebhookDeliveryInput = z.object({ deliveryId: z.uuid() });

/** Sends a delivered or dead event again (for the channel's or the operator's replay button). */
export async function replayWebhookDelivery(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof replayWebhookDeliveryInput>,
) {
  const data = parseInput(replayWebhookDeliveryInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const delivery = await tx
      .updateTable('webhook_delivery')
      .set({
        status: 'pending',
        next_attempt_at: sql<Date>`now()`,
        first_attempt_at: sql<Date>`now()`,
      })
      .where('id', '=', data.deliveryId)
      .returning(['id', 'event_id'])
      .executeTakeFirst();
    if (!delivery) throw new DomainError('NOT_FOUND', { message: 'Delivery not found' });
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'webhook_delivery.replayed',
      entity: 'webhook_delivery',
      entityId: delivery.id,
      after: { event_id: delivery.event_id },
    });
    return { deliveryId: delivery.id };
  });
}

// ---------------------------------------------------------------------------
// Signature (also what receivers implement; see docs/integration-nilecrz.md)
// ---------------------------------------------------------------------------

export function signWebhook(secret: string, body: string, timestamp: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/** Verifies `X-VS-Signature`; rejects signatures older than `toleranceSeconds`. */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=', 2) as [string, string]),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowSeconds - t) > toleranceSeconds)
    return false;
  const expected = Buffer.from(signWebhook(secret, body, t).split('v1=')[1]!, 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
