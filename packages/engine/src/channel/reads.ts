import { sql } from 'kysely';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import type { EngineContext, Tx } from '../internal';

/**
 * Read model for the channel API. Every function takes the calling channel and only returns what
 * its contracts allow (spec § Contract enforcement); someone else's booking, hold or offer is
 * NOT_FOUND, never FORBIDDEN, so its existence does not leak.
 */

export interface ChannelContract {
  id: string;
  vessel_id: string;
  allocation: string;
  payment_mode: string;
  visible_free_cap: number | null;
  stop_sell: boolean;
}

/** Active contracts of a channel, by vessel. */
export async function channelContracts(
  tx: Tx,
  channelId: string,
): Promise<Map<string, ChannelContract>> {
  const rows = await tx
    .selectFrom('channel_contract')
    .select(['id', 'vessel_id', 'allocation', 'payment_mode', 'visible_free_cap', 'stop_sell'])
    .where('channel_id', '=', channelId)
    .where('active', '=', true)
    .execute();
  return new Map(rows.map((r) => [r.vessel_id, r]));
}

async function contractFor(tx: Tx, channelId: string, vesselId: string) {
  const contract = (await channelContracts(tx, channelId)).get(vesselId);
  if (!contract)
    throw new DomainError('CONTRACT_FORBIDS', { message: 'This vessel is not in your contract' });
  return contract;
}

// ---------------------------------------------------------------------------
// Ownership: entities a channel may act on
// ---------------------------------------------------------------------------
export async function bookingIdForChannel(
  db: VsDatabase,
  ctx: EngineContext,
  channelId: string,
  ref: string,
): Promise<string> {
  const row = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx
      .selectFrom('booking')
      .select('id')
      .where('ref', '=', ref)
      .where('channel_id', '=', channelId)
      .executeTakeFirst(),
  );
  if (!row) throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
  return row.id;
}

export async function assertOwnedBy(
  db: VsDatabase,
  ctx: EngineContext,
  channelId: string,
  kind: 'hold' | 'offer',
  id: string,
): Promise<void> {
  const owned = await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    if (kind === 'hold') {
      return tx
        .selectFrom('hold')
        .select('id')
        .where('id', '=', id)
        .where('channel_id', '=', channelId)
        .executeTakeFirst();
    }
    return tx
      .selectFrom('offer as o')
      .innerJoin('booking as b', 'b.id', 'o.booking_id')
      .select('o.id')
      .where('o.id', '=', id)
      .where('b.channel_id', '=', channelId)
      .executeTakeFirst();
  });
  if (!owned)
    throw new DomainError('NOT_FOUND', {
      message: `${kind === 'hold' ? 'Hold' : 'Offer'} not found`,
    });
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
export async function listChannelVessels(db: VsDatabase, ctx: EngineContext, channelId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const contracts = await channelContracts(tx, channelId);
    const out = [];
    for (const contract of contracts.values()) {
      const vessel = await tx
        .selectFrom('vessel')
        .selectAll()
        .where('id', '=', contract.vessel_id)
        .executeTakeFirstOrThrow();
      const categories = await tx
        .selectFrom('channel_contract_category as cc')
        .innerJoin('cabin_category as c', 'c.id', 'cc.category_id')
        .select([
          'c.id',
          'c.code',
          'c.name_en',
          'c.name_ar',
          'c.deck',
          'c.bed_config',
          'c.max_adults',
          'c.max_occupancy',
          'c.sort_order',
        ])
        .where('cc.contract_id', '=', contract.id)
        .orderBy('c.sort_order')
        .execute();
      const plans = await tx
        .selectFrom('channel_contract_rate_plan as cr')
        .innerJoin('rate_plan as p', 'p.id', 'cr.rate_plan_id')
        .select([
          'p.id',
          'p.code',
          'p.name',
          'p.market',
          'p.currency',
          'p.board',
          'p.pricing_unit',
          'p.pricing_period',
        ])
        .where('cr.contract_id', '=', contract.id)
        .where('p.active', '=', true)
        .execute();
      out.push({ vessel, allocation: contract.allocation, categories, plans });
    }
    return out;
  });
}

