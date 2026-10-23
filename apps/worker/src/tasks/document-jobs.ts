import type { Task } from 'graphile-worker';
import {
  bookingDocumentData,
  completeDocument,
  failDocument,
  getLegManifest,
  loadPendingDocument,
  pruneDocuments,
  vacancyData,
  type EngineContext,
  type PendingDocument,
  type VsDatabase,
} from '@vs/engine';
import { systemActor, type Logger } from '@vs/shared';
import { htmlToPdf, htmlToPng } from '../documents/render';
import {
  bookingDocumentHtml,
  manifestHtml,
  roomingHtml,
  vacancyHtml,
} from '../documents/templates';
import { manifestXlsx, vacancyXlsx } from '../documents/xlsx';
import { forEachOperator } from './booking-jobs';

const TYPES = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
} as const;

async function operatorName(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(
    ctx.operatorId,
    ctx.actor,
    async ({ db: tx }) =>
      (await tx.selectFrom('operator').select('name').executeTakeFirstOrThrow()).name,
  );
}

/** Builds the file for one pending document. Never logs content (manifests hold passports). */
export async function renderDocument(db: VsDatabase, ctx: EngineContext, doc: PendingDocument) {
  const locale = doc.locale;
  let content: Buffer;
  let base: string;
  switch (doc.kind) {
    case 'voucher':
    case 'itinerary':
    case 'payment_schedule':
    case 'cancellation_terms': {
      const data = await bookingDocumentData(db, ctx, doc.entityId);
      content = await htmlToPdf(
        bookingDocumentHtml(doc.kind, data, locale, doc.variant === 'agent'),
      );
      base = `${data.booking.ref}-${doc.kind}${doc.variant === 'agent' ? '-agent' : ''}`;
      break;
    }
    case 'manifest':
    case 'rooming_list': {
      const withPassports = doc.kind === 'manifest';
      const manifest = await getLegManifest(db, ctx, doc.entityId, { withPassports });
      base = `${doc.kind}-${manifest.leg.departDate}-${manifest.leg.from.code}`;
      content =
        doc.format === 'xlsx'
          ? await manifestXlsx(manifest, locale, withPassports)
          : await htmlToPdf(
              withPassports
                ? manifestHtml(manifest, await operatorName(db, ctx), locale, true)
                : roomingHtml(manifest, await operatorName(db, ctx), locale),
            );
      break;
    }
    case 'vacancy_sheet': {
      const data = await vacancyData(db, ctx, {
        vesselId: doc.entityId,
        from: doc.params.from!,
        weeks: doc.params.weeks ?? 4,
      });
      base = `vacancy-${data.from}`;
      content =
        doc.format === 'xlsx'
          ? await vacancyXlsx(data, locale)
          : doc.format === 'png'
            ? await htmlToPng(vacancyHtml(data, locale))
            : await htmlToPdf(vacancyHtml(data, locale));
      break;
    }
    default:
      throw new Error(`Unknown document kind ${doc.kind}`);
  }
  return { filename: `${base}-${locale}.${doc.format}`, contentType: TYPES[doc.format], content };
}

/** Queued by vs.enqueue_document; payload { operator_id, document_id }. */
export function renderDocumentTask(db: VsDatabase, logger: Logger): Task {
  return async (payload, helpers) => {
    const { operator_id: operatorId, document_id: documentId } = payload as {
      operator_id: string;
      document_id: string;
    };
    const ctx: EngineContext = { operatorId, actor: systemActor('render_document') };
    const doc = await loadPendingDocument(db, ctx, documentId);
    if (!doc) return;
    try {
      const file = await renderDocument(db, ctx, doc);
      await completeDocument(db, ctx, documentId, file);
      logger.info(
        { documentId, kind: doc.kind, format: doc.format, bytes: file.content.length },
        'document rendered',
      );
    } catch (error) {
      logger.error({ err: error, documentId, kind: doc.kind }, 'document failed');
      // Graphile retries the job; the last attempt marks the document failed for the screen.
      if (helpers.job.attempts >= helpers.job.max_attempts) {
        await failDocument(
          db,
          ctx,
          documentId,
          error instanceof Error ? error.message : 'render failed',
        );
        return;
      }
      throw error;
    }
  };
}

/** Hourly: expired documents are deleted (manifests live a day). */
export function pruneDocumentsTask(db: VsDatabase, logger: Logger): Task {
  return () => forEachOperator(db, logger, 'prune_documents', (ctx) => pruneDocuments(db, ctx));
}
