import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import { cairoToday, parseInput, type EngineContext, type Tx } from '../internal';
import { dateSchema } from '../schedule/setup';
import { issuerSnapshot } from './invoices';
import type { InvoiceIssuer } from './documents';

/**
 * Receivables (invoicing F4, docs/invoicing-plan.md § 3.6 and § 3.7): a party's statement, the
 * aging of open invoices, and an agency's credit exposure. These are queries, not stored tables.
 *
 * Signs: what the party owes is positive. An invoice adds its total; a credit note takes its total
 * off; money received takes its amount off (a refund paid out, a negative receipt, adds it back).
 */

// ---------------------------------------------------------------------------
// Statement
// ---------------------------------------------------------------------------

export const statementInput = z
  .object({
    billingPartyId: z.uuid(),
    from: dateSchema,
    to: dateSchema,
  })
  .refine((v) => v.from <= v.to, { message: 'The start must be before the end' });

export interface StatementRow {
  date: string;
  kind: 'invoice' | 'credit_note' | 'receipt' | 'refund' | 'reversal';
  id: string;
  /** The invoice or credit note number, or the receipt's reference. */
  reference: string;
  /** Adds to what the party owes. */
  debit: bigint;
  /** Takes off what the party owes. */
  credit: bigint;
  balance: bigint;
  dueDate: string | null;
}

export interface StatementCurrency {
  currency: string;
  opening: bigint;
  rows: StatementRow[];
  closing: bigint;
  /** Today: open invoice balances, and money received not yet on an invoice. */
  openInvoices: bigint;
  unappliedCredit: bigint;
}

export interface StatementData {
  party: {
    id: string;
    kind: string;
    name: string;
    legalNameAr: string | null;
    legalNameEn: string | null;
    address: string | null;
    taxRegistrationNo: string | null;
    email: string | null;
  };
  issuer: InvoiceIssuer;
  from: string;
  to: string;
  today: string;
  currencies: StatementCurrency[];
}

async function statementFor(
  tx: Tx,
  partyId: string,
  from: string,
  to: string,
): Promise<StatementData> {
  const party = await tx
    .selectFrom('billing_party')
    .selectAll()
    .where('id', '=', partyId)
    .executeTakeFirst();
  if (!party) throw new DomainError('NOT_FOUND', { message: 'Billing party not found' });
  // Every movement, dated: invoices and credit notes by issue date, money by the day received.
  const { rows } = await sql<{
    date: string;
    kind: StatementRow['kind'];
    id: string;
    reference: string;
    currency: string;
    amount: string;
    due_date: string | null;
    seq: string;
  }>`
    select i.issue_date::text as date, i.type as kind, i.id, i.number as reference, i.currency,
           (case i.type when 'credit_note' then -i.total else i.total end)::text as amount,
           i.due_date::text as due_date, i.issued_at::text as seq
    from vs.invoice i
    where i.billing_party_id = ${partyId} and i.type in ('invoice', 'credit_note')
      and i.status <> 'draft' and i.issue_date <= ${to}::date
    union all
    select r.received_on::text, r.kind, r.id, r.reference, r.currency, (-r.amount)::text, null,
           r.created_at::text
    from vs.receipt r
    where r.billing_party_id = ${partyId} and r.received_on <= ${to}::date
    order by 1, 8`.execute(tx);
  const byCurrency = new Map<string, StatementCurrency>();
  const entry = (currency: string) => {
    let c = byCurrency.get(currency);
    if (!c) {
      c = { currency, opening: 0n, rows: [], closing: 0n, openInvoices: 0n, unappliedCredit: 0n };
      byCurrency.set(currency, c);
    }
    return c;
  };
  for (const row of rows) {
    const c = entry(row.currency);
    const amount = BigInt(row.amount);
    if (row.date < from) {
      c.opening += amount;
      c.closing = c.opening;
      continue;
    }
    c.closing += amount;
    c.rows.push({
      date: row.date,
      kind: row.kind,
      id: row.id,
      reference: row.reference,
      debit: amount > 0n ? amount : 0n,
      credit: amount < 0n ? -amount : 0n,
      balance: c.closing,
      dueDate: row.kind === 'invoice' ? row.due_date : null,
    });
  }
  const { rows: open } = await sql<{ currency: string; open: string; credit: string }>`
    select currency, sum(open)::text as open, sum(credit)::text as credit from (
      select i.currency, i.total - i.amount_credited - i.amount_paid as open, 0 as credit
      from vs.invoice i
      where i.billing_party_id = ${partyId} and i.type = 'invoice' and i.status in ('issued', 'partially_paid')
      union all
      select r.currency, 0, r.amount - coalesce((select sum(a.amount) from vs.allocation a where a.receipt_id = r.id), 0)
      from vs.receipt r where r.billing_party_id = ${partyId}
    ) x group by currency`.execute(tx);
  for (const o of open) {
    const c = entry(o.currency);
    c.openInvoices = BigInt(o.open);
    c.unappliedCredit = BigInt(o.credit);
  }
  const { snapshot } = await issuerSnapshot(tx);
  return {
    party: {
      id: party.id,
      kind: party.kind,
      name: party.name,
      legalNameAr: party.legal_name_ar,
      legalNameEn: party.legal_name_en,
      address: party.address,
      taxRegistrationNo: party.tax_registration_no,
      email: party.email,
    },
    issuer: snapshot,
    from,
    to,
    today: await cairoToday(tx),
    currencies: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

/** A party's statement for a period: opening balance, dated movements, closing balance. */
export async function getStatement(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof statementInput>,
) {
  const data = parseInput(statementInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    statementFor(tx, data.billingPartyId, data.from, data.to),
  );
}

/** Worker side: the statement a document was requested for. */
export async function statementDocumentData(
  db: VsDatabase,
  ctx: EngineContext,
  params: StatementParams,
): Promise<StatementData> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    statementFor(tx, params.billingPartyId, params.from, params.to),
  );
}

