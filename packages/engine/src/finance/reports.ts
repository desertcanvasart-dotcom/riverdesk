import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { convert, currencySchema, money } from '@vs/shared';
import { audit } from '../audit';
import { parseInput, type EngineContext, type Tx } from '../internal';
import { dateSchema } from '../schedule/setup';
import { invoiceRegisterData } from './documents';
import { getAgingInTx } from './receivables';

/**
 * Finance reports and the accountant's exports (invoicing F5, docs/invoicing-plan.md § 3.6 and
 * § 4). Each is a plain table: the screens show it, the worker writes it as Excel or CSV. The
 * dashboards are analytics A2; these stay simple lists.
 *
 * Money columns are integer minor units in the row's `currency`. Amounts before tax are the line
 * amounts less any tax included in them.
 */

export type ColumnType = 'text' | 'date' | 'money' | 'number';
export interface FinanceColumn {
  /** Also the wording key in the documents package: `fr_<key>`. */
  key: string;
  type: ColumnType;
}
export type FinanceCell = string | number | bigint | null;
export interface FinanceTable {
  /** The wording key of the title: `fr_title_<name>`. */
  name: string;
  from: string | null;
  to: string | null;
  columns: FinanceColumn[];
  rows: Record<string, FinanceCell>[];
  /** Account codes the journal needed and the company has not set (journal only). */
  unmapped?: { kind: string; ref: string | null }[];
}

const col = (key: string, type: ColumnType = 'text'): FinanceColumn => ({ key, type });

export const FINANCE_REPORTS = ['revenue', 'production', 'collections', 'outstanding'] as const;
export const ACCOUNTANT_EXPORTS = ['invoices', 'payments', 'journal'] as const;

const reportShape = {
  report: z.enum(FINANCE_REPORTS),
  /** Revenue: invoice dates; production: embarkation dates; collections: dates received. */
  from: dateSchema,
  to: dateSchema,
  vesselId: z.uuid().optional(),
  channelId: z.uuid().optional(),
  currency: currencySchema.optional(),
};
const ordered = { message: 'The start must be before the end' };
export const financeReportInput = z.object(reportShape).refine((v) => v.from <= v.to, ordered);
export type FinanceReportParams = z.infer<typeof financeReportInput>;

const NET = sql`case when l.tax_inclusive then l.amount - l.tax_amount else l.amount end`;

/**
 * Revenue is the cabins, fees and penalties invoiced, before tax and gross of agency commission;
 * the commission deducted on agency invoices is its own column (the journal posts it apart).
 */
async function revenue(tx: Tx, p: FinanceReportParams): Promise<FinanceTable> {
  const { rows } = await sql<Record<string, FinanceCell>>`
    select to_char(i.issue_date, 'YYYY-MM') as month, v.name as vessel, s.embark_date::text as embark,
           ch.name as channel, i.currency,
           sum(case when i.type = 'invoice' and l.kind <> 'commission' then ${NET} else 0 end)::bigint as invoiced,
           sum(case when i.type = 'credit_note' and l.kind <> 'commission' then ${NET} else 0 end)::bigint as credited,
           sum(case when l.kind <> 'commission' then
                 case when i.type = 'invoice' then ${NET} else -(${NET}) end else 0 end)::bigint as net,
           -sum(case when l.kind = 'commission' then
                 case when i.type = 'invoice' then ${NET} else -(${NET}) end else 0 end)::bigint as commission,
           sum(case when i.type = 'invoice' then l.tax_amount else -l.tax_amount end)::bigint as tax
    from vs.invoice_line l
    join vs.invoice i on i.id = l.invoice_id
    left join vs.booking b on b.id = l.booking_id
    left join vs.vessel v on v.id = b.vessel_id
    left join vs.sailing s on s.id = b.sailing_id
    left join vs.channel ch on ch.id = b.channel_id
    where i.type in ('invoice', 'credit_note') and i.status <> 'draft'
      and i.issue_date between ${p.from}::date and ${p.to}::date
      ${p.vesselId ? sql`and b.vessel_id = ${p.vesselId}` : sql``}
      ${p.channelId ? sql`and b.channel_id = ${p.channelId}` : sql``}
      ${p.currency ? sql`and i.currency = ${p.currency}` : sql``}
    group by 1, 2, 3, 4, 5
    order by 1, 2 nulls last, 3 nulls last, 4 nulls last, 5`.execute(tx);
  return {
    name: 'revenue',
    from: p.from,
    to: p.to,
    columns: [
      col('month'),
      col('vessel'),
      col('embark', 'date'),
      col('channel'),
      col('currency'),
      col('invoiced', 'money'),
      col('credited', 'money'),
      col('net', 'money'),
      col('commission', 'money'),
      col('tax', 'money'),
    ],
    rows,
  };
}

