import { sql } from 'kysely';
import { z } from 'zod';
import type { VsDatabase } from '@vs/db';
import { addDays, convert, money, mulDivHalfUp, type BusinessDate } from '@vs/shared';
import { cairoToday, parseInput, type EngineContext, type Tx } from '../internal';
import { creditExposure, getAgingInTx, type AgingBucket } from '../finance/receivables';
import { loadFinanceSettings } from '../finance/settings';
import { dateSchema } from '../schedule/setup';

/**
 * Analytics A2.1 (docs/analytics-plan.md § 5): cash. Money only (owners and finance), per
 * currency, never added across currencies. Definitions, shown on screen too:
 *
 * - Cash in: receipts by the day they were received, refunds paid out and reversals, per day,
 *   week or month. Against it, what fell due in the same period: issued invoices by due date
 *   (their total less credit notes) and, for bookings the guest pays the ship for and not yet on
 *   an invoice, the balance by its due date.
 * - Forecast: what is still to be paid, by when it falls due — overdue, the next 4 weeks, weeks
 *   5–8, weeks 9–12, later — from open invoices (by due date) and, for guest-paid bookings not on
 *   an invoice, the deposit still missing (due now) and the rest (by the balance due date). Agency
 *   bookings on credit or collected by a platform that are not invoiced yet have no due date: they
 *   are shown as their own column.
 * - Held for future sailings: what guests and agencies have paid on bookings whose sailing has
 *   not embarked yet, by sailing month; and money received from parties not yet on an invoice.
 */

export const cashReportInput = z
  .object({
    from: dateSchema,
    to: dateSchema,
    grain: z.enum(['day', 'week', 'month']).default('week'),
    vesselId: z.uuid().nullish(),
  })
  .refine((v) => v.from <= v.to, { message: 'The start must be before the end' });
export type CashReportFilter = z.input<typeof cashReportInput>;

export interface CashInRow {
  /** The first day of the day, week (Monday) or month. */
  period: string;
  currency: string;
  received: bigint;
  refunded: bigint;
  reversed: bigint;
  net: bigint;
  due: bigint;
}

export interface CashByMethod {
  method: string;
  currency: string;
  receipts: number;
  net: bigint;
}

export const FORECAST_BUCKETS = ['overdue', 'weeks1_4', 'weeks5_8', 'weeks9_12', 'later'] as const;
export type ForecastBucket = (typeof FORECAST_BUCKETS)[number];

export interface ForecastRow {
  currency: string;
  buckets: Record<ForecastBucket, bigint>;
  /** Agency bookings not invoiced yet (no due date until they are). */
  uninvoicedCredit: bigint;
  total: bigint;
}

export interface HeldRow {
  /** The sailing month, YYYY-MM. */
  month: string;
  currency: string;
  bookings: number;
  paid: bigint;
  /** Still to be paid on those bookings (total + fees − paid). */
  outstanding: bigint;
}

export interface CashReport {
  from: string;
  to: string;
  grain: 'day' | 'week' | 'month';
  today: string;
  cashIn: CashInRow[];
  byMethod: CashByMethod[];
  forecast: ForecastRow[];
  held: HeldRow[];
  /** Money received from parties and not yet on an invoice, per currency. */
  unapplied: { currency: string; amount: bigint }[];
}

/** The first day of the period a date falls in. */
const truncate = (grain: string, column: ReturnType<typeof sql>) =>
  grain === 'day' ? sql`${column}::date` : sql`date_trunc(${grain}, ${column}::timestamp)::date`;