export interface StatementParams {
  billingPartyId: string;
  from: string;
  to: string;
}

export const requestStatementInput = z
  .object({
    billingPartyId: z.uuid(),
    from: dateSchema,
    to: dateSchema,
    locale: z.enum(['ar', 'en', 'both']).default('ar'),
    format: z.enum(['pdf', 'xlsx']).default('pdf'),
  })
  .refine((v) => v.from <= v.to, { message: 'The start must be before the end' });

/** Queues a statement as a PDF (to send the party) or a workbook. */
export async function requestStatementDocument(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof requestStatementInput>,
) {
  const data = parseInput(requestStatementInput, input);
  const params: StatementParams = {
    billingPartyId: data.billingPartyId,
    from: data.from,
    to: data.to,
  };
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const party = await tx
      .selectFrom('billing_party')
      .select(['id', 'name'])
      .where('id', '=', data.billingPartyId)
      .executeTakeFirst();
    if (!party) throw new DomainError('NOT_FOUND', { message: 'Billing party not found' });
    const { rows } = await sql<{ id: string }>`
      insert into vs.document (operator_id, kind, format, locale, entity, entity_id, params, requested_by, expires_at)
      values (${ctx.operatorId}, 'statement', ${data.format}, ${data.locale}, 'billing_party', ${party.id},
              ${JSON.stringify(params)}::jsonb, ${ctx.actor.type === 'staff' ? ctx.actor.id : null},
              now() + interval '7 days')
      returning id`.execute(tx);
    const id = rows[0]!.id;
    await sql`select vs.enqueue_document(${id})`.execute(tx);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'document.requested',
      entity: 'document',
      entityId: id,
      after: { kind: 'statement', party: party.name, ...params, format: data.format },
    });
    return { documentId: id };
  });
}

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------

export const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface AgingRow {
  partyId: string;
  partyName: string;
  partyKind: string;
  currency: string;
  buckets: Record<AgingBucket, bigint>;
  /** Open invoice balances, all buckets. */
  total: bigint;
  /** Money received by the date and not yet on an invoice. */
  unappliedCredit: bigint;
  /** total − unappliedCredit. */
  net: bigint;
  invoices: number;
}

export interface AgingData {
  asOf: string;
  rows: AgingRow[];
  totals: (Omit<AgingRow, 'partyId' | 'partyName' | 'partyKind' | 'invoices'> & {
    invoices: number;
  })[];
}

export const agingInput = z.object({
  /** Defaults to today (Cairo). */
  asOf: dateSchema.optional(),
});

const emptyBuckets = (): Record<AgingBucket, bigint> => ({
  current: 0n,
  d1_30: 0n,
  d31_60: 0n,
  d61_90: 0n,
  d90_plus: 0n,
});

function bucketOf(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return 'd1_30';
  if (daysPastDue <= 60) return 'd31_60';
  if (daysPastDue <= 90) return 'd61_90';
  return 'd90_plus';
}

/**
 * Open invoice balances as they stood at the end of `asOf`, by days past their due date: credit
 * notes issued and money allocated by then are taken off. A party's money received by then and
 * not yet on an invoice is shown beside them.
 */