async function production(tx: Tx, p: FinanceReportParams): Promise<FinanceTable> {
  // Booked value: confirmed and completed bookings' total and fees; a cancelled one's penalty and
  // fees. Invoiced: their lines on issued invoices less credit notes, commission left out.
  const { rows } = await sql<Record<string, FinanceCell>>`
    with booked as (
      select b.id, b.vessel_id, b.sailing_id, b.channel_id, b.currency,
             case when b.status = 'cancelled' then coalesce(b.penalty_amount, 0) + b.fees
                  else b.total + b.fees end as value
      from vs.booking b
      join vs.sailing s on s.id = b.sailing_id
      where s.embark_date between ${p.from}::date and ${p.to}::date
        and (b.status in ('confirmed', 'completed')
             or (b.status = 'cancelled' and coalesce(b.penalty_amount, 0) + b.fees > 0))
        ${p.vesselId ? sql`and b.vessel_id = ${p.vesselId}` : sql``}
        ${p.channelId ? sql`and b.channel_id = ${p.channelId}` : sql``}
        ${p.currency ? sql`and b.currency = ${p.currency}` : sql``}
    ), invoiced as (
      select l.booking_id, sum(case when i.type = 'invoice' then l.amount else -l.amount end) as amount
      from vs.invoice_line l join vs.invoice i on i.id = l.invoice_id
      where l.booking_id in (select id from booked) and l.kind <> 'commission'
        and i.type in ('invoice', 'credit_note') and i.status <> 'draft'
      group by l.booking_id
    )
    select v.name as vessel, s.embark_date::text as embark, ch.name as channel, x.currency,
           count(*)::int as bookings, sum(x.value)::bigint as booked,
           coalesce(sum(inv.amount), 0)::bigint as invoiced,
           (sum(x.value) - coalesce(sum(inv.amount), 0))::bigint as uninvoiced
    from booked x
    join vs.vessel v on v.id = x.vessel_id
    join vs.sailing s on s.id = x.sailing_id
    join vs.channel ch on ch.id = x.channel_id
    left join invoiced inv on inv.booking_id = x.id
    group by 1, 2, 3, 4
    order by 2, 1, 3, 4`.execute(tx);
  return {
    name: 'production',
    from: p.from,
    to: p.to,
    columns: [
      col('vessel'),
      col('embark', 'date'),
      col('channel'),
      col('currency'),
      col('bookings', 'number'),
      col('booked', 'money'),
      col('invoiced', 'money'),
      col('uninvoiced', 'money'),
    ],
    rows,
  };
}

