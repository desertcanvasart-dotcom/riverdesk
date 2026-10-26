import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { convert, money } from '@vs/shared';
import { audit } from '../audit';
import { parseInput, type EngineContext } from '../internal';
import { dateSchema } from '../schedule/setup';
import { issuerSnapshot, partySnapshot } from './invoices';

/**
 * Invoice documents (invoicing F2): an invoice, proforma or credit note as a PDF, and the
 * invoice register as a workbook. An issued document prints its frozen snapshots of the company
 * and the party, so re-printing it next year gives the same page; a draft prints today's details.
 */

type Bilingual = { ar: string; en: string };

export interface InvoiceIssuer {
  name: string;
  legalNameAr: string | null;
  legalNameEn: string | null;
  addressAr: string | null;
  addressEn: string | null;
  taxRegistrationNo: string | null;
  commercialRegistrationNo: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  bankDetailsAr: string | null;
  bankDetailsEn: string | null;
  noteAr: string | null;
  noteEn: string | null;
  etaFooter: boolean;
}

export interface InvoiceParty {
  kind: 'agency' | 'guest';
  name: string;
  legalNameAr: string | null;
  legalNameEn: string | null;
  address: string | null;
  taxRegistrationNo: string | null;
  commercialRegistrationNo: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
}

export interface InvoiceDocumentData {
  id: string;
  type: 'proforma' | 'invoice' | 'credit_note';
  status: string;
  number: string | null;
  /** The proforma's reference: its bookings' refs (it has no number). */
  bookingRefs: string[];
  issueDate: string | null;
  dueDate: string | null;
  createdAt: Date;
  currency: string;
  baseCurrency: string;
  fx: { rate: string; source: string | null; date: string | null; baseTotal: bigint } | null;
  issuer: InvoiceIssuer;
  party: InvoiceParty;
  credits: { number: string; issueDate: string } | null;
  creditReason: string | null;
  lines: {
    seq: number;
    kind: string;
    bookingRef: string | null;
    description: Bilingual;
    quantity: number;
    unitAmount: bigint;
    amount: bigint;
    tax: { name: Bilingual; bps: number; inclusive: boolean } | null;
    taxAmount: bigint;
  }[];
  /** One row per tax line used: its rate, the amount it applies to (before tax) and the tax. */
  taxes: { name: Bilingual; bps: number; base: bigint; tax: bigint }[];
  subtotal: bigint;
  taxTotal: bigint;
  total: bigint;
  amountCredited: bigint;
  amountPaid: bigint;
  notes: string | null;
}