export interface SailingView {
  id: string;
  vesselId: string;
  patternCode: string | null;
  name: { en: string; ar: string } | null;
  embarkPort: PortView;
  disembarkPort: PortView;
  embarkDate: string;
  disembarkDate: string;
  nights: number;
  status: string;
  legs: {
    id: string;
    fromPort: PortView;
    toPort: PortView;
    departDate: string;
    arriveDate: string;
  }[];
}
export interface PortView {
  code: string;
  name: { en: string; ar: string };
}

async function sailingViews(
  tx: Tx,
  filter: {
    ids?: string[];
    vesselId?: string;
    from?: string;
    to?: string;
    nights?: number;
    openOnly?: boolean;
  },
): Promise<SailingView[]> {
  const { rows } = await sql<{
    id: string;
    vessel_id: string;
    pattern_code: string | null;
    name_en: string | null;
    name_ar: string | null;
    embark_date: string;
    disembark_date: string;
    nights: number;
    status: string;
    embark: PortView;
    disembark: PortView;
    legs: {
      id: string;
      from_port: PortView;
      to_port: PortView;
      depart_date: string;
      arrive_date: string;
    }[];
  }>`
    select s.id, s.vessel_id, sp.code as pattern_code, sp.name_en, sp.name_ar,
           s.embark_date::text, s.disembark_date::text, s.nights, s.status,
           jsonb_build_object('code', ep.code, 'name', jsonb_build_object('en', ep.name_en, 'ar', ep.name_ar)) as embark,
           jsonb_build_object('code', dp.code, 'name', jsonb_build_object('en', dp.name_en, 'ar', dp.name_ar)) as disembark,
           (select jsonb_agg(jsonb_build_object(
                     'id', l.id, 'depart_date', l.depart_date, 'arrive_date', l.arrive_date,
                     'from_port', jsonb_build_object('code', fp.code, 'name', jsonb_build_object('en', fp.name_en, 'ar', fp.name_ar)),
                     'to_port', jsonb_build_object('code', tp.code, 'name', jsonb_build_object('en', tp.name_en, 'ar', tp.name_ar)))
                   order by sl.seq)
            from vs.sailing_leg sl join vs.leg l on l.id = sl.leg_id
            join vs.port fp on fp.id = l.from_port_id join vs.port tp on tp.id = l.to_port_id
            where sl.sailing_id = s.id) as legs
    from vs.sailing s
    join vs.port ep on ep.id = s.embark_port_id
    join vs.port dp on dp.id = s.disembark_port_id
    left join vs.sailing_pattern sp on sp.id = s.pattern_id
    where true
      ${filter.ids ? sql`and s.id = any(${filter.ids}::uuid[])` : sql``}
      ${filter.vesselId ? sql`and s.vessel_id = ${filter.vesselId}` : sql``}
      ${filter.from ? sql`and s.embark_date >= ${filter.from}::date` : sql``}
      ${filter.to ? sql`and s.embark_date <= ${filter.to}::date` : sql``}
      ${filter.nights ? sql`and s.nights = ${filter.nights}` : sql``}
      ${filter.openOnly ? sql`and s.status = 'open'` : sql``}
    order by s.embark_date, s.nights, sp.code`.execute(tx);
  return rows.map((r) => ({
    id: r.id,
    vesselId: r.vessel_id,
    patternCode: r.pattern_code,
    name: r.name_en ? { en: r.name_en, ar: r.name_ar ?? r.name_en } : null,
    embarkPort: r.embark,
    disembarkPort: r.disembark,
    embarkDate: r.embark_date,
    disembarkDate: r.disembark_date,
    nights: r.nights,
    status: r.status,
    legs: (r.legs ?? []).map((l) => ({
      id: l.id,
      fromPort: l.from_port,
      toPort: l.to_port,
      departDate: l.depart_date,
      arriveDate: l.arrive_date,
    })),
  }));
}