async function collections(tx: Tx, p: FinanceReportParams): Promise<FinanceTable> {
  const { rows } = await sql<Record<string, FinanceCell>>`
    select to_char(r.received_on, 'YYYY-MM') as month, r.method, r.currency,
           count(*) filter (where r.kind = 'receipt')::int as receipts,
           coalesce(sum(r.amount) filter (where r.kind = 'receipt'), 0)::bigint as received,
           coalesce(-sum(r.amount) filter (where r.kind = 'refund'), 0)::bigint as refunded,
           coalesce(-sum(r.amount) filter (where r.kind = 'reversal'), 0)::bigint as reversed,
           sum(r.amount)::bigint as net
    from vs.receipt r
    where r.received_on between ${p.from}::date and ${p.to}::date
      ${p.currency ? sql`and r.currency = ${p.currency}` : sql``}
      ${p.channelId ? sql`and r.billing_party_id in (select id from vs.billing_party where channel_id = ${p.channelId})` : sql``}
    group by 1, 2, 3
    order by 1, 3, 2`.execute(tx);
  return {
    name: 'collections',
    from: p.from,
    to: p.to,
    columns: [
      col('month'),
      col('method'),
      col('currency'),
      col('receipts', 'number'),
      col('received', 'money'),
      col('refunded', 'money'),
      col('reversed', 'money'),
      col('net', 'money'),
    ],
    rows,
  };
}

async function outstanding(tx: Tx, p: FinanceReportParams): Promise<FinanceTable> {
  // As of the end of the period: the aging, one row per party and currency.
  const aging = await getAgingInTx(tx, p.to);
  const rows = aging.rows
    .filter((r) => !p.currency || r.currency === p.currency)
    .map((r) => ({
      party: r.partyName,
      party_kind: r.partyKind,
      currency: r.currency,
      invoices: r.invoices,
      open: r.total,
      overdue: r.total - r.buckets.current,
      unapplied: r.unappliedCredit,
      net: r.net,
    }));
  return {
    name: 'outstanding',
    from: null,
    to: p.to,
    columns: [
      col('party'),
      col('party_kind'),
      col('currency'),
      col('invoices', 'number'),
      col('open', 'money'),
      col('overdue', 'money'),
      col('unapplied', 'money'),
      col('net', 'money'),
    ],
    rows,
  };
}

async function reportTable(tx: Tx, p: FinanceReportParams): Promise<FinanceTable> {
  switch (p.report) {
    case 'revenue':
      return revenue(tx, p);
    case 'production':
      return production(tx, p);
    case 'collections':
      return collections(tx, p);
    case 'outstanding':
      return outstanding(tx, p);
  }
}

/** A finance report on screen. */
export async function getFinanceReport(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof financeReportInput>,
) {
  const data = parseInput(financeReportInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) => reportTable(tx, data));
}

// ---------------------------------------------------------------------------
// Account codes
// ---------------------------------------------------------------------------

export const ACCOUNT_KINDS = [
  'receivables',
  'cash',
  'bank',
  'commission',
  'tax_payable',
  'revenue_vessel',
  'revenue_channel',
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
const TAKES_REF: readonly AccountKind[] = ['revenue_vessel', 'revenue_channel', 'tax_payable'];

/** The codes set, and what can have one: the company's vessels, agency channels and taxes. */
export async function listAccountMappings(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const codes = await tx
      .selectFrom('account_mapping')
      .select(['kind', 'ref_id', 'code'])
      .orderBy('kind')
      .execute();
    const vessels = await tx.selectFrom('vessel').select(['id', 'name']).orderBy('name').execute();
    const channels = await tx
      .selectFrom('channel')
      .select(['id', 'name', 'type'])
      .orderBy('name')
      .execute();
    const taxes = await tx
      .selectFrom('tax_rate')
      .select(['id', 'name_en as name', 'name_ar', 'rate_bps'])
      .orderBy('sort_order')
      .execute();
    return { codes, vessels, channels, taxes };
  });
}

export const saveAccountMappingInput = z.object({
  kind: z.enum(ACCOUNT_KINDS),
  refId: z.uuid().nullable().default(null),
  /** Empty or null removes it. */
  code: z
    .string()
    .trim()
    .max(30)
    .nullable()
    .transform((v) => v || null),
});

