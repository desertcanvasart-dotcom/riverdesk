import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import { parseInput, type EngineContext } from '../internal';
import { dateSchema } from '../schedule/setup';

/**
 * Documents are requested by staff, rendered by the worker (Chromium for PDF and PNG, ExcelJS
 * for spreadsheets) and downloaded once ready. The request and the job are queued in the same
 * transaction through vs.enqueue_document, the only way the back office reaches the job queue.
 */

export const BOOKING_DOCUMENTS = [
  'voucher',
  'itinerary',
  'payment_schedule',
  'cancellation_terms',
  // Batch D3: where and when to board, what to bring.
  'predeparture',
  // Batch D4: transfers to and from the vessel; a boarding pass per cabin with a QR code.
  'transfer_voucher',
  'boarding_pass',
] as const;
export const LEG_DOCUMENTS = ['manifest', 'rooming_list'] as const;
/**
 * Check-in documents (Batch D2), per departure: the embarkation sheet (no passport numbers), the
 * check-in file and the registration cards (passport numbers: like the manifest, kept a day).
 */
export const CHECKIN_DOCUMENTS = [
  'embarkation_sheet',
  'checkin_file',
  'registration_cards',
] as const;
/**
 * On-board operations (Batch D3), per departure: the kitchen's diets and allergies and the
 * occasions (everyone aboard), cabin door cards (those boarding), and the disembarkation and
 * transfer list (those leaving where the departure ends). No passport numbers, no money.
 */
export const OPERATIONS_DOCUMENTS = [
  'diet_list',
  'occasion_list',
  'door_cards',
  'disembarkation_list',
] as const;
/**
 * The remaining stationery (Batch D4), per departure, PDF: luggage tags and door-to-door items for
 * those boarding; excursion groups, the table plan and the muster list for everyone aboard;
 * feedback forms for those leaving. No passport numbers, no money.
 */
export const STATIONERY_DOCUMENTS = [
  'luggage_tags',
  'excursion_list',
  'table_plan',
  'muster_list',
  'feedback_forms',
] as const;
/** What an on-board login may print, for its own vessel. */
export const ONBOARD_DOCUMENTS: readonly string[] = [
  ...CHECKIN_DOCUMENTS,
  ...OPERATIONS_DOCUMENTS,
  ...STATIONERY_DOCUMENTS,
  'daily_programme',
  'housekeeping_sheet',
];
/** Documents carrying passport numbers. */
export const PASSPORT_DOCUMENTS: readonly string[] = [
  'manifest',
  'checkin_file',
  'registration_cards',
];

// 'both': Arabic first with English beneath each label (on-board staff, police lists).
const locale = z.enum(['ar', 'en', 'both']);

export const requestDocumentInput = z.union([
  z.object({
    kind: z.enum(BOOKING_DOCUMENTS),
    bookingId: z.uuid(),
    locale,
    variant: z.enum(['full', 'agent']).default('full'),
  }),
  z.object({
    kind: z.enum(LEG_DOCUMENTS),
    legId: z.uuid(),
    locale,
    format: z.enum(['pdf', 'xlsx']),
  }),
  z.object({
    kind: z.enum(CHECKIN_DOCUMENTS),
    legId: z.uuid(),
    locale,
    format: z.enum(['pdf', 'xlsx']).default('pdf'),
    /** `agent`: without balances (an on-board login sees no money). */
    variant: z.enum(['full', 'agent']).default('full'),
  }),
  z.object({
    kind: z.enum(OPERATIONS_DOCUMENTS),
    legId: z.uuid(),
    locale,
    format: z.enum(['pdf', 'xlsx']).default('pdf'),
  }),
  z.object({
    kind: z.enum(STATIONERY_DOCUMENTS),
    legId: z.uuid(),
    locale,
    format: z.literal('pdf').default('pdf'),
  }),
  /** Every cabin of a vessel on one day: leaving, arriving, staying, empty. */
  z.object({ kind: z.literal('housekeeping_sheet'), vesselId: z.uuid(), date: dateSchema, locale }),
  /** One page per day for a vessel, to print and slide under doors. */
  z.object({
    kind: z.literal('daily_programme'),
    vesselId: z.uuid(),
    from: dateSchema,
    days: z.number().int().min(1).max(14).default(7),
    locale,
  }),
  z.object({ kind: z.literal('outage_pack'), vesselId: z.uuid(), locale }),
  z.object({
    kind: z.literal('vacancy_sheet'),
    vesselId: z.uuid(),
    from: dateSchema,
    weeks: z.number().int().min(1).max(8).default(4),
    locale,
    format: z.enum(['pdf', 'xlsx', 'png']),
  }),
]);

