import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { currencySchema } from '@vs/shared';
import { audit } from '../audit';
import { parseInput, type EngineContext, type Tx } from '../internal';

/**
 * Finance settings (invoicing F1): the company as the issuer of invoices, its numbering and its
 * tax lines. A company without a row uses the defaults: EGP base, INV/CN prefixes, 5 digits, no
 * tax. The logo, phone and e-mail come from Branding.
 */

const DEFAULTS = {
  legal_name_ar: null,
  legal_name_en: null,
  address_ar: null,
  address_en: null,
  tax_registration_no: null,
  commercial_registration_no: null,
  base_currency: 'EGP',
  invoice_currencies: ['EUR', 'USD', 'EGP'],
  invoice_prefix: 'INV',
  credit_note_prefix: 'CN',
  number_digits: 5,
  first_invoice_number: 1,
  first_credit_note_number: 1,
  default_terms_days: 14,
  bank_details_ar: null,
  bank_details_en: null,
  invoice_note_ar: null,
  invoice_note_en: null,
  eta_footer: true,
  eta_activity_code: null,
  eta_branch_id: null,
} as const;

export type FinanceSettings = {
  -readonly [K in keyof typeof DEFAULTS]: (typeof DEFAULTS)[K] extends string | null
    ? string | null
    : (typeof DEFAULTS)[K] extends readonly string[]
      ? string[]
      : (typeof DEFAULTS)[K] extends boolean
        ? boolean
        : number;
} & { base_currency: string; invoice_prefix: string; credit_note_prefix: string };

export async function loadFinanceSettings(tx: Tx): Promise<FinanceSettings> {
  const row = await tx.selectFrom('finance_setting').selectAll().executeTakeFirst();
  if (!row) return { ...DEFAULTS, invoice_currencies: [...DEFAULTS.invoice_currencies] };
  const { operator_id: _o, created_at: _c, updated_at: _u, ...settings } = row;
  return settings;
}

export async function getFinanceSettings(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const settings = await loadFinanceSettings(tx);
    // Numbering can no longer change once a document in that series has been issued.
    const issued = await tx
      .selectFrom('invoice')
      .select('series')
      .distinct()
      .where('series', 'is not', null)
      .execute();
    return {
      ...settings,
      numberingLocked: {
        invoice: issued.some((r) => r.series === 'invoice'),
        credit_note: issued.some((r) => r.series === 'credit_note'),
      },
    };
  });
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value ? value : null));

export const updateFinanceSettingsInput = z
  .object({
    legalNameAr: text(200),
    legalNameEn: text(200),
    addressAr: text(400),
    addressEn: text(400),
    taxRegistrationNo: text(40),
    commercialRegistrationNo: text(40),
    baseCurrency: currencySchema,
    invoiceCurrencies: z.array(currencySchema).min(1).max(10),
    invoicePrefix: z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/, 'Capital letters and digits, up to 8'),
    creditNotePrefix: z
      .string()
      .regex(/^[A-Z][A-Z0-9]{0,7}$/, 'Capital letters and digits, up to 8'),
    numberDigits: z.number().int().min(3).max(8),
    firstInvoiceNumber: z.number().int().min(1).max(99_999_999),
    firstCreditNoteNumber: z.number().int().min(1).max(99_999_999),
    defaultTermsDays: z.number().int().min(0).max(365),
    bankDetailsAr: text(1000),
    bankDetailsEn: text(1000),
    invoiceNoteAr: text(1000),
    invoiceNoteEn: text(1000),
    etaFooter: z.boolean(),
    etaActivityCode: text(20),
    etaBranchId: text(20),
  })
  .partial();

const COLUMNS = {
  legalNameAr: 'legal_name_ar',
  legalNameEn: 'legal_name_en',
  addressAr: 'address_ar',
  addressEn: 'address_en',
  taxRegistrationNo: 'tax_registration_no',
  commercialRegistrationNo: 'commercial_registration_no',
  baseCurrency: 'base_currency',
  invoiceCurrencies: 'invoice_currencies',
  invoicePrefix: 'invoice_prefix',
  creditNotePrefix: 'credit_note_prefix',
  numberDigits: 'number_digits',
  firstInvoiceNumber: 'first_invoice_number',
  firstCreditNoteNumber: 'first_credit_note_number',
  defaultTermsDays: 'default_terms_days',
  bankDetailsAr: 'bank_details_ar',
  bankDetailsEn: 'bank_details_en',
  invoiceNoteAr: 'invoice_note_ar',
  invoiceNoteEn: 'invoice_note_en',
  etaFooter: 'eta_footer',
  etaActivityCode: 'eta_activity_code',
  etaBranchId: 'eta_branch_id',
} as const;