async function cashFor(
  tx: Tx,
  data: z.infer<typeof cashReportInput>,
  today: BusinessDate,
): Promise<CashReport> {
  const { from, to, grain } = data;
  const vessel = data.vesselId ?? null;
  // A booking receipt belongs to its booking's vessel; a party receipt to none, so a vessel
  // filter leaves party money out.
  const receiptVessel = vessel
    ? sql`and r.booking_id in (select id from vs.booking where vessel_id = ${vessel})`
    : sql``;
  const { rows: received } = await sql<{
    period: string;
    currency: string;
    received: string;
    refunded: string;
    reversed: string;
    net: string;
  }>`
    select ${truncate(grain, sql`r.received_on`)}::text as period, r.currency,
           coalesce(sum(r.amount) filter (where r.kind = 'receipt'), 0)::text as received,
           coalesce(-sum(r.amount) filter (where r.kind = 'refund'), 0)::text as refunded,
           coalesce(-sum(r.amount) filter (where r.kind = 'reversal'), 0)::text as reversed,
           sum(r.amount)::text as net
    from vs.receipt r
    where r.received_on between ${from}::date and ${to}::date ${receiptVessel}
    group by 1, 2`.execute(tx);
  const { rows: due } = await sql<{ period: string; currency: string; due: string }>`
    select period::text, currency, sum(amount)::text as due from (
      select ${truncate(grain, sql`i.due_date`)} as period, i.currency, i.total - i.amount_credited as amount
      from vs.invoice i
      where i.type = 'invoice' and i.status <> 'draft' and i.due_date between ${from}::date and ${to}::date
        ${
          vessel
            ? sql`and (exists (select from vs.invoice_line l join vs.booking b on b.id = l.booking_id where l.invoice_id = i.id and b.vessel_id = ${vessel})
                            or exists (select from vs.folio f where f.invoice_id = i.id and f.vessel_id = ${vessel}))`
            : sql``
        }
      union all
      select ${truncate(grain, sql`b.balance_due_date`)}, b.currency, b.total + b.fees
      from vs.booking b join vs.channel_contract cc on cc.id = b.contract_id
      where cc.payment_mode = 'vessel_prepaid' and b.status in ('confirmed', 'completed')
        and b.balance_due_date between ${from}::date and ${to}::date
        ${vessel ? sql`and b.vessel_id = ${vessel}` : sql``}
        and not exists (select from vs.invoice_line l join vs.invoice i on i.id = l.invoice_id
                        where l.booking_id = b.id and i.type = 'invoice' and i.status not in ('draft', 'cancelled'))
    ) x group by 1, 2`.execute(tx);
  const cash = new Map<string, CashInRow>();
  const at = (period: string, currency: string) => {
    const key = `${period}|${currency}`;
    let row = cash.get(key);
    if (!row) {
      row = { period, currency, received: 0n, refunded: 0n, reversed: 0n, net: 0n, due: 0n };
      cash.set(key, row);
    }
    return row;
  };
  for (const r of received)
    Object.assign(at(r.period, r.currency), {
      received: BigInt(r.received),
      refunded: BigInt(r.refunded),
      reversed: BigInt(r.reversed),
      net: BigInt(r.net),
    });
  for (const d of due) at(d.period, d.currency).due = BigInt(d.due);
  const cashIn = [...cash.values()].sort(
    (a, b) => a.period.localeCompare(b.period) || a.currency.localeCompare(b.currency),
  );

  const { rows: methods } = await sql<{
    method: string;
    currency: string;
    receipts: number;
    net: string;
  }>`
    select r.method, r.currency, count(*) filter (where r.kind = 'receipt')::int as receipts,
           sum(r.amount)::text as net
    from vs.receipt r
    where r.received_on between ${from}::date and ${to}::date ${receiptVessel}
    group by 1, 2 order by 2, 4 desc`.execute(tx);

  // Forecast: what is still owed, with the date it falls due.
  const { rows: owed } = await sql<{ currency: string; due: string | null; amount: string }>`
    select i.currency, i.due_date::text as due, (i.total - i.amount_credited - i.amount_paid)::text as amount
    from vs.invoice i
    where i.type = 'invoice' and i.status in ('issued', 'partially_paid')
      ${vessel ? sql`and exists (select from vs.invoice_line l join vs.booking b on b.id = l.booking_id where l.invoice_id = i.id and b.vessel_id = ${vessel})` : sql``}
    union all
    -- Guest-paid bookings not invoiced: the missing deposit now, the rest by the balance date.
    select b.currency, ${today}::date::text,
           (least(b.deposit_amount, b.total + b.fees) - b.amount_paid)::text
    from vs.booking b join vs.channel_contract cc on cc.id = b.contract_id
    where cc.payment_mode = 'vessel_prepaid' and b.status in ('held', 'confirmed')
      and b.amount_paid < least(b.deposit_amount, b.total + b.fees) ${vessel ? sql`and b.vessel_id = ${vessel}` : sql``}
      and not exists (select from vs.invoice_line l join vs.invoice i on i.id = l.invoice_id
                      where l.booking_id = b.id and i.type = 'invoice' and i.status not in ('draft', 'cancelled'))
    union all
    select b.currency, coalesce(b.balance_due_date, ${today}::date)::text,
           (b.total + b.fees - greatest(b.amount_paid, least(b.deposit_amount, b.total + b.fees)))::text
    from vs.booking b join vs.channel_contract cc on cc.id = b.contract_id
    where cc.payment_mode = 'vessel_prepaid' and b.status in ('held', 'confirmed')
      and b.total + b.fees > greatest(b.amount_paid, least(b.deposit_amount, b.total + b.fees))
      ${vessel ? sql`and b.vessel_id = ${vessel}` : sql``}
      and not exists (select from vs.invoice_line l join vs.invoice i on i.id = l.invoice_id
                      where l.booking_id = b.id and i.type = 'invoice' and i.status not in ('draft', 'cancelled'))
    union all
    -- Agency bookings not invoiced yet: no due date.
    select b.currency, null, (b.total + b.fees - b.amount_paid)::text
    from vs.booking b join vs.channel_contract cc on cc.id = b.contract_id
    where cc.payment_mode <> 'vessel_prepaid' and b.status = 'confirmed'
      and b.total + b.fees > b.amount_paid ${vessel ? sql`and b.vessel_id = ${vessel}` : sql``}
      and not exists (select from vs.invoice_line l join vs.invoice i on i.id = l.invoice_id
                      where l.booking_id = b.id and i.type = 'invoice' and i.status not in ('draft', 'cancelled'))`.execute(
    tx,
  );
  const forecast = new Map<string, ForecastRow>();
  for (const o of owed) {
    const amount = BigInt(o.amount);
    if (amount <= 0n) continue;
    let row = forecast.get(o.currency);
    if (!row) {
      row = {
        currency: o.currency,
        buckets: { overdue: 0n, weeks1_4: 0n, weeks5_8: 0n, weeks9_12: 0n, later: 0n },
        uninvoicedCredit: 0n,
        total: 0n,
      };
      forecast.set(o.currency, row);
    }
    row.total += amount;
    if (o.due === null) {
      row.uninvoicedCredit += amount;
      continue;
    }
    const bucket: ForecastBucket =
      o.due < today
        ? 'overdue'
        : o.due < addDays(today, 28)
          ? 'weeks1_4'
          : o.due < addDays(today, 56)
            ? 'weeks5_8'
            : o.due < addDays(today, 84)
              ? 'weeks9_12'
              : 'later';
    row.buckets[bucket] += amount;
  }

  const { rows: held } = await sql<{
    month: string;
    currency: string;
    bookings: number;
    paid: string;
    outstanding: string;
  }>`
    select to_char(s.embark_date, 'YYYY-MM') as month, b.currency, count(*)::int as bookings,
           sum(b.amount_paid)::text as paid,
           sum(greatest(b.total + b.fees - b.amount_paid, 0))::text as outstanding
    from vs.booking b join vs.sailing s on s.id = b.sailing_id
    where b.status in ('held', 'confirmed') and s.embark_date > ${today}::date and b.amount_paid > 0
      ${vessel ? sql`and b.vessel_id = ${vessel}` : sql``}
    group by 1, 2 order by 1, 2`.execute(tx);
  const { rows: unapplied } = vessel
    ? { rows: [] }
    : await sql<{ currency: string; amount: string }>`
        select r.currency,
               sum(r.amount - coalesce((select sum(a.amount) from vs.allocation a where a.receipt_id = r.id), 0))::text as amount
        from vs.receipt r where r.booking_id is null
        group by 1
        having sum(r.amount - coalesce((select sum(a.amount) from vs.allocation a where a.receipt_id = r.id), 0)) <> 0
        order by 1`.execute(tx);

  return {
    from,
    to,
    grain,
    today,
    cashIn,
    byMethod: methods.map((m) => ({ ...m, net: BigInt(m.net) })),
    forecast: [...forecast.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    held: held.map((h) => ({ ...h, paid: BigInt(h.paid), outstanding: BigInt(h.outstanding) })),
    unapplied: unapplied.map((u) => ({ currency: u.currency, amount: BigInt(u.amount) })),
  };
}

/** The Cash tab (money only: the caller checks analytics.money). */
export async function cashReport(
  db: VsDatabase,
  ctx: EngineContext,
  input: CashReportFilter,
): Promise<CashReport> {
  const data = parseInput(cashReportInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) =>
    cashFor(tx, data, await cairoToday(tx)),
  );
}