function assertRange(from: string, to: string, maxDays: number) {
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!(days >= 0) || days > maxDays) {
    throw new DomainError('VALIDATION_FAILED', { message: `from/to must span 0–${maxDays} days` });
  }
}

export async function listSailings(
  db: VsDatabase,
  ctx: EngineContext,
  input: { channelId: string; vesselId: string; from: string; to: string; nights?: number },
) {
  assertRange(input.from, input.to, 400);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await contractFor(tx, input.channelId, input.vesselId);
    return sailingViews(tx, {
      vesselId: input.vesselId,
      from: input.from,
      to: input.to,
      nights: input.nights,
      openOnly: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Availability for a channel
// ---------------------------------------------------------------------------
export interface ChannelAvailability {
  asOf: Date;
  sailings: {
    sailingId: string;
    patternCode: string | null;
    embarkDate: string;
    disembarkDate: string;
    nights: number;
    categories: {
      categoryId: string;
      code: string;
      status: 'instant' | 'on_request' | 'sold_out';
      free: number;
      fromPrice: { amount: bigint; currency: string } | null;
    }[];
  }[];
}

/**
 * Per sailing × contracted category: free = the minimum across the sailing's legs of what this
 * channel can take on that leg (its own unreleased allotment, plus the pool unless the contract
 * is allotment-only); 0 if a leg is not open or stopped; capped by the visible-free cap. The
 * from-price is per person at double occupancy on the cheapest contracted plan.
 */
export async function channelAvailability(
  db: VsDatabase,
  ctx: EngineContext,
  input: { channelId: string; vesselId: string; from: string; to: string },
): Promise<ChannelAvailability> {
  assertRange(input.from, input.to, 120);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const contract = await contractFor(tx, input.channelId, input.vesselId);
    const { rows } = await sql<{
      as_of: Date;
      sailing_id: string;
      pattern_code: string | null;
      embark_date: string;
      disembark_date: string;
      nights: number;
      category_id: string;
      code: string;
      free: number;
      unavailable: boolean;
      from_amount: string | null;
      from_currency: string | null;
    }>`
      with per_leg as (
        select s.id as sailing_id, l.id as leg_id, c.id as category_id,
               bool_or(l.status <> 'open') or bool_or(b.kind = 'pool' and b.stop_sale) or not bool_or(b.kind = 'pool') as blocked,
               coalesce(sum(case when b.kind = 'pool' and ${contract.allocation} <> 'allotment' then greatest(b.total - b.held - b.booked, 0) else 0 end), 0)
             + coalesce(sum(case when b.kind = 'allotment' and b.released_at is null and a.channel_id = ${input.channelId} and a.status = 'active'
                                 then greatest(b.total - b.held - b.booked, 0) else 0 end), 0) as free
        from vs.sailing s
        join vs.sailing_leg sl on sl.sailing_id = s.id
        join vs.leg l on l.id = sl.leg_id
        join vs.channel_contract_category cc on cc.contract_id = ${contract.id}
        join vs.cabin_category c on c.id = cc.category_id
        left join vs.inventory_bucket b on b.leg_id = l.id and b.category_id = c.id
        left join vs.allotment a on a.id = b.allotment_id
        where s.vessel_id = ${input.vesselId} and s.status = 'open'
          and s.embark_date between ${input.from}::date and ${input.to}::date
        group by s.id, l.id, c.id
      ),
      per_sailing as (
        select sailing_id, category_id, bool_or(blocked) as unavailable, min(free)::int as free
        from per_leg group by sailing_id, category_id
      ),
      prices as (
        select s.id as sailing_id, r.category_id, p.currency,
               min(case
                 when p.pricing_unit = 'per_person' then r.amount * (case when p.pricing_period = 'per_night' then s.nights else 1 end)
                 else (r.amount * (case when p.pricing_period = 'per_night' then s.nights else 1 end) + 1) / 2
               end) as amount
        from vs.sailing s
        join vs.season_period sp on sp.vessel_id = s.vessel_id and sp.during @> s.embark_date
        join vs.channel_contract_rate_plan cr on cr.contract_id = ${contract.id}
        join vs.rate_plan p on p.id = cr.rate_plan_id and p.active and p.min_nights <= s.nights
        join vs.rate r on r.rate_plan_id = p.id and r.season_id = sp.season_id
          and (r.basis = 'double' or r.basis is null)
          and (p.pricing_period = 'per_night' or r.sailing_pattern_id = s.pattern_id)
        where s.vessel_id = ${input.vesselId} and s.embark_date between ${input.from}::date and ${input.to}::date
        group by s.id, r.category_id, p.currency
      ),
      cheapest as (
        select distinct on (sailing_id, category_id) sailing_id, category_id, amount, currency
        from prices order by sailing_id, category_id, amount
      )
      select now() as as_of, s.id as sailing_id, sp.code as pattern_code, s.embark_date::text, s.disembark_date::text, s.nights,
             c.id as category_id, c.code, ps.free, ps.unavailable,
             ch.amount::text as from_amount, ch.currency as from_currency
      from per_sailing ps
      join vs.sailing s on s.id = ps.sailing_id
      left join vs.sailing_pattern sp on sp.id = s.pattern_id
      join vs.cabin_category c on c.id = ps.category_id
      left join cheapest ch on ch.sailing_id = ps.sailing_id and ch.category_id = ps.category_id
      order by s.embark_date, s.nights, sp.code, c.sort_order, c.code`.execute(tx);

    const asOf =
      rows[0]?.as_of ?? (await sql<{ now: Date }>`select now() as now`.execute(tx)).rows[0]!.now;
    const sailings = new Map<string, ChannelAvailability['sailings'][number]>();
    for (const r of rows) {
      let sailing = sailings.get(r.sailing_id);
      if (!sailing) {
        sailing = {
          sailingId: r.sailing_id,
          patternCode: r.pattern_code,
          embarkDate: r.embark_date,
          disembarkDate: r.disembark_date,
          nights: r.nights,
          categories: [],
        };
        sailings.set(r.sailing_id, sailing);
      }
      const raw = r.unavailable || contract.stop_sell ? 0 : r.free;
      const free =
        contract.visible_free_cap === null ? raw : Math.min(raw, contract.visible_free_cap);
      const status = contract.stop_sell
        ? 'sold_out'
        : contract.allocation === 'on_request'
          ? 'on_request'
          : free > 0
            ? 'instant'
            : 'sold_out';
      sailing.categories.push({
        categoryId: r.category_id,
        code: r.code,
        status,
        free,
        fromPrice:
          r.from_amount === null
            ? null
            : { amount: BigInt(r.from_amount), currency: r.from_currency! },
      });
    }
    return { asOf, sailings: [...sailings.values()] };
  });
}

// ---------------------------------------------------------------------------
// Bookings and holds as a channel sees them
// ---------------------------------------------------------------------------
export interface BookingView {
  ref: string;
  channelRef: string | null;
  status: string;
  paymentStatus: string;
  revision: number;
  currency: string;
  total: bigint;
  fees: bigint;
  amountPaid: bigint;
  penalty: bigint | null;
  sailing: SailingView;
  cabins: {
    index: number;
    categoryCode: string;
    adults: number;
    childAges: number[];
    guests: { firstName: string; lastName: string; lead: boolean }[];
  }[];
  paymentsDue: { kind: 'deposit' | 'balance'; amount: bigint; dueDate: string }[];
  openOffer: {
    id: string;
    sailingId: string;
    expiresAt: Date;
    total: bigint;
    currency: string;
  } | null;
  requestExpiresAt: Date | null;
  holdExpiresAt: Date | null;
  createdAt: Date;
}

export async function getBookingView(
  db: VsDatabase,
  ctx: EngineContext,
  bookingId: string,
): Promise<BookingView> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const b = await tx
      .selectFrom('booking')
      .selectAll()
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow();
    const [sailing] = await sailingViews(tx, { ids: [b.sailing_id] });
    const cabins = await tx
      .selectFrom('booking_cabin as bc')
      .innerJoin('cabin_category as c', 'c.id', 'bc.category_id')
      .select(['bc.id', 'bc.seq', 'c.code', 'bc.adults', 'bc.child_ages'])
      .where('bc.booking_id', '=', b.id)
      .where('bc.status', '=', 'active')
      .orderBy('bc.seq')
      .execute();
    // Names only: dates of birth and passport numbers never leave the system through the API.
    const guests = await tx
      .selectFrom('guest')
      .select(['booking_cabin_id', 'first_name', 'last_name', 'lead'])
      .where('booking_id', '=', b.id)
      .orderBy('lead', 'desc')
      .orderBy('created_at')
      .execute();
    const offer = await sql<{
      id: string;
      sailing_id: string;
      expires_at: Date;
      total: bigint;
      currency: string;
    }>`
      select o.id, q.sailing_id, o.expires_at, q.total, q.currency
      from vs.offer o join vs.quote q on q.id = o.quote_id
      where o.booking_id = ${b.id} and o.status = 'open'`.execute(tx);
    const hold = await sql<{ expires_at: Date }>`
      select expires_at from vs.hold where booking_id = ${b.id} and status = 'active' order by expires_at desc limit 1`.execute(
      tx,
    );

    const paymentsDue: BookingView['paymentsDue'] = [];
    if (['held', 'confirmed'].includes(b.status)) {
      const depositLeft = b.deposit_amount - b.amount_paid;
      if (depositLeft > 0n)
        paymentsDue.push({
          kind: 'deposit',
          amount: depositLeft,
          dueDate: b.created_at.toISOString().slice(0, 10),
        });
      const paidTowardsBalance =
        b.amount_paid > b.deposit_amount ? b.amount_paid : b.deposit_amount;
      const balance = b.total + b.fees - paidTowardsBalance;
      if (balance > 0n && b.balance_due_date)
        paymentsDue.push({ kind: 'balance', amount: balance, dueDate: b.balance_due_date });
    }
    return {
      ref: b.ref,
      channelRef: b.channel_ref,
      status: b.status,
      paymentStatus: b.payment_status,
      revision: b.revision,
      currency: b.currency,
      total: b.total,
      fees: b.fees,
      amountPaid: b.amount_paid,
      penalty: b.penalty_amount,
      sailing: sailing!,
      cabins: cabins.map((c) => ({
        index: c.seq,
        categoryCode: c.code,
        adults: c.adults,
        childAges: c.child_ages,
        guests: guests
          .filter((g) => g.booking_cabin_id === c.id)
          .map((g) => ({ firstName: g.first_name, lastName: g.last_name, lead: g.lead })),
      })),
      paymentsDue,
      openOffer: offer.rows[0]
        ? {
            id: offer.rows[0].id,
            sailingId: offer.rows[0].sailing_id,
            expiresAt: offer.rows[0].expires_at,
            total: offer.rows[0].total,
            currency: offer.rows[0].currency,
          }
        : null,
      requestExpiresAt: b.status === 'requested' ? b.request_expires_at : null,
      holdExpiresAt: hold.rows[0]?.expires_at ?? null,
      createdAt: b.created_at,
    };
  });
}