export async function saveAccountMapping(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof saveAccountMappingInput>,
) {
  const data = parseInput(saveAccountMappingInput, input);
  if (data.refId && !TAKES_REF.includes(data.kind))
    throw new DomainError('VALIDATION_FAILED', {
      message: `${data.kind} has one code for the company`,
    });
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    if (data.refId) {
      const table =
        data.kind === 'revenue_vessel'
          ? 'vessel'
          : data.kind === 'revenue_channel'
            ? 'channel'
            : 'tax_rate';
      const found = await tx
        .selectFrom(table)
        .select('id')
        .where('id', '=', data.refId)
        .executeTakeFirst();
      if (!found) throw new DomainError('NOT_FOUND', { message: 'Not found' });
    }
    const before = await tx
      .selectFrom('account_mapping')
      .select(['id', 'code'])
      .where('kind', '=', data.kind)
      .where((eb) => (data.refId ? eb('ref_id', '=', data.refId) : eb('ref_id', 'is', null)))
      .executeTakeFirst();
    if (!data.code) {
      if (before) await tx.deleteFrom('account_mapping').where('id', '=', before.id).execute();
    } else if (before) {
      await tx
        .updateTable('account_mapping')
        .set({ code: data.code })
        .where('id', '=', before.id)
        .execute();
    } else {
      await tx
        .insertInto('account_mapping')
        .values({
          operator_id: ctx.operatorId,
          kind: data.kind,
          ref_id: data.refId,
          code: data.code,
        })
        .execute();
    }
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'account_mapping.saved',
      entity: 'account_mapping',
      entityId: before?.id ?? null,
      before: { kind: data.kind, ref_id: data.refId, code: before?.code ?? null },
      after: { kind: data.kind, ref_id: data.refId, code: data.code },
    });
    return { kind: data.kind, refId: data.refId, code: data.code };
  });
}

// ---------------------------------------------------------------------------
// Accountant exports
// ---------------------------------------------------------------------------

const exportShape = { content: z.enum(ACCOUNTANT_EXPORTS), from: dateSchema, to: dateSchema };
export const accountantExportInput = z.object(exportShape).refine((v) => v.from <= v.to, ordered);
export type AccountantExportParams = z.infer<typeof accountantExportInput>;

async function invoicesExport(
  db: VsDatabase,
  ctx: EngineContext,
  p: AccountantExportParams,
): Promise<FinanceTable> {
  const rows = await invoiceRegisterData(db, ctx, { from: p.from, to: p.to });
  return {
    name: 'invoices',
    from: p.from,
    to: p.to,
    columns: [
      col('number'),
      col('type'),
      col('issue_date', 'date'),
      col('due_date', 'date'),
      col('party'),
      col('party_tax_no'),
      col('credits'),
      col('bookings'),
      col('currency'),
      col('subtotal', 'money'),
      col('tax', 'money'),
      col('total', 'money'),
      col('fx_rate'),
      col('base_currency'),
      col('base_total', 'money'),
    ],
    rows: rows.map((r) => {
      const sign = r.type === 'credit_note' ? -1n : 1n;
      return {
        number: r.number,
        type: r.type,
        issue_date: r.issueDate,
        due_date: r.dueDate,
        party: r.party,
        party_tax_no: r.partyTaxNo,
        credits: r.credits,
        bookings: r.bookingRefs.join(' '),
        currency: r.currency,
        subtotal: sign * r.subtotal,
        tax: sign * r.taxTotal,
        total: sign * r.total,
        fx_rate: r.fxRate,
        base_currency: r.baseCurrency,
        base_total: sign * r.baseTotal,
      };
    }),
  };
}