// ---------------------------------------------------------------------------
// A2.2: revenue, leakage, currency exposure and a base-currency view
// ---------------------------------------------------------------------------

/**
 * One set of bookings throughout: those embarking (basis `sailing`) or confirmed (basis `booked`)
 * in the period — confirmed and completed bookings at their total and fees, cancelled ones at
 * the penalty and fees kept.
 *
 * - Booked: that value. Commission: the agency's commission in it (total − net), none on a
 *   cancellation. Net: booked − commission.
 * - Invoiced: their lines on issued invoices less credit notes, before tax, commission lines left
 *   out (the same basis as booked). Not invoiced: booked − invoiced.
 * - Leakage: commission, refunds paid out, penalties kept and amendment fees (money the company
 *   keeps, shown so the totals reconcile), and discounts — credit notes on bookings that were not
 *   cancelled (a cancellation's own credit note is not a discount).
 * - Exposure, as of today and per currency: bookings still to sail (held or confirmed) — their
 *   value, what is paid and what is still due — and open invoices and unapplied money.
 * - Base currency: invoiced amounts at each invoice's own rate; the rest at the latest rate typed
 *   on an issued invoice in that currency, named with its date. A currency with no rate yet is
 *   listed and left out of the base total.
 */
export const revenueReportInput = z
  .object({
    basis: z.enum(['booked', 'sailing']).default('sailing'),
    from: dateSchema,
    to: dateSchema,
    groupBy: z.enum(['vessel', 'channel', 'market']).default('vessel'),
    vesselId: z.uuid().nullish(),
  })
  .refine((v) => v.from <= v.to, { message: 'The start must be before the end' });