export async function getHoldView(db: VsDatabase, ctx: EngineContext, holdId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx
      .selectFrom('hold')
      .select(['id', 'kind', 'status', 'expires_at', 'quote_id'])
      .where('id', '=', holdId)
      .executeTakeFirstOrThrow(),
  );
}

// ---------------------------------------------------------------------------
// Event feed
// ---------------------------------------------------------------------------
export interface EventView {
  eventId: string;
  type: string;
  resource: string;
  resourceId: string;
  resourceVersion: bigint;
  occurredAt: Date;
  data: Record<string, unknown>;
  txid: string;
  seq: bigint;
}

/** Which events a channel may see: its own bookings and holds; availability, sailings and rates of what it has contracted. */
export function channelEventFilter(channelId: string) {
  return sql`(
    e.payload->>'channel_id' = ${channelId}
    or (e.type in ('availability.changed', 'sailing.changed') and (e.payload->>'vessel_id')::uuid in (
          select vessel_id from vs.channel_contract where channel_id = ${channelId} and active)
        and (e.type <> 'availability.changed' or (e.payload->>'category_id')::uuid in (
          select cc.category_id from vs.channel_contract_category cc join vs.channel_contract k on k.id = cc.contract_id
          where k.channel_id = ${channelId} and k.active)))
    or (e.type = 'rate.changed' and e.resource_id in (
          select cr.rate_plan_id from vs.channel_contract_rate_plan cr join vs.channel_contract k on k.id = cr.contract_id
          where k.channel_id = ${channelId} and k.active))
  )`;
}