async function paymentsExport(tx: Tx, p: AccountantExportParams): Promise<FinanceTable> {
  const { rows } = await sql<Record<string, FinanceCell>>`
    select r.received_on::text as date, r.kind as type, r.method, r.reference, p.name as party,
           b.ref as bookings, r.currency, r.amount,
           (select string_agg(distinct i.number, ' ') from vs.allocation a join vs.invoice i on i.id = a.invoice_id
            where a.receipt_id = r.id) as invoices
    from vs.receipt r
    join vs.billing_party p on p.id = r.billing_party_id
    left join vs.booking b on b.id = r.booking_id
    where r.received_on between ${p.from}::date and ${p.to}::date
    order by r.received_on, r.created_at`.execute(tx);
  return {
    name: 'payments',
    from: p.from,
    to: p.to,
    columns: [
      col('date', 'date'),
      col('type'),
      col('method'),
      col('reference'),
      col('party'),
      col('bookings'),
      col('invoices'),
      col('currency'),
      col('amount', 'money'),
    ],
    rows,
  };
}

interface JournalLine {
  date: string;
  document: string;
  account: AccountKind;
  /** Vessel, channel or tax the account is for. */
  ref: string | null;
  code: string | null;
  description: string;
  currency: string;
  debit: bigint;
  credit: bigint;
  base_currency: string;
  base_debit: bigint | null;
  base_credit: bigint | null;
}

/**
 * The journal for the period: each invoice debits receivables with its total and credits revenue
 * (before tax, per line) and tax payable (per tax); a commission line debits commission; a credit
 * note reverses the same; money received debits cash (cash) or bank (anything else) and credits
 * receivables, money paid out the reverse. Revenue takes the vessel's code, else the channel's,
 * else the default. Entries carry the base-currency amount at the invoice's rate; money in
 * another currency than the base has none (it has no rate of its own).
 */