export type RevenueReportFilter = z.input<typeof revenueReportInput>;

export interface RevenueRow {
  month: string;
  /** Vessel or channel name, or market code. */
  group: string;
  currency: string;
  bookings: number;
  booked: bigint;
  commission: bigint;
  net: bigint;
  invoiced: bigint;
  uninvoiced: bigint;
}

export interface LeakageRow {
  currency: string;
  commission: bigint;
  refunds: bigint;
  penaltiesKept: bigint;
  amendmentFees: bigint;
  discounts: bigint;
}

export interface ExposureRow {
  currency: string;
  futureBookings: number;
  futureBooked: bigint;
  futurePaid: bigint;
  futureDue: bigint;
  openInvoices: bigint;
  unapplied: bigint;
}

export interface BaseView {
  currency: string;
  booked: bigint;
  invoiced: bigint;
  rates: { currency: string; rate: string; date: string | null; source: 'invoices' | 'latest' }[];
  /** Currencies with amounts but no rate stored yet: left out of the base totals. */
  missing: string[];
}

/**
 * Extras on board (E3), counted with their booking (its sailing or booking month and group):
 * what was charged (voids deducted), what of it is invoiced, and the spend per guest-night of
 * every booking in the group, with or without extras.
 */
export interface ExtrasRow {
  month: string;
  group: string;
  currency: string;
  charged: bigint;
  invoiced: bigint;
  guestNights: number;
  /** charged ÷ guest-nights, in minor units (rounded). */
  perGuestNight: bigint;
}

export interface RevenueReport {
  filter: z.infer<typeof revenueReportInput>;
  today: string;
  rows: RevenueRow[];
  extras: {
    rows: ExtrasRow[];
    byCategory: { currency: string; category: string; amount: bigint }[];
  };
  leakage: LeakageRow[];
  exposure: ExposureRow[];
  base: BaseView;
}

