import { sql } from 'kysely';
import type { VsDatabase } from '@vs/db';
import type { EngineContext } from '../internal';

/** Channels with everything that governs them: contracts, allotments, API clients, webhooks. */
export async function listChannelsDetail(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const channels = await tx
      .selectFrom('channel')
      .select([
        'id',
        'code',
        'name',
        'type',
        'active',
        'credit_allowed as creditAllowed',
        'credit_limit as creditLimit',
        'credit_currency as creditCurrency',
      ])
      .orderBy(sql`type = 'back_office'`, 'desc')
      .orderBy('name')
      .execute();
    const contracts = await sql<{
      id: string;
      channelId: string;
      vessel: string;
      vesselId: string;
      allocation: string;
      paymentMode: string;
      priceAdjustment: string;
      adjustmentBps: number;
      visibleFreeCap: number | null;
      checkoutHoldMinutes: number;
      optionHoldHours: number;
      requestSlaHours: number;
      stopSell: boolean;
      creditLimitMode: string;
      folioToAgency: boolean;
      active: boolean;
      validFrom: string;
      validTo: string | null;
    }>`
      select k.id, k.channel_id as "channelId", v.name as vessel, v.id as "vesselId", k.allocation,
             k.payment_mode as "paymentMode", k.price_adjustment as "priceAdjustment", k.adjustment_bps as "adjustmentBps",
             k.visible_free_cap as "visibleFreeCap", k.checkout_hold_minutes as "checkoutHoldMinutes",
             k.option_hold_hours as "optionHoldHours", k.request_sla_hours as "requestSlaHours", k.stop_sell as "stopSell", k.credit_limit_mode as "creditLimitMode", k.folio_to_agency as "folioToAgency",
             k.active, k.valid_from::text as "validFrom", k.valid_to::text as "validTo"
      from vs.channel_contract k join vs.vessel v on v.id = k.vessel_id
      order by v.name`.execute(tx);
    const allotments = await sql<{
      id: string;
      channelId: string;
      vessel: string;
      status: string;
      releaseDays: number;
      firstDate: string | null;
      lastDate: string | null;
      legs: number;
      cabins: number;
      booked: number;
      notes: string | null;
    }>`
      select a.id, a.channel_id as "channelId", v.name as vessel, a.status, a.release_days as "releaseDays",
             min(l.depart_date)::text as "firstDate", max(l.depart_date)::text as "lastDate",
             count(distinct b.leg_id) filter (where b.released_at is null)::int as legs,
             coalesce(sum(b.total) filter (where b.released_at is null), 0)::int as cabins,
             coalesce(sum(b.booked), 0)::int as booked, a.notes
      from vs.allotment a join vs.vessel v on v.id = a.vessel_id
      left join vs.inventory_bucket b on b.allotment_id = a.id
      left join vs.leg l on l.id = b.leg_id
      group by a.id, v.name order by min(l.depart_date) nulls last`.execute(tx);
    const clients = await sql<{
      id: string;
      channelId: string;
      clientId: string;
      name: string;
      active: boolean;
      rateLimitPerMinute: number;
      secrets: { id: string; hint: string; lastUsedAt: string | null; createdAt: string }[];
    }>`
      select c.id, c.channel_id as "channelId", c.client_id as "clientId", c.name, c.active,
             c.rate_limit_per_minute as "rateLimitPerMinute",
             coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'hint', s.hint, 'lastUsedAt', s.last_used_at,
                                                           'createdAt', s.created_at) order by s.created_at)
                       from vs.api_client_secret s where s.api_client_id = c.id and s.revoked_at is null), '[]') as secrets
      from vs.api_client c order by c.created_at`.execute(tx);
    const endpoints = await sql<{
      id: string;
      channelId: string;
      url: string;
      active: boolean;
      eventTypes: string[] | null;
      pending: number;
      delivered: number;
      dead: number;
    }>`
      select w.id, w.channel_id as "channelId", w.url, w.active, w.event_types as "eventTypes",
             count(d.id) filter (where d.status = 'pending')::int as pending,
             count(d.id) filter (where d.status = 'delivered')::int as delivered,
             count(d.id) filter (where d.status = 'dead')::int as dead
      from vs.webhook_endpoint w left join vs.webhook_delivery d on d.endpoint_id = w.id
      group by w.id order by w.created_at`.execute(tx);
    return channels.map((c) => ({
      ...c,
      contracts: contracts.rows.filter((k) => k.channelId === c.id),
      allotments: allotments.rows.filter((a) => a.channelId === c.id),
      clients: clients.rows.filter((k) => k.channelId === c.id),
      endpoints: endpoints.rows.filter((w) => w.channelId === c.id),
    }));
  });
}