async function journalExport(tx: Tx, p: AccountantExportParams): Promise<FinanceTable> {
  const codes = await tx.selectFrom('account_mapping').select(['kind', 'ref_id', 'code']).execute();
  const codeOf = (kind: AccountKind, ref: string | null) =>
    codes.find((c) => c.kind === kind && c.ref_id === ref)?.code ?? null;
  const base =
    (await tx.selectFrom('finance_setting').select('base_currency').executeTakeFirst())
      ?.base_currency ?? 'EGP';
  const unmapped = new Map<string, { kind: string; ref: string | null }>();
  const lines: JournalLine[] = [];
  const push = (
    entry: Omit<JournalLine, 'code' | 'base_currency' | 'base_debit' | 'base_credit'> & {
      refId?: string | null;
      fallbacks?: [AccountKind, string | null][];
      rate: string | null;
    },
  ) => {
    if (entry.debit === 0n && entry.credit === 0n) return;
    const tries: [AccountKind, string | null][] = [
      [entry.account, entry.refId ?? null],
      ...(entry.fallbacks ?? []),
      [entry.account, null],
    ];
    let code: string | null = null;
    for (const [kind, ref] of tries) code ??= codeOf(kind, ref);
    if (!code)
      unmapped.set(`${entry.account}|${entry.ref}`, { kind: entry.account, ref: entry.ref });
    const toBase = (amount: bigint) =>
      entry.currency === base
        ? amount
        : entry.rate
          ? convert(money(amount, entry.currency), entry.rate, base).amount
          : null;
    lines.push({
      date: entry.date,
      document: entry.document,
      account: entry.account,
      ref: entry.ref,
      code,
      description: entry.description,
      currency: entry.currency,
      debit: entry.debit,
      credit: entry.credit,
      base_currency: base,
      base_debit: entry.debit ? toBase(entry.debit) : null,
      base_credit: entry.credit ? toBase(entry.credit) : null,
    });
  };
  // Positive goes on the debit side, negative on the credit side (as a positive amount).
  const side = (amount: bigint) =>
    amount >= 0n ? { debit: amount, credit: 0n } : { debit: 0n, credit: -amount };

  const invoices = await tx
    .selectFrom('invoice as i')
    .innerJoin('billing_party as p', 'p.id', 'i.billing_party_id')
    .select([
      'i.id',
      'i.type',
      'i.number',
      'i.issue_date',
      'i.currency',
      'i.total',
      'i.fx_rate',
      'p.name as party',
    ])
    .where('i.type', 'in', ['invoice', 'credit_note'])
    .where('i.status', '<>', 'draft')
    .where('i.issue_date', '>=', p.from)
    .where('i.issue_date', '<=', p.to)
    .orderBy('i.issue_date')
    .orderBy('i.series')
    .orderBy('i.seq')
    .execute();
  for (const inv of invoices) {
    const sign = inv.type === 'credit_note' ? -1n : 1n;
    const common = {
      date: inv.issue_date!,
      document: inv.number!,
      currency: inv.currency,
      rate: inv.fx_rate,
    };
    push({
      ...common,
      account: 'receivables',
      ref: null,
      description: inv.party,
      ...side(sign * inv.total),
    });
    const { rows: lineRows } = await sql<{
      kind: string;
      net: string;
      tax: string;
      tax_rate_id: string | null;
      tax_name: string | null;
      vessel_id: string | null;
      vessel: string | null;
      channel_id: string | null;
      channel: string | null;
    }>`
      select l.kind, (${NET})::text as net, l.tax_amount::text as tax, l.tax_rate_id, l.tax_name_en as tax_name,
             b.vessel_id, v.name as vessel, b.channel_id, ch.name as channel
      from vs.invoice_line l
      left join vs.booking b on b.id = l.booking_id
      left join vs.vessel v on v.id = b.vessel_id
      left join vs.channel ch on ch.id = b.channel_id
      where l.invoice_id = ${inv.id} order by l.seq`.execute(tx);
    // Revenue and commission, grouped by account; tax by rate.
    const groups = new Map<string, Parameters<typeof push>[0]>();
    const add = (key: string, make: () => Parameters<typeof push>[0], amount: bigint) => {
      const g = groups.get(key) ?? make();
      const net = g.credit - g.debit + amount;
      groups.set(key, {
        ...g,
        ...(net >= 0n ? { debit: 0n, credit: net } : { debit: -net, credit: 0n }),
      });
    };
    for (const l of lineRows) {
      const net = sign * BigInt(l.net);
      if (l.kind === 'commission')
        add(
          'commission',
          () => ({
            ...common,
            account: 'commission',
            ref: null,
            description: inv.party,
            debit: 0n,
            credit: 0n,
          }),
          net,
        );
      else
        add(
          `rev|${l.vessel_id}|${l.channel_id}`,
          () => ({
            ...common,
            account: 'revenue_vessel',
            ref: l.vessel ?? null,
            refId: l.vessel_id,
            fallbacks: l.channel_id ? [['revenue_channel', l.channel_id]] : [],
            description: [l.vessel, l.channel].filter(Boolean).join(' · ') || inv.party,
            debit: 0n,
            credit: 0n,
          }),
          net,
        );
      const tax = sign * BigInt(l.tax);
      if (tax !== 0n)
        add(
          `tax|${l.tax_rate_id}`,
          () => ({
            ...common,
            account: 'tax_payable',
            ref: l.tax_name,
            refId: l.tax_rate_id,
            description: l.tax_name ?? '',
            debit: 0n,
            credit: 0n,
          }),
          tax,
        );
    }
    for (const g of groups.values()) push(g);
  }

  const receipts = await tx
    .selectFrom('receipt as r')
    .innerJoin('billing_party as p', 'p.id', 'r.billing_party_id')
    .select([
      'r.received_on',
      'r.reference',
      'r.method',
      'r.currency',
      'r.amount',
      'p.name as party',
    ])
    .where('r.received_on', '>=', p.from)
    .where('r.received_on', '<=', p.to)
    .orderBy('r.received_on')
    .orderBy('r.created_at')
    .execute();
  for (const r of receipts) {
    const common = { date: r.received_on, document: r.reference, currency: r.currency, rate: null };
    push({
      ...common,
      account: r.method === 'cash' ? 'cash' : 'bank',
      ref: null,
      description: r.party,
      ...side(r.amount),
    });
    push({
      ...common,
      account: 'receivables',
      ref: null,
      description: r.party,
      ...side(-r.amount),
    });
  }

  return {
    name: 'journal',
    from: p.from,
    to: p.to,
    columns: [
      col('date', 'date'),
      col('document'),
      col('account'),
      col('ref'),
      col('code'),
      col('description'),
      col('currency'),
      col('debit', 'money'),
      col('credit', 'money'),
      col('base_currency'),
      col('base_debit', 'money'),
      col('base_credit', 'money'),
    ],
    rows: lines as unknown as Record<string, FinanceCell>[],
    unmapped: [...unmapped.values()],
  };
}