async function revenueFor(
  tx: Tx,
  f: z.infer<typeof revenueReportInput>,
  today: BusinessDate,
): Promise<RevenueReport> {
  const vessel = f.vesselId ?? null;
  const dateOf =
    f.basis === 'sailing'
      ? sql`s.embark_date`
      : sql`(b.confirmed_at at time zone 'Africa/Cairo')::date`;
  const groupOf =
    f.groupBy === 'vessel' ? sql`v.name` : f.groupBy === 'channel' ? sql`ch.name` : sql`b.market`;
  const set = sql`
    select b.id, b.currency, b.status, ${dateOf} as day, ${groupOf} as grp,
           case when b.status = 'cancelled' then coalesce(b.penalty_amount, 0) + b.fees else b.total + b.fees end as booked,
           case when b.status = 'cancelled' then 0 else b.total - b.net_total end as commission,
           case when b.status = 'cancelled' then coalesce(b.penalty_amount, 0) else 0 end as penalty,
           b.fees
    from vs.booking b
    join vs.sailing s on s.id = b.sailing_id
    join vs.vessel v on v.id = b.vessel_id
    join vs.channel ch on ch.id = b.channel_id
    where ${dateOf} between ${f.from}::date and ${f.to}::date
      and (b.status in ('confirmed', 'completed')
           or (b.status = 'cancelled' and coalesce(b.penalty_amount, 0) + b.fees > 0))
      ${vessel ? sql`and b.vessel_id = ${vessel}` : sql``}`;
  // Lines of issued invoices and credit notes on those bookings, commission left out.
  const lines = sql`
    select l.booking_id, i.type, i.currency, i.fx_rate, l.amount
    from vs.invoice_line l join vs.invoice i on i.id = l.invoice_id
    where i.type in ('invoice', 'credit_note') and i.status <> 'draft' and l.kind <> 'commission'
      and l.booking_id in (select id from bset)`;

  const { rows } = await sql<{
    month: string;
    grp: string;
    currency: string;
    bookings: number;
    booked: string;
    commission: string;
    invoiced: string;
  }>`
    with bset as (${set}), lines as (${lines}),
    inv as (select booking_id, sum(case when type = 'invoice' then amount else -amount end) as amount
            from lines group by booking_id)
    select to_char(x.day, 'YYYY-MM') as month, x.grp, x.currency, count(*)::int as bookings,
           sum(x.booked)::text as booked, sum(x.commission)::text as commission,
           coalesce(sum(inv.amount), 0)::text as invoiced
    from bset x left join inv on inv.booking_id = x.id
    group by 1, 2, 3 order by 1, 2, 3`.execute(tx);

  const extrasSet = sql`
    select x.id, x.day, x.grp, f.id as folio_id, f.currency, f.invoice_id
    from bset x join vs.folio f on f.booking_id = x.id`;
  const { rows: extras } = await sql<{
    month: string;
    grp: string;
    currency: string;
    charged: string;
    invoiced: string;
    guest_nights: number;
  }>`
    with bset as (${set}), fx as (${extrasSet}),
    charged as (
      select to_char(fx.day, 'YYYY-MM') as month, fx.grp, fx.currency, sum(c.amount) as amount
      from fx join vs.folio_charge c on c.folio_id = fx.folio_id group by 1, 2, 3),
    invoiced as (
      select to_char(fx.day, 'YYYY-MM') as month, fx.grp, fx.currency,
             sum(case when i.type = 'invoice' then l.amount else -l.amount end) as amount
      from fx join vs.invoice i on i.id = fx.invoice_id or i.credits_invoice_id = fx.invoice_id
      join vs.invoice_line l on l.invoice_id = i.id and l.kind = 'extra'
      where i.status <> 'draft' group by 1, 2, 3),
    nights as (
      select to_char(x.day, 'YYYY-MM') as month, x.grp,
             sum((bc.adults + coalesce(array_length(bc.child_ages, 1), 0)) * s.nights)::int as guest_nights
      from bset x join vs.booking b on b.id = x.id join vs.sailing s on s.id = b.sailing_id
      join vs.booking_cabin bc on bc.booking_id = b.id and bc.status = 'active'
      where x.status <> 'cancelled' group by 1, 2)
    select c.month, c.grp, c.currency, c.amount::text as charged,
           coalesce(i.amount, 0)::text as invoiced, coalesce(n.guest_nights, 0) as guest_nights
    from charged c
    left join invoiced i on i.month = c.month and i.grp = c.grp and i.currency = c.currency
    left join nights n on n.month = c.month and n.grp = c.grp
    order by 1, 2, 3`.execute(tx);
  const { rows: extrasByCategory } = await sql<{
    currency: string;
    category: string;
    amount: string;
  }>`
    with bset as (${set}), fx as (${extrasSet})
    select fx.currency, c.category, sum(c.amount)::text as amount
    from fx join vs.folio_charge c on c.folio_id = fx.folio_id
    group by 1, 2 having sum(c.amount) <> 0 order by 1, 3 desc`.execute(tx);

  const { rows: leak } = await sql<{
    currency: string;
    commission: string;
    refunds: string;
    penalties: string;
    fees: string;
    discounts: string;
  }>`
    with bset as (${set}), lines as (${lines})
    select x.currency,
           sum(x.commission)::text as commission,
           coalesce(sum((select -sum(p.booking_amount) from vs.payment p
                         where p.booking_id = x.id and p.kind = 'refund')), 0)::text as refunds,
           sum(x.penalty)::text as penalties,
           sum(x.fees)::text as fees,
           coalesce(sum((select sum(l.amount) from lines l
                         where l.booking_id = x.id and l.type = 'credit_note')) filter (where x.status <> 'cancelled'), 0)::text as discounts
    from bset x group by 1 order by 1`.execute(tx);

  const { rows: exposure } = await sql<{
    currency: string;
    bookings: number;
    booked: string;
    paid: string;
    open: string;
    unapplied: string;
  }>`
    select currency, sum(bookings)::int as bookings, sum(booked)::text as booked, sum(paid)::text as paid,
           sum(open)::text as open, sum(unapplied)::text as unapplied
    from (
      select b.currency, 1 as bookings, b.total + b.fees as booked, b.amount_paid as paid, 0 as open, 0 as unapplied
      from vs.booking b join vs.sailing s on s.id = b.sailing_id
      where b.status in ('held', 'confirmed') and s.embark_date >= ${today}::date
        ${vessel ? sql`and b.vessel_id = ${vessel}` : sql``}
      union all
      select i.currency, 0, 0, 0, i.total - i.amount_credited - i.amount_paid, 0
      from vs.invoice i
      where i.type = 'invoice' and i.status in ('issued', 'partially_paid')
        ${vessel ? sql`and exists (select from vs.invoice_line l join vs.booking b on b.id = l.booking_id where l.invoice_id = i.id and b.vessel_id = ${vessel})` : sql``}
      union all
      select r.currency, 0, 0, 0, 0,
             r.amount - coalesce((select sum(a.amount) from vs.allocation a where a.receipt_id = r.id), 0)
      from vs.receipt r where r.booking_id is null ${vessel ? sql`and false` : sql``}
    ) x group by 1 order by 1`.execute(tx);

  // Base currency: invoiced at each invoice's rate, the rest at the latest rate in that currency.
  const base = (await loadFinanceSettings(tx)).base_currency;
  const { rows: invoicedByRate } = await sql<{
    currency: string;
    fx_rate: string | null;
    amount: string;
  }>`
    with bset as (${set}), lines as (${lines})
    select currency, fx_rate, sum(case when type = 'invoice' then amount else -amount end)::text as amount
    from lines group by 1, 2`.execute(tx);
  const { rows: latest } = await sql<{ currency: string; fx_rate: string; fx_date: string | null }>`
    select distinct on (currency) currency, fx_rate, fx_date::text
    from vs.invoice where fx_rate is not null and status <> 'draft'
    order by currency, issued_at desc`.execute(tx);
  const latestOf = new Map(latest.map((l) => [l.currency, l]));
  const toBase = (amount: bigint, currency: string, rate: string | null) =>
    currency === base ? amount : rate ? convert(money(amount, currency), rate, base).amount : null;

  const result: RevenueRow[] = rows.map((r) => {
    const booked = BigInt(r.booked);
    const commission = BigInt(r.commission);
    const invoiced = BigInt(r.invoiced);
    return {
      month: r.month,
      group: r.grp,
      currency: r.currency,
      bookings: r.bookings,
      booked,
      commission,
      net: booked - commission,
      invoiced,
      uninvoiced: booked - invoiced,
    };
  });

  const missing = new Set<string>();
  const used = new Map<string, BaseView['rates'][number]>();
  let baseInvoiced = 0n;
  const invoiceRates = new Map<string, string[]>();
  for (const x of invoicedByRate) {
    const amount = BigInt(x.amount);
    if (amount === 0n) continue;
    const converted = toBase(amount, x.currency, x.fx_rate);
    if (converted === null) {
      missing.add(x.currency);
      continue;
    }
    baseInvoiced += converted;
    if (x.currency !== base && x.fx_rate)
      invoiceRates.set(x.currency, [...(invoiceRates.get(x.currency) ?? []), x.fx_rate]);
  }
  // Invoiced amounts are at each invoice's own rate: shown as the range used.
  for (const [currency, list] of invoiceRates) {
    const sorted = [...new Set(list)].sort((a, b) => Number(a) - Number(b));
    used.set(`inv|${currency}`, {
      currency,
      rate: sorted.length > 1 ? `${sorted[0]}–${sorted.at(-1)}` : sorted[0]!,
      date: null,
      source: 'invoices',
    });
  }
  let baseUninvoiced = 0n;
  const perCurrency = new Map<string, bigint>();
  for (const r of result)
    perCurrency.set(r.currency, (perCurrency.get(r.currency) ?? 0n) + r.uninvoiced);
  for (const [currency, amount] of perCurrency) {
    if (amount === 0n) continue;
    const rate = latestOf.get(currency);
    const converted = toBase(amount, currency, rate?.fx_rate ?? null);
    if (converted === null) {
      missing.add(currency);
      continue;
    }
    baseUninvoiced += converted;
    if (currency !== base)
      used.set(`latest|${currency}`, {
        currency,
        rate: rate!.fx_rate,
        date: rate!.fx_date,
        source: 'latest',
      });
  }

  return {
    filter: f,
    today,
    rows: result,
    extras: {
      rows: extras.map((x) => {
        const charged = BigInt(x.charged);
        return {
          month: x.month,
          group: x.grp,
          currency: x.currency,
          charged,
          invoiced: BigInt(x.invoiced),
          guestNights: x.guest_nights,
          perGuestNight: x.guest_nights ? mulDivHalfUp(charged, 1n, BigInt(x.guest_nights)) : 0n,
        };
      }),
      byCategory: extrasByCategory.map((x) => ({
        currency: x.currency,
        category: x.category,
        amount: BigInt(x.amount),
      })),
    },
    leakage: leak.map((l) => ({
      currency: l.currency,
      commission: BigInt(l.commission),
      refunds: BigInt(l.refunds),
      penaltiesKept: BigInt(l.penalties),
      amendmentFees: BigInt(l.fees),
      discounts: BigInt(l.discounts),
    })),
    exposure: exposure.map((e) => ({
      currency: e.currency,
      futureBookings: e.bookings,
      futureBooked: BigInt(e.booked),
      futurePaid: BigInt(e.paid),
      futureDue: BigInt(e.booked) - BigInt(e.paid),
      openInvoices: BigInt(e.open),
      unapplied: BigInt(e.unapplied),
    })),
    base: {
      currency: base,
      booked: baseInvoiced + baseUninvoiced,
      invoiced: baseInvoiced,
      rates: [...used.values()],
      missing: [...missing].sort(),
    },
  };
}