/** The delivery log of one endpoint, newest first. */
export async function listWebhookDeliveries(
  db: VsDatabase,
  ctx: EngineContext,
  input: { endpointId: string; status?: 'pending' | 'delivered' | 'dead'; limit?: number },
) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
      id: string;
      status: string;
      eventType: string;
      resource: string;
      resourceId: string;
      attempts: number;
      lastStatusCode: number | null;
      lastError: string | null;
      nextAttemptAt: Date;
      deliveredAt: Date | null;
      createdAt: Date;
    }>`
      select d.id, d.status, e.type as "eventType", e.resource, d.resource_id as "resourceId", d.attempts,
             d.last_status_code as "lastStatusCode", d.last_error as "lastError", d.next_attempt_at as "nextAttemptAt",
             d.delivered_at as "deliveredAt", d.created_at as "createdAt"
      from vs.webhook_delivery d join vs.event e on e.id = d.event_id
      where d.endpoint_id = ${input.endpointId}
        ${input.status ? sql`and d.status = ${input.status}` : sql``}
      order by d.created_at desc limit ${Math.min(input.limit ?? 100, 500)}`.execute(tx);
    return rows;
  });
}

/** The payments ledger across bookings, newest first; reversals show as their own rows. */
export async function listPayments(
  db: VsDatabase,
  ctx: EngineContext,
  input: { from?: string; to?: string; method?: string; limit?: number },
) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
      id: string;
      ref: string;
      kind: string;
      method: string;
      amount: bigint;
      currency: string;
      bookingAmount: bigint;
      bookingCurrency: string;
      reference: string;
      receivedOn: string;
      reverses: string | null;
      reversed: boolean;
      receiptId: string | null;
      /** Written by a party receipt's allocation: undone on the receipt, not reversed here. */
      fromAllocation: boolean;
      actor: string | null;
      createdAt: Date;
    }>`
      select p.id, b.ref, p.kind, p.method, p.amount, p.currency, p.booking_amount as "bookingAmount",
             b.currency as "bookingCurrency", p.reference, p.received_on::text as "receivedOn",
             p.reverses_payment_id as reverses,
             exists (select from vs.payment r where r.reverses_payment_id = p.id) as reversed,
             p.receipt_id as "receiptId", (p.allocation_id is not null) as "fromAllocation",
             coalesce(s.display_name, p.actor_label, p.actor_type) as actor, p.created_at as "createdAt"
      from vs.payment p join vs.booking b on b.id = p.booking_id
      left join vs.staff_user s on s.id = p.actor_id
      where true
        ${input.from ? sql`and p.received_on >= ${input.from}::date` : sql``}
        ${input.to ? sql`and p.received_on <= ${input.to}::date` : sql``}
        ${input.method ? sql`and p.method = ${input.method}` : sql``}
      order by p.created_at desc limit ${Math.min(input.limit ?? 100, 500)}`.execute(tx);
    const totals = await sql<{ currency: string; kind: string; amount: bigint }>`
      select p.currency, p.kind, sum(p.amount)::bigint as amount
      from vs.payment p
      where true
        ${input.from ? sql`and p.received_on >= ${input.from}::date` : sql``}
        ${input.to ? sql`and p.received_on <= ${input.to}::date` : sql``}
        ${input.method ? sql`and p.method = ${input.method}` : sql``}
      group by p.currency, p.kind order by p.currency, p.kind`.execute(tx);
    return { payments: rows, totals: totals.rows };
  });
}