export async function getAgingInTx(tx: Tx, asOf: string): Promise<AgingData> {
  const { rows: invoices } = await sql<{
    party_id: string;
    party_name: string;
    party_kind: string;
    currency: string;
    days: number;
    open: string;
  }>`
    select * from (
      select p.id as party_id, p.name as party_name, p.kind as party_kind, i.currency,
             (${asOf}::date - i.due_date)::int as days,
             (i.total
               - coalesce((select sum(cn.total) from vs.invoice cn
                           where cn.credits_invoice_id = i.id and cn.status <> 'draft'
                             and cn.issue_date <= ${asOf}::date), 0)
               - coalesce((select sum(a.invoice_amount) from vs.allocation a
                           where a.invoice_id = i.id
                             and (a.created_at at time zone 'Africa/Cairo')::date <= ${asOf}::date), 0)
             )::text as open
      from vs.invoice i join vs.billing_party p on p.id = i.billing_party_id
      where i.type = 'invoice' and i.status <> 'draft' and i.issue_date <= ${asOf}::date
    ) x where open::bigint > 0`.execute(tx);
  const { rows: credits } = await sql<{
    party_id: string;
    party_name: string;
    party_kind: string;
    currency: string;
    credit: string;
  }>`
    select p.id as party_id, p.name as party_name, p.kind as party_kind, r.currency,
           sum(r.amount - coalesce((select sum(a.amount) from vs.allocation a
                                    where a.receipt_id = r.id
                                      and (a.created_at at time zone 'Africa/Cairo')::date <= ${asOf}::date), 0))::text as credit
    from vs.receipt r join vs.billing_party p on p.id = r.billing_party_id
    where r.received_on <= ${asOf}::date
    group by p.id, r.currency
    having sum(r.amount - coalesce((select sum(a.amount) from vs.allocation a
                                    where a.receipt_id = r.id
                                      and (a.created_at at time zone 'Africa/Cairo')::date <= ${asOf}::date), 0)) <> 0`.execute(
    tx,
  );
  const rows = new Map<string, AgingRow>();
  const row = (r: {
    party_id: string;
    party_name: string;
    party_kind: string;
    currency: string;
  }) => {
    const key = `${r.party_id}|${r.currency}`;
    let x = rows.get(key);
    if (!x) {
      x = {
        partyId: r.party_id,
        partyName: r.party_name,
        partyKind: r.party_kind,
        currency: r.currency,
        buckets: emptyBuckets(),
        total: 0n,
        unappliedCredit: 0n,
        net: 0n,
        invoices: 0,
      };
      rows.set(key, x);
    }
    return x;
  };
  for (const i of invoices) {
    const x = row(i);
    const open = BigInt(i.open);
    x.buckets[bucketOf(i.days)] += open;
    x.total += open;
    x.invoices += 1;
  }
  for (const c of credits) row(c).unappliedCredit += BigInt(c.credit);
  const list = [...rows.values()].map((x) => ({ ...x, net: x.total - x.unappliedCredit }));
  list.sort(
    (a, b) =>
      a.currency.localeCompare(b.currency) ||
      (b.net > a.net ? 1 : b.net < a.net ? -1 : 0) ||
      a.partyName.localeCompare(b.partyName),
  );
  const totals = new Map<string, AgingData['totals'][number]>();
  for (const x of list) {
    let t = totals.get(x.currency);
    if (!t) {
      t = {
        currency: x.currency,
        buckets: emptyBuckets(),
        total: 0n,
        unappliedCredit: 0n,
        net: 0n,
        invoices: 0,
      };
      totals.set(x.currency, t);
    }
    for (const b of AGING_BUCKETS) t.buckets[b] += x.buckets[b];
    t.total += x.total;
    t.unappliedCredit += x.unappliedCredit;
    t.net += x.net;
    t.invoices += x.invoices;
  }
  return { asOf, rows: list, totals: [...totals.values()] };
}

export async function getAging(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof agingInput> = {},
) {
  const data = parseInput(agingInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) =>
    getAgingInTx(tx, data.asOf ?? (await cairoToday(tx))),
  );
}

export interface AgingParams {
  asOf: string;
}

/** Worker side: the aging a workbook was requested for. */
export async function agingDocumentData(
  db: VsDatabase,
  ctx: EngineContext,
  params: AgingParams,
): Promise<AgingData> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) => getAgingInTx(tx, params.asOf));
}

export const requestAgingInput = z.object({
  asOf: dateSchema.optional(),
  locale: z.enum(['ar', 'en', 'both']).default('en'),
});