/** The Revenue tab (money only: the caller checks analytics.money). */
export async function revenueReport(
  db: VsDatabase,
  ctx: EngineContext,
  input: RevenueReportFilter,
): Promise<RevenueReport> {
  const data = parseInput(revenueReportInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) =>
    revenueFor(tx, data, await cairoToday(tx)),
  );
}

// ---------------------------------------------------------------------------
// A2.3: receivables by party — aging, how fast they pay, credit used
// ---------------------------------------------------------------------------

/**
 * - Aging: open invoice balances by days past due, as of today (the same as Invoices →
 *   Receivables), with money received not yet on an invoice.
 * - Days to pay, over the last 12 months: for money put on an invoice, the days from the
 *   invoice's issue date to the day the money was received (0 when it came first, as a deposit),
 *   averaged by amount; and the share of that money received by the due date.
 * - Credit: each agency with a credit limit — what it owes on credit against the limit.
 */
export const receivablesReportInput = z.object({
  /** Days back for days-to-pay (default a year). */
  days: z.number().int().min(30).max(1095).default(365),
});
export type ReceivablesReportFilter = z.input<typeof receivablesReportInput>;

export interface ReceivablesRow {
  partyId: string;
  party: string;
  kind: string;
  currency: string;
  buckets: Record<AgingBucket, bigint>;
  open: bigint;
  overdue: bigint;
  unapplied: bigint;
  /** Amount-weighted days from issue to payment; null with no payments in the window. */
  averageDaysToPay: number | null;
  /** Share of the money paid in the window that arrived by the due date. */
  paidOnTimeShare: number | null;
  paidInWindow: bigint;
}