const NUMBERING = {
  invoice: ['invoicePrefix', 'firstInvoiceNumber', 'numberDigits'],
  credit_note: ['creditNotePrefix', 'firstCreditNoteNumber', 'numberDigits'],
} as const;

export async function updateFinanceSettings(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateFinanceSettingsInput>,
) {
  const data = parseInput(updateFinanceSettingsInput, input);
  const before = await getFinanceSettings(db, ctx);
  for (const series of ['invoice', 'credit_note'] as const) {
    const changed = NUMBERING[series].find(
      (key) => data[key] !== undefined && data[key] !== before[COLUMNS[key]],
    );
    if (changed && before.numberingLocked[series])
      throw new DomainError('INVALID_STATE', {
        message: 'Numbering cannot change once a document has been issued in that series',
        details: { field: changed },
      });
  }
  if (data.baseCurrency && data.baseCurrency !== before.base_currency) {
    const any = before.numberingLocked.invoice || before.numberingLocked.credit_note;
    if (any)
      throw new DomainError('INVALID_STATE', {
        message: 'The base currency cannot change once invoices have been issued',
        details: { field: 'baseCurrency' },
      });
  }
  const set = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [COLUMNS[key as keyof typeof COLUMNS], value]),
  );
  await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await tx
      .insertInto('finance_setting')
      .values({ operator_id: ctx.operatorId, ...set })
      .onConflict((oc) => oc.column('operator_id').doUpdateSet(set))
      .execute();
    const changed = Object.entries(set).filter(
      ([column, value]) =>
        JSON.stringify(before[column as keyof FinanceSettings]) !== JSON.stringify(value),
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'finance_settings.updated',
      entity: 'operator',
      entityId: ctx.operatorId,
      before: Object.fromEntries(changed.map(([c]) => [c, before[c as keyof FinanceSettings]])),
      after: Object.fromEntries(changed),
    });
  });
  return getFinanceSettings(db, ctx);
}

export async function listTaxRates(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx.selectFrom('tax_rate').selectAll().orderBy('sort_order').orderBy('name_en').execute(),
  );
}

export const saveTaxRateInput = z.object({
  /** Omitted: a new tax line. */
  id: z.uuid().optional(),
  nameAr: z.string().trim().min(1).max(60),
  nameEn: z.string().trim().min(1).max(60),
  rateBps: z.number().int().min(0).max(10_000),
  inclusive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

/**
 * Creates or updates a tax line. Invoices keep a snapshot of the tax they were issued with, so
 * changing a rate never changes an issued invoice. The default applies to booking lines.
 */
export async function saveTaxRate(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof saveTaxRateInput>,
) {
  const data = parseInput(saveTaxRateInput, input);
  if (data.isDefault && !data.active)
    throw new DomainError('VALIDATION_FAILED', { message: 'The default tax must be active' });
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    if (data.isDefault)
      await tx
        .updateTable('tax_rate')
        .set({ is_default: false })
        .where('is_default', '=', true)
        .$if(!!data.id, (q) => q.where('id', '<>', data.id!))
        .execute();
    const values = {
      name_ar: data.nameAr,
      name_en: data.nameEn,
      rate_bps: data.rateBps,
      inclusive: data.inclusive,
      is_default: data.isDefault,
      active: data.active,
      sort_order: data.sortOrder,
    };
    const before = data.id
      ? await tx
          .selectFrom('tax_rate')
          .selectAll()
          .where('id', '=', data.id)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    if (data.id && !before) throw new DomainError('NOT_FOUND', { message: 'Tax not found' });
    const row = data.id
      ? await tx
          .updateTable('tax_rate')
          .set(values)
          .where('id', '=', data.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await tx
          .insertInto('tax_rate')
          .values({ operator_id: ctx.operatorId, ...values })
          .returningAll()
          .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: data.id ? 'tax_rate.updated' : 'tax_rate.created',
      entity: 'tax_rate',
      entityId: row.id,
      before: before ?? null,
      after: row,
    });
    return row;
  });
}
