/**
 * Renders an invoice draft and a proforma for one booking (Arabic, English and bilingual) to
 * files, for checking layout by eye, then deletes both drafts. Local demo company only.
 *   pnpm --filter @vs/worker render-invoice-sample <booking-ref> <out-dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_OPERATOR_ID, createInvoiceDraft, deleteInvoiceDraft, openDatabase } from '@vs/engine';
import { loadConfig, systemActor } from '@vs/shared';
import { closeRenderer } from '../src/documents/render';
import { renderDocument } from '../src/tasks/document-jobs';

const [ref, outDir] = process.argv.slice(2);
if (!ref || !outDir) throw new Error('usage: render-invoice-sample <booking-ref> <out-dir>');
const config = loadConfig();
const db = openDatabase('vs_backoffice', { config });
const worker = openDatabase('vs_worker', { config });
const ctx = { operatorId: DEMO_OPERATOR_ID, actor: systemActor('render-invoice-sample') };
const drafts: string[] = [];
try {
  const booking = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx.selectFrom('booking').select('id').where('ref', '=', ref).executeTakeFirstOrThrow(),
  );
  mkdirSync(outDir, { recursive: true });
  for (const type of ['proforma', 'invoice'] as const) {
    const draft = await createInvoiceDraft(db, ctx, {
      type,
      bookingIds: [booking.id],
      notes: 'Sample',
    });
    drafts.push(draft.invoiceId);
    for (const locale of ['en', 'ar', 'both'] as const) {
      const file = await renderDocument(worker, ctx, {
        id: 'sample',
        kind: 'invoice',
        format: 'pdf',
        locale,
        variant: 'full',
        entityId: draft.invoiceId,
        params: {},
      });
      const name = `${type}-${file.filename}`;
      writeFileSync(join(outDir, name), file.content);
      console.log(join(outDir, name));
    }
  }
} finally {
  for (const id of drafts) await deleteInvoiceDraft(db, ctx, { invoiceId: id });
  await closeRenderer();
  await db.close();
  await worker.close();
}