export interface CreditRow {
  channelId: string;
  channel: string;
  currency: string | null;
  limit: bigint | null;
  uninvoiced: bigint;
  openInvoices: bigint;
  unappliedCredit: bigint;
  exposure: bigint;
  remaining: bigint | null;
  /** exposure ÷ limit. */
  usedShare: number | null;
}

export interface ReceivablesReport {
  today: string;
  since: string;
  rows: ReceivablesRow[];
  credit: CreditRow[];
}

async function receivablesFor(
  tx: Tx,
  data: z.infer<typeof receivablesReportInput>,
  today: BusinessDate,
): Promise<ReceivablesReport> {
  const since = addDays(today, -data.days);
  const aging = await getAgingInTx(tx, today);
  const { rows: speed } = await sql<{
    party_id: string;
    party: string;
    kind: string;
    currency: string;
    weighted: string;
    amount: string;
    on_time: string;
  }>`
    select p.id as party_id, p.name as party, p.kind, i.currency,
           sum(a.invoice_amount * greatest(r.received_on - i.issue_date, 0))::text as weighted,
           sum(a.invoice_amount)::text as amount,
           coalesce(sum(a.invoice_amount) filter (where r.received_on <= i.due_date), 0)::text as on_time
    from vs.allocation a
    join vs.invoice i on i.id = a.invoice_id
    join vs.receipt r on r.id = a.receipt_id
    join vs.billing_party p on p.id = i.billing_party_id
    where a.invoice_amount > 0 and r.kind = 'receipt' and r.received_on >= ${since}::date
      and not exists (select from vs.receipt x where x.reverses_receipt_id = r.id)
      -- Money later taken back off this invoice does not count as paying it.
      and not exists (select from vs.allocation u
                      where u.receipt_id = a.receipt_id and u.invoice_id = a.invoice_id
                        and u.booking_id is not distinct from a.booking_id and u.invoice_amount < 0)
    group by 1, 2, 3, 4`.execute(tx);

  const rows = new Map<string, ReceivablesRow>();
  const row = (partyId: string, party: string, kind: string, currency: string) => {
    const key = `${partyId}|${currency}`;
    let x = rows.get(key);
    if (!x) {
      x = {
        partyId,
        party,
        kind,
        currency,
        buckets: { current: 0n, d1_30: 0n, d31_60: 0n, d61_90: 0n, d90_plus: 0n },
        open: 0n,
        overdue: 0n,
        unapplied: 0n,
        averageDaysToPay: null,
        paidOnTimeShare: null,
        paidInWindow: 0n,
      };
      rows.set(key, x);
    }
    return x;
  };
  for (const a of aging.rows) {
    const x = row(a.partyId, a.partyName, a.partyKind, a.currency);
    x.buckets = { ...a.buckets };
    x.open = a.total;
    x.overdue = a.total - a.buckets.current;
    x.unapplied = a.unappliedCredit;
  }
  for (const s of speed) {
    const amount = BigInt(s.amount);
    if (amount <= 0n) continue;
    const x = row(s.party_id, s.party, s.kind, s.currency);
    x.paidInWindow = amount;
    // Days: an average to one decimal; the share to three. Money stays integer above.
    x.averageDaysToPay = Number((BigInt(s.weighted) * 10n) / amount) / 10;
    x.paidOnTimeShare = Number((BigInt(s.on_time) * 1000n) / amount) / 1000;
  }

  const channels = await tx
    .selectFrom('channel')
    .select(['id', 'name'])
    .where('credit_allowed', '=', true)
    .where('credit_limit', 'is not', null)
    .orderBy('name')
    .execute();
  const credit: CreditRow[] = [];
  for (const ch of channels) {
    const e = await creditExposure(tx, ch.id);
    credit.push({
      channelId: ch.id,
      channel: ch.name,
      currency: e.currency,
      limit: e.limit,
      uninvoiced: e.uninvoiced,
      openInvoices: e.openInvoices,
      unappliedCredit: e.unappliedCredit,
      exposure: e.exposure,
      remaining: e.remaining,
      usedShare: e.limit && e.limit > 0n ? Number((e.exposure * 1000n) / e.limit) / 1000 : null,
    });
  }
  credit.sort((a, b) => (b.usedShare ?? -1) - (a.usedShare ?? -1));

  return {
    today,
    since,
    rows: [...rows.values()].sort(
      (a, b) =>
        a.currency.localeCompare(b.currency) ||
        (b.overdue > a.overdue ? 1 : b.overdue < a.overdue ? -1 : 0) ||
        (b.open > a.open ? 1 : b.open < a.open ? -1 : 0) ||
        a.party.localeCompare(b.party),
    ),
    credit,
  };
}

/** The Receivables tab (money only: the caller checks analytics.money). */
export async function receivablesReport(
  db: VsDatabase,
  ctx: EngineContext,
  input: ReceivablesReportFilter = {},
): Promise<ReceivablesReport> {
  const data = parseInput(receivablesReportInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) =>
    receivablesFor(tx, data, await cairoToday(tx)),
  );
}