export async function invoiceDocumentData(
  db: VsDatabase,
  ctx: EngineContext,
  invoiceId: string,
): Promise<InvoiceDocumentData> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const invoice = await tx
      .selectFrom('invoice')
      .selectAll()
      .where('id', '=', invoiceId)
      .executeTakeFirst();
    if (!invoice) throw new DomainError('NOT_FOUND', { message: 'Invoice not found' });
    const lines = await tx
      .selectFrom('invoice_line as l')
      .leftJoin('booking as b', 'b.id', 'l.booking_id')
      .selectAll('l')
      .select('b.ref as booking_ref')
      .where('l.invoice_id', '=', invoiceId)
      .orderBy('l.seq')
      .execute();
    const issuer = (invoice.issuer_snapshot ??
      (await issuerSnapshot(tx)).snapshot) as unknown as InvoiceIssuer;
    const party = (invoice.party_snapshot ??
      (await partySnapshot(tx, invoice.billing_party_id))) as unknown as InvoiceParty;
    const credited = invoice.credits_invoice_id
      ? await tx
          .selectFrom('invoice')
          .select(['number', 'issue_date'])
          .where('id', '=', invoice.credits_invoice_id)
          .executeTakeFirstOrThrow()
      : null;

    const taxes = new Map<string, InvoiceDocumentData['taxes'][number]>();
    for (const l of lines) {
      if (l.tax_bps === null) continue;
      const key = `${l.tax_name_en}|${l.tax_bps}`;
      const row = taxes.get(key) ?? {
        name: { ar: l.tax_name_ar ?? '', en: l.tax_name_en ?? '' },
        bps: l.tax_bps,
        base: 0n,
        tax: 0n,
      };
      row.base += l.tax_inclusive ? l.amount - l.tax_amount : l.amount;
      row.tax += l.tax_amount;
      taxes.set(key, row);
    }

    return {
      id: invoice.id,
      type: invoice.type as InvoiceDocumentData['type'],
      status: invoice.status,
      number: invoice.number,
      bookingRefs: [...new Set(lines.map((l) => l.booking_ref).filter((r): r is string => !!r))],
      issueDate: invoice.issue_date,
      dueDate: invoice.due_date,
      createdAt: invoice.created_at,
      currency: invoice.currency,
      baseCurrency: invoice.base_currency,
      fx: invoice.fx_rate
        ? {
            rate: invoice.fx_rate,
            source: invoice.fx_source,
            date: invoice.fx_date,
            baseTotal: convert(
              money(invoice.total, invoice.currency),
              invoice.fx_rate,
              invoice.base_currency,
            ).amount,
          }
        : null,
      issuer,
      party,
      credits: credited ? { number: credited.number!, issueDate: credited.issue_date! } : null,
      creditReason: invoice.credit_reason,
      lines: lines.map((l) => ({
        seq: l.seq,
        kind: l.kind,
        bookingRef: l.booking_ref,
        description: { ar: l.description_ar, en: l.description_en },
        quantity: l.quantity,
        unitAmount: l.unit_amount,
        amount: l.amount,
        tax:
          l.tax_bps !== null
            ? {
                name: { ar: l.tax_name_ar ?? '', en: l.tax_name_en ?? '' },
                bps: l.tax_bps,
                inclusive: !!l.tax_inclusive,
              }
            : null,
        taxAmount: l.tax_amount,
      })),
      taxes: [...taxes.values()],
      subtotal: invoice.subtotal,
      taxTotal: invoice.tax_total,
      total: invoice.total,
      amountCredited: invoice.amount_credited,
      amountPaid: invoice.amount_paid,
      notes: invoice.notes,
    };
  });
}

export const requestInvoiceDocumentInput = z.object({
  invoiceId: z.uuid(),
  locale: z.enum(['ar', 'en', 'both']),
});

/** Queues the PDF of an invoice, proforma or credit note (kept a week like other documents). */
export async function requestInvoiceDocument(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof requestInvoiceDocumentInput>,
) {
  const data = parseInput(requestInvoiceDocumentInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const invoice = await tx
      .selectFrom('invoice')
      .select(['id', 'type', 'number'])
      .where('id', '=', data.invoiceId)
      .executeTakeFirst();
    if (!invoice) throw new DomainError('NOT_FOUND', { message: 'Invoice not found' });
    const { rows } = await sql<{ id: string }>`
      insert into vs.document (operator_id, kind, format, locale, entity, entity_id, requested_by, expires_at)
      values (${ctx.operatorId}, 'invoice', 'pdf', ${data.locale}, 'invoice', ${invoice.id},
              ${ctx.actor.type === 'staff' ? ctx.actor.id : null}, now() + interval '7 days')
      returning id`.execute(tx);
    const id = rows[0]!.id;
    await sql`select vs.enqueue_document(${id})`.execute(tx);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'document.requested',
      entity: 'document',
      entityId: id,
      after: { kind: 'invoice', type: invoice.type, number: invoice.number, locale: data.locale },
    });
    return { documentId: id };
  });
}

export const invoiceRegisterInput = z
  .object({
    from: dateSchema,
    to: dateSchema,
    locale: z.enum(['ar', 'en', 'both']).default('en'),
  })
  .refine((v) => v.from <= v.to, { message: 'The start must be before the end' });

export interface InvoiceRegisterParams {
  from: string;
  to: string;
}

