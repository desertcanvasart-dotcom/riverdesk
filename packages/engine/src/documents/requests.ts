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
] as const;
export const LEG_DOCUMENTS = ['manifest', 'rooming_list'] as const;

const locale = z.enum(['ar', 'en']);

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
) {
  const data = parseInput(requestDocumentInput, input);
  const target =
    'bookingId' in data
      ? { entity: 'booking', entityId: data.bookingId, format: 'pdf', table: 'booking' as const }
      : 'legId' in data
        ? { entity: 'leg', entityId: data.legId, format: data.format, table: 'leg' as const }
        : {
            entity: 'vessel',
            entityId: data.vesselId,
            format: data.format,
            table: 'vessel' as const,
          };
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const exists = await tx
      .selectFrom(target.table)
      .select('id')
      .where('id', '=', target.entityId)
      .executeTakeFirst();
    if (!exists) throw new DomainError('NOT_FOUND', { message: `${target.entity} not found` });
    const { rows } = await sql<{ id: string }>`
      insert into vs.document (operator_id, kind, format, locale, variant, entity, entity_id, params, requested_by, expires_at)
      values (${ctx.operatorId}, ${data.kind}, ${target.format}, ${data.locale}, ${'variant' in data ? data.variant : 'full'},
              ${target.entity}, ${target.entityId},
              ${JSON.stringify('vesselId' in data ? { from: data.from, weeks: data.weeks } : {})}::jsonb,
              ${ctx.actor.type === 'staff' ? ctx.actor.id : null},
              -- Manifests carry passport numbers: they live a day, other documents a week.
              now() + case when ${data.kind} = 'manifest' then interval '1 day' else interval '7 days' end)
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
  input: { entity: 'booking' | 'leg' | 'vessel'; entityId: string },
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

/** The file itself. Downloading a manifest (passport numbers) is audited. */
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
    if (row.kind === 'manifest') {
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
  format: 'pdf' | 'xlsx' | 'png';
  locale: 'ar' | 'en';
  variant: 'full' | 'agent';
  entityId: string;
  params: { from?: string; weeks?: number };
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
