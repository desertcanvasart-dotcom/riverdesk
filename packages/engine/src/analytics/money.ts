import { sql } from 'kysely';
import { z } from 'zod';
import type { VsDatabase } from '@vs/db';
import { addDays, convert, money, type BusinessDate } from '@vs/shared';
import { cairoToday, parseInput, type EngineContext, type Tx } from '../internal';
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
        ${vessel ? sql`and exists (select from vs.invoice_line l join vs.booking b on b.id = l.booking_id where l.invoice_id = i.id and b.vessel_id = ${vessel})` : sql``}
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

export interface RevenueReport {
  filter: z.infer<typeof revenueReportInput>;
  today: string;
  rows: RevenueRow[];
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
