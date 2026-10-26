/**
 * Renders one booking's documents (Arabic, English and bilingual; full and agency copy) and its
 * first departure's manifest and rooming list to files, for checking layout by eye. Local demo company only; never prints document content.
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
  const leg = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx
      .selectFrom('booking_line')
      .innerJoin('leg', 'leg.id', 'booking_line.leg_id')
      .select('leg.id')
      .where('booking_line.booking_id', '=', booking.id)
      .orderBy('leg.depart_date')
      .executeTakeFirstOrThrow(),
  );
  for (const locale of ['en', 'ar', 'both'] as const) {
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
    for (const [kind, format] of [
      ['manifest', 'pdf'],
      ['rooming_list', 'pdf'],
      ['manifest', 'xlsx'],
    ] as const) {
      const file = await renderDocument(db, ctx, {
        id: 'sample',
        kind,
        format,
        locale,
        variant: 'full',
        entityId: leg.id,
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