export function encodeCursor(txid: string, seq: bigint | string): string {
  return Buffer.from(`${txid}.${seq}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { txid: string; seq: string } {
  if (!cursor) return { txid: '0', seq: '0' };
  const match = /^(\d+)\.(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match) throw new DomainError('VALIDATION_FAILED', { message: 'Invalid cursor' });
  return { txid: match[1]!, seq: match[2]! };
}

/**
 * Events after the cursor in (txid, seq) order, only below the oldest transaction still running
 * (vs.event_horizon), so an event committed late can never fall behind the cursor.
 */
export async function listChannelEvents(
  db: VsDatabase,
  ctx: EngineContext,
  input: { channelId: string; after?: string; limit?: number },
) {
  const cursor = decodeCursor(input.after);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
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
      select e.id, e.type, e.resource, e.resource_id, e.resource_version, e.occurred_at, e.payload, e.txid::text, e.seq
      from vs.event e
      where e.txid < vs.event_horizon()
        and (e.txid, e.seq) > (${cursor.txid}::xid8, ${cursor.seq}::bigint)
        and ${channelEventFilter(input.channelId)}
      order by e.txid, e.seq
      limit ${limit}`.execute(tx);
    const last = rows.at(-1);
    return {
      events: rows.map((r) => toEventView(r)),
      nextCursor: last
        ? encodeCursor(last.txid, last.seq)
        : (input.after ?? encodeCursor('0', '0')),
    };
  });
}

export function toEventView(r: {
  id: string;
  type: string;
  resource: string;
  resource_id: string;
  resource_version: bigint;
  occurred_at: Date;
  payload: Record<string, unknown>;
  txid: string;
  seq: bigint;
}): EventView {
  const { channel_id: _channel, ...data } = r.payload;
  return {
    eventId: r.id,
    type: r.type,
    resource: r.resource,
    resourceId: r.resource_id,
    resourceVersion: r.resource_version,
    occurredAt: r.occurred_at,
    data,
    txid: r.txid,
    seq: r.seq,
  };
}

/** The API/webhook JSON for an event (openapi.yaml § Event): one shape for the feed and webhooks. */
export function eventJson(e: EventView) {
  return {
    event_id: e.eventId,
    type: e.type,
    resource: e.resource,
    resource_id: e.resourceId,
    resource_version: Number(e.resourceVersion),
    occurred_at: e.occurredAt.toISOString(),
    data: e.data,
  };
}