export type RequestDocumentInput = z.input<typeof requestDocumentInput>;

export async function requestDocument(
  db: VsDatabase,
  ctx: EngineContext,
  input: RequestDocumentInput,
  /** An on-board login: only its own vessel's departures. */
  scope: { vesselId: string | null } = { vesselId: null },
) {
  const data = parseInput(requestDocumentInput, input);
  // Only the check-in file and the operations lists come as spreadsheets; sheets and cards are PDFs.
  if (
    (data.kind === 'embarkation_sheet' ||
      data.kind === 'registration_cards' ||
      data.kind === 'door_cards') &&
    data.format !== 'pdf'
  )
    throw new DomainError('VALIDATION_FAILED', { message: `${data.kind} is a PDF` });
  const target =
    'bookingId' in data
      ? { entity: 'booking', entityId: data.bookingId, format: 'pdf', table: 'booking' as const }
      : 'legId' in data
        ? { entity: 'leg', entityId: data.legId, format: data.format, table: 'leg' as const }
        : {
            entity: 'vessel',
            entityId: data.vesselId,
            format: data.kind === 'vacancy_sheet' ? data.format : 'pdf',
            table: 'vessel' as const,
          };
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const exists = await tx
      .selectFrom(target.table)
      .select(
        target.table === 'booking' || target.table === 'leg' ? 'vessel_id' : 'id as vessel_id',
      )
      .where('id', '=', target.entityId)
      .executeTakeFirst();
    if (!exists || (scope.vesselId && exists.vessel_id !== scope.vesselId))
      throw new DomainError('NOT_FOUND', { message: `${target.entity} not found` });
    const { rows } = await sql<{ id: string }>`
      insert into vs.document (operator_id, kind, format, locale, variant, entity, entity_id, params, requested_by, expires_at)
      values (${ctx.operatorId}, ${data.kind}, ${target.format}, ${data.locale}, ${'variant' in data ? data.variant : 'full'},
              ${target.entity}, ${target.entityId},
              ${JSON.stringify(
                data.kind === 'vacancy_sheet'
                  ? { from: data.from, weeks: data.weeks }
                  : data.kind === 'daily_programme'
                    ? { from: data.from, days: data.days }
                    : data.kind === 'housekeeping_sheet'
                      ? { date: data.date }
                      : {},
              )}::jsonb,
              ${ctx.actor.type === 'staff' ? ctx.actor.id : null},
              -- Documents with passport numbers live a day, others a week.
              now() + case when ${PASSPORT_DOCUMENTS.includes(data.kind)} then interval '1 day' else interval '7 days' end)
      returning id`.execute(tx);
    const id = rows[0]!.id;
    await sql`select vs.enqueue_document(${id})`.execute(tx);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'document.requested',
      entity: 'document',
      entityId: id,
      after: {
        kind: data.kind,
        format: target.format,
        locale: data.locale,
        entity: target.entity,
        entity_id: target.entityId,
      },
    });
    return { documentId: id };
  });
}

export interface DocumentStatus {
  id: string;
  kind: string;
  format: string;
  locale: string;
  variant: string;
  status: 'pending' | 'ready' | 'failed';
  filename: string | null;
  error: string | null;
  requestedBy: string | null;
  createdAt: Date;
}

const statusColumns = [
  'id',
  'kind',
  'format',
  'locale',
  'variant',
  'status',
  'filename',
  'error',
  'requested_by as requestedBy',
  'created_at as createdAt',
] as const;

export async function getDocumentStatus(db: VsDatabase, ctx: EngineContext, documentId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const row = await tx
      .selectFrom('document')
      .select(statusColumns)
      .where('id', '=', documentId)
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    if (!row) throw new DomainError('NOT_FOUND', { message: 'Document not found or expired' });
    return row as DocumentStatus;
  });
}