/** Queues the invoice register: every invoice and credit note issued in the period. */
export async function requestInvoiceRegister(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof invoiceRegisterInput>,
) {
  const data = parseInput(invoiceRegisterInput, input);
  const params: InvoiceRegisterParams = { from: data.from, to: data.to };
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{ id: string }>`
      insert into vs.document (operator_id, kind, format, locale, entity, entity_id, params, requested_by, expires_at)
      values (${ctx.operatorId}, 'invoice_register', 'xlsx', ${data.locale}, 'operator', ${ctx.operatorId},
              ${JSON.stringify(params)}::jsonb, ${ctx.actor.type === 'staff' ? ctx.actor.id : null},
              now() + interval '7 days')
      returning id`.execute(tx);
    const id = rows[0]!.id;
    await sql`select vs.enqueue_document(${id})`.execute(tx);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'document.requested',
      entity: 'document',
      entityId: id,
      after: { kind: 'invoice_register', ...params },
    });
    return { documentId: id };
  });
}

export interface InvoiceRegisterRow {
  number: string;
  type: 'invoice' | 'credit_note';
  status: string;
  issueDate: string;
  dueDate: string | null;
  party: string;
  partyKind: string;
  partyTaxNo: string | null;
  credits: string | null;
  bookingRefs: string[];
  currency: string;
  subtotal: bigint;
  taxTotal: bigint;
  total: bigint;
  amountCredited: bigint;
  amountPaid: bigint;
  fxRate: string | null;
  baseCurrency: string;
  /** The total in the base currency (at the invoice's rate), or the total itself. */
  baseTotal: bigint;
}

/** Worker side: the rows of the invoice register, by issue date then number. */
export async function invoiceRegisterData(
  db: VsDatabase,
  ctx: EngineContext,
  params: InvoiceRegisterParams,
): Promise<InvoiceRegisterRow[]> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const rows = await tx
      .selectFrom('invoice as i')
      .innerJoin('billing_party as p', 'p.id', 'i.billing_party_id')
      .leftJoin('invoice as c', 'c.id', 'i.credits_invoice_id')
      .select([
        'i.id',
        'i.number',
        'i.type',
        'i.status',
        'i.issue_date',
        'i.due_date',
        'i.party_snapshot',
        'p.name as party_name',
        'p.kind as party_kind',
        'c.number as credits',
        'i.currency',
        'i.subtotal',
        'i.tax_total',
        'i.total',
        'i.amount_credited',
        'i.amount_paid',
        'i.fx_rate',
        'i.base_currency',
        sql<
          string[]
        >`array(select distinct b.ref from vs.invoice_line l join vs.booking b on b.id = l.booking_id
                            where l.invoice_id = i.id order by b.ref)`.as('refs'),
      ])
      .where('i.number', 'is not', null)
      .where('i.issue_date', '>=', params.from)
      .where('i.issue_date', '<=', params.to)
      .orderBy('i.issue_date')
      .orderBy('i.series')
      .orderBy('i.seq')
      .execute();
    return rows.map((r) => {
      const snapshot = (r.party_snapshot ?? {}) as Partial<InvoiceParty>;
      return {
        number: r.number!,
        type: r.type as InvoiceRegisterRow['type'],
        status: r.status,
        issueDate: r.issue_date!,
        dueDate: r.due_date,
        party: snapshot.legalNameEn || snapshot.name || r.party_name,
        partyKind: r.party_kind,
        partyTaxNo: snapshot.taxRegistrationNo ?? null,
        credits: r.credits,
        bookingRefs: r.refs,
        currency: r.currency,
        subtotal: r.subtotal,
        taxTotal: r.tax_total,
        total: r.total,
        amountCredited: r.amount_credited,
        amountPaid: r.amount_paid,
        fxRate: r.fx_rate,
        baseCurrency: r.base_currency,
        baseTotal: r.fx_rate
          ? convert(money(r.total, r.currency), r.fx_rate, r.base_currency).amount
          : r.total,
      };
    });
  });
}
