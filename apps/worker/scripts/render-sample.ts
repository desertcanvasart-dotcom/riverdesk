/**
 * Renders one booking's documents (both languages, full and agency copy) to files, for checking
 * layout by eye. Local demo company only; never prints document content.
 *   pnpm --filter @vs/worker render-sample <booking-ref> <out-dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_OPERATOR_ID, openDatabase } from '@vs/engine';
import { loadConfig, systemActor } from '@vs/shared';
import { closeRenderer } from '../src/documents/render';
import { renderDocument } from '../src/tasks/document-jobs';

const [ref, outDir] = process.argv.slice(2);
if (!ref || !outDir) throw new Error('usage: render-sample <booking-ref> <out-dir>');
const db = openDatabase('vs_worker', { config: loadConfig() });
const ctx = { operatorId: DEMO_OPERATOR_ID, actor: systemActor('render-sample') };
try {
  const booking = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx.selectFrom('booking').select('id').where('ref', '=', ref).executeTakeFirstOrThrow(),
  );
  mkdirSync(outDir, { recursive: true });
  for (const locale of ['en', 'ar'] as const) {
    for (const [kind, variant] of [
      ['voucher', 'full'],
      ['voucher', 'agent'],
      ['payment_schedule', 'full'],
      ['cancellation_terms', 'full'],
    ] as const) {
      const file = await renderDocument(db, ctx, {
        id: 'sample',
        kind,
        format: 'pdf',
        locale,
        variant,
        entityId: booking.id,
        params: {},
      });
      writeFileSync(join(outDir, file.filename), file.content);
      console.log(join(outDir, file.filename));
    }
  }
} finally {
  await closeRenderer();
  await db.close();
}