/** The register opens its own transaction; payments and the journal run in the caller's. */
async function exportTable(
  db: VsDatabase,
  ctx: EngineContext,
  p: AccountantExportParams,
): Promise<FinanceTable> {
  if (p.content === 'invoices') return invoicesExport(db, ctx, p);
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    p.content === 'payments' ? paymentsExport(tx, p) : journalExport(tx, p),
  );
}

/** An export on screen (a preview, and the journal's codes still to set). */
export async function getAccountantExport(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof accountantExportInput>,
) {
  return exportTable(db, ctx, parseInput(accountantExportInput, input));
}

// ---------------------------------------------------------------------------
// As files
// ---------------------------------------------------------------------------

export type FinanceDocumentParams =
  | ({ kind: 'finance_report' } & FinanceReportParams)
  | ({ kind: 'accountant_export' } & AccountantExportParams);

/** Worker side: the table a report or export file was requested for. */
export async function financeDocumentData(
  db: VsDatabase,
  ctx: EngineContext,
  params: FinanceDocumentParams,
): Promise<FinanceTable> {
  if (params.kind === 'accountant_export') return exportTable(db, ctx, params);
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) => reportTable(tx, params));
}

const fileOptions = {
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  locale: z.enum(['ar', 'en', 'both']).default('en'),
};
export const requestFinanceReportInput = z
  .object({ ...reportShape, ...fileOptions })
  .refine((v) => v.from <= v.to, ordered);
export const requestAccountantExportInput = z
  .object({ ...exportShape, ...fileOptions })
  .refine((v) => v.from <= v.to, ordered);

async function queue(
  db: VsDatabase,
  ctx: EngineContext,
  params: FinanceDocumentParams,
  format: 'xlsx' | 'csv',
  locale: string,
) {
  if (params.from > params.to)
    throw new DomainError('VALIDATION_FAILED', { message: 'The start must be before the end' });
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{ id: string }>`
      insert into vs.document (operator_id, kind, format, locale, entity, entity_id, params, requested_by, expires_at)
      values (${ctx.operatorId}, ${params.kind}, ${format}, ${locale}, 'operator', ${ctx.operatorId},
              ${JSON.stringify(params)}::jsonb, ${ctx.actor.type === 'staff' ? ctx.actor.id : null},
              now() + interval '7 days')
      returning id`.execute(tx);
    const id = rows[0]!.id;
    await sql`select vs.enqueue_document(${id})`.execute(tx);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'document.requested',
      entity: 'document',
      entityId: id,
      after: { ...params, format },
    });
    return { documentId: id };
  });
}

export async function requestFinanceReport(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof requestFinanceReportInput>,
) {
  const { format, locale, ...params } = parseInput(requestFinanceReportInput, input);
  return queue(db, ctx, { kind: 'finance_report', ...params }, format, locale);
}

export async function requestAccountantExport(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof requestAccountantExportInput>,
) {
  const { format, locale, ...params } = parseInput(requestAccountantExportInput, input);
  return queue(db, ctx, { kind: 'accountant_export', ...params }, format, locale);
}