/** Queues the aging as a workbook for the accountant. */
export async function requestAgingDocument(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof requestAgingInput>,
) {
  const data = parseInput(requestAgingInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const params: AgingParams = { asOf: data.asOf ?? (await cairoToday(tx)) };
    const { rows } = await sql<{ id: string }>`
      insert into vs.document (operator_id, kind, format, locale, entity, entity_id, params, requested_by, expires_at)
      values (${ctx.operatorId}, 'aging', 'xlsx', ${data.locale}, 'operator', ${ctx.operatorId},
              ${JSON.stringify(params)}::jsonb, ${ctx.actor.type === 'staff' ? ctx.actor.id : null},
              now() + interval '7 days')
      returning id`.execute(tx);
    const id = rows[0]!.id;
    await sql`select vs.enqueue_document(${id})`.execute(tx);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'document.requested',
      entity: 'document',
      entityId: id,
      after: { kind: 'aging', ...params },
    });
    return { documentId: id };
  });
}

// ---------------------------------------------------------------------------
// Credit exposure (§ 3.7)
// ---------------------------------------------------------------------------

export interface CreditExposure {
  channelId: string;
  allowed: boolean;
  limit: bigint | null;
  currency: string | null;
  /** Confirmed bookings not on an issued invoice: total + fees − paid. */
  uninvoiced: bigint;
  /** The agency's issued invoices still open. */
  openInvoices: bigint;
  /** The agency's money received and not yet on an invoice. */
  unappliedCredit: bigint;
  /** uninvoiced + openInvoices − unappliedCredit. */
  exposure: bigint;
  /** limit − exposure (null without a limit). */
  remaining: bigint | null;
}

/**
 * What an agency owes on credit, in its limit currency: confirmed bookings not yet invoiced, plus
 * open invoices, less money it paid that is not on an invoice yet. Bookings and invoices in
 * another currency are not counted (as before invoicing).
 */
export async function creditExposure(tx: Tx, channelId: string): Promise<CreditExposure> {
  const channel = await tx
    .selectFrom('channel')
    .select(['id', 'credit_allowed', 'credit_limit', 'credit_currency'])
    .where('id', '=', channelId)
    .executeTakeFirstOrThrow();
  const currency = channel.credit_currency;
  if (!currency)
    return {
      channelId,
      allowed: channel.credit_allowed,
      limit: channel.credit_limit,
      currency: null,
      uninvoiced: 0n,
      openInvoices: 0n,
      unappliedCredit: 0n,
      exposure: 0n,
      remaining: null,
    };
  const { rows } = await sql<{ uninvoiced: string; open: string; credit: string }>`
    select
      (select coalesce(sum(b.total + b.fees - b.amount_paid), 0) from vs.booking b
       where b.channel_id = ${channelId} and b.status = 'confirmed' and b.currency = ${currency}
         and not exists (select from vs.invoice_line l join vs.invoice i on i.id = l.invoice_id
                         where l.booking_id = b.id and i.type = 'invoice'
                           and i.status in ('issued', 'partially_paid', 'paid')))::text as uninvoiced,
      (select coalesce(sum(i.total - i.amount_credited - i.amount_paid), 0) from vs.invoice i
       join vs.billing_party p on p.id = i.billing_party_id
       where p.channel_id = ${channelId} and p.kind = 'agency' and i.type = 'invoice'
         and i.status in ('issued', 'partially_paid') and i.currency = ${currency})::text as open,
      (select coalesce(sum(r.amount - coalesce((select sum(a.amount) from vs.allocation a where a.receipt_id = r.id), 0)), 0)
       from vs.receipt r join vs.billing_party p on p.id = r.billing_party_id
       where p.channel_id = ${channelId} and p.kind = 'agency' and r.booking_id is null
         and r.currency = ${currency})::text as credit`.execute(tx);
  const uninvoiced = BigInt(rows[0]!.uninvoiced);
  const openInvoices = BigInt(rows[0]!.open);
  const unappliedCredit = BigInt(rows[0]!.credit);
  const exposure = uninvoiced + openInvoices - unappliedCredit;
  return {
    channelId,
    allowed: channel.credit_allowed,
    limit: channel.credit_limit,
    currency,
    uninvoiced,
    openInvoices,
    unappliedCredit,
    exposure,
    remaining: channel.credit_limit === null ? null : channel.credit_limit - exposure,
  };
}

export async function getCreditExposure(
  db: VsDatabase,
  ctx: EngineContext,
  input: { channelId: string },
) {
  const { channelId } = parseInput(z.object({ channelId: z.uuid() }), input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const found = await tx
      .selectFrom('channel')
      .select('id')
      .where('id', '=', channelId)
      .executeTakeFirst();
    if (!found) throw new DomainError('NOT_FOUND', { message: 'Channel not found' });
    return creditExposure(tx, channelId);
  });
}
