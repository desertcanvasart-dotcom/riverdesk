import type { Task } from 'graphile-worker';
import {
  activeVesselIds,
  bookingDocumentData,
  completeDocument,
  documentBrand,
  createPendingDocument,
  failDocument,
  getLegManifest,
  getOperatorSettings,
  loadPendingDocument,
  outagePackData,
  pruneDocuments,
  vacancyData,
  type EngineContext,
  type PendingDocument,
  type VsDatabase,
} from '@vs/engine';
import { captureError, systemActor, type Config, type Logger } from '@vs/shared';
import { mailer } from '../documents/mail';
import {
  bookingDocumentHtml,
  manifestHtml,
  outagePackHtml,
  roomingHtml,
  vacancyHtml,
} from '@vs/documents';
import { htmlToPdf, htmlToPng } from '../documents/render';
import { manifestXlsx, vacancyXlsx } from '../documents/xlsx';
import { forEachOperator } from './booking-jobs';

const TYPES = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
} as const;

/** Builds the file for one pending document. Never logs content (manifests hold passports). */
export async function renderDocument(db: VsDatabase, ctx: EngineContext, doc: PendingDocument) {
  const locale = doc.locale;
  const brand = await documentBrand(db, ctx);
  let content: Buffer;
  let base: string;
  switch (doc.kind) {
    case 'voucher':
    case 'itinerary':
    case 'payment_schedule':
    case 'cancellation_terms': {
      const data = await bookingDocumentData(db, ctx, doc.entityId);
      content = await htmlToPdf(
        bookingDocumentHtml(doc.kind, data, locale, doc.variant === 'agent', brand),
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
          ? await manifestXlsx(manifest, brand, locale, withPassports)
          : await htmlToPdf(
              withPassports
                ? manifestHtml(manifest, brand, locale, true)
                : roomingHtml(manifest, brand, locale),
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
          ? await vacancyXlsx(data, brand, locale)
          : doc.format === 'png'
            ? await htmlToPng(vacancyHtml(data, brand, locale))
            : await htmlToPdf(vacancyHtml(data, brand, locale));
      break;
    }
    case 'outage_pack': {
      const from = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(
        new Date(),
      );
      const data = await outagePackData(db, ctx, { vesselId: doc.entityId, from });
      base = `outage-pack-${from}`;
      content = await htmlToPdf(outagePackHtml(data, brand, locale));
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
      captureError(error, { documentId, kind: doc.kind });
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

/**
 * Nightly (spec § Availability, fallback for staff): for every active vessel, a PDF with the next
 * 14 days' availability and departure manifests, stored as a document and emailed to the
 * company's operations address. If the system is down the next day, staff still have it.
 */
export function outagePackTask(db: VsDatabase, logger: Logger, config: Config): Task {
  return () =>
    forEachOperator(db, logger, 'outage_pack', async (ctx) => {
      const settings = await getOperatorSettings(db, ctx);
      let sent = 0;
      let stored = 0;
      for (const vesselId of await activeVesselIds(db, ctx)) {
        const doc = await createPendingDocument(db, ctx, {
          kind: 'outage_pack',
          vesselId,
          locale: settings.defaultLocale === 'en' ? 'en' : 'ar',
        });
        const file = await renderDocument(db, ctx, doc);
        await completeDocument(db, ctx, doc.id, file);
        stored += 1;
        const mail = mailer(config);
        if (mail && settings.opsEmail) {
          await mail.sendMail({
            from: config.MAIL_FROM ?? 'vessel-system <no-reply@localhost>',
            to: settings.opsEmail,
            subject: `${settings.name}: ${file.filename}`,
            text: 'Availability and departure manifests for the next 14 days, in case the system is unavailable. Delete after use.',
            attachments: [
              { filename: file.filename, content: file.content, contentType: file.contentType },
            ],
          });
          sent += 1;
        }
      }
      if (stored > 0 && sent === 0)
        logger.warn(
          { operatorId: ctx.operatorId },
          'outage pack stored but not emailed (no SMTP_URL or ops email)',
        );
      return { stored, sent };
    });
}