/** Recent documents for a booking, departure or vessel (newest first, unexpired). */
export async function listDocuments(
  db: VsDatabase,
  ctx: EngineContext,
  input: { entity: 'booking' | 'leg' | 'vessel' | 'invoice'; entityId: string },
) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const rows = await tx
      .selectFrom('document')
      .select(statusColumns)
      .where('entity', '=', input.entity)
      .where('entity_id', '=', input.entityId)
      .where('expires_at', '>', sql<Date>`now()`)
      .orderBy('created_at', 'desc')
      .limit(20)
      .execute();
    return rows as DocumentStatus[];
  });
}

/** The file itself. Downloading a document with passport numbers is audited. */
export async function downloadDocument(db: VsDatabase, ctx: EngineContext, documentId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const row = await tx
      .selectFrom('document')
      .select(['id', 'kind', 'filename', 'content_type', 'content'])
      .where('id', '=', documentId)
      .where('status', '=', 'ready')
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    if (!row || !row.content)
      throw new DomainError('NOT_FOUND', { message: 'Document not ready or expired' });
    if (PASSPORT_DOCUMENTS.includes(row.kind)) {
      await audit(tx, ctx.operatorId, ctx.actor, {
        action: 'document.downloaded',
        entity: 'document',
        entityId: row.id,
        after: { kind: row.kind },
      });
    }
    return {
      filename: row.filename!,
      contentType: row.content_type!,
      content: Buffer.from(row.content),
    };
  });
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

export interface PendingDocument {
  id: string;
  kind: string;
  format: 'pdf' | 'xlsx' | 'png' | 'csv';
  locale: 'ar' | 'en' | 'both';
  variant: 'full' | 'agent';
  entityId: string;
  params: { from?: string; weeks?: number } & Record<string, unknown>;
}

/** Worker side: a pending document it renders itself (the nightly outage pack). */
export async function createPendingDocument(
  db: VsDatabase,
  ctx: EngineContext,
  input: { kind: 'outage_pack'; vesselId: string; locale: 'ar' | 'en' | 'both' },
): Promise<PendingDocument> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const row = await tx
      .insertInto('document')
      .values({
        operator_id: ctx.operatorId,
        kind: input.kind,
        format: 'pdf',
        locale: input.locale,
        entity: 'vessel',
        entity_id: input.vesselId,
        expires_at: sql<Date>`now() + interval '7 days'`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      kind: input.kind,
      format: 'pdf',
      locale: input.locale,
      variant: 'full',
      entityId: input.vesselId,
      params: {},
    };
  });
}

export async function loadPendingDocument(db: VsDatabase, ctx: EngineContext, documentId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const row = await tx
      .selectFrom('document')
      .select(['id', 'kind', 'format', 'locale', 'variant', 'entity_id', 'params'])
      .where('id', '=', documentId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      format: row.format,
      locale: row.locale,
      variant: row.variant,
      entityId: row.entity_id,
      params: row.params,
    } as PendingDocument;
  });
}

export async function completeDocument(
  db: VsDatabase,
  ctx: EngineContext,
  documentId: string,
  file: { filename: string; contentType: string; content: Buffer },
) {
  await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx
      .updateTable('document')
      .set({
        status: 'ready',
        filename: file.filename,
        content_type: file.contentType,
        content: file.content,
      })
      .where('id', '=', documentId)
      .where('status', '=', 'pending')
      .execute(),
  );
}

export async function failDocument(
  db: VsDatabase,
  ctx: EngineContext,
  documentId: string,
  error: string,
) {
  await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx
      .updateTable('document')
      .set({ status: 'failed', error: error.slice(0, 500) })
      .where('id', '=', documentId)
      .where('status', '=', 'pending')
      .execute(),
  );
}

/** Worker housekeeping: expired documents (manifests after a day) are deleted. */
export async function pruneDocuments(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const result = await sql`delete from vs.document where expires_at < now()`.execute(tx);
    return { pruned: Number(result.numAffectedRows ?? 0) };
  });
}
