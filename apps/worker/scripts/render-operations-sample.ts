/**
 * Renders the on-board operations documents (Batches D3 and D4) for the demo company's first departure
 * with guests, and the pre-departure sheet of its first booking, to files for checking layout
 * by eye. Local demo company only.
 *   pnpm --filter @vs/worker render-operations-sample <out-dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_OPERATOR_ID, openDatabase } from '@vs/engine';
import { loadConfig, systemActor } from '@vs/shared';
import { closeRenderer } from '../src/documents/render';
import { renderDocument } from '../src/tasks/document-jobs';

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error('usage: render-operations-sample <out-dir>');
const config = loadConfig();
if (config.VS_ENV === 'hosted') throw new Error('Local demo company only');
const worker = openDatabase('vs_worker', { config });
const ctx = { operatorId: DEMO_OPERATOR_ID, actor: systemActor('render-operations-sample') };
try {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
  const first = await worker.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx
      .selectFrom('booking_line as bl')
      .innerJoin('leg as l', 'l.id', 'bl.leg_id')
      .innerJoin('booking as b', 'b.id', 'bl.booking_id')
      .innerJoin('sailing as s', 's.id', 'b.sailing_id')
      .select(['l.id as leg_id', 'l.vessel_id', 'l.depart_date as depart', 'b.id as booking_id'])
      .where('b.status', '=', 'confirmed')
      .whereRef('s.embark_date', '=', 'l.depart_date')
      .where('l.depart_date', '>=', today)
      .orderBy('l.depart_date')
      .orderBy('b.ref')
      .executeTakeFirstOrThrow(),
  );
  const folio = await worker.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx
      .selectFrom('folio')
      .select(['id', 'vessel_id'])
      .orderBy('closed_at', (ob) => ob.desc().nullsLast())
      .executeTakeFirst(),
  );
  mkdirSync(outDir, { recursive: true });
  const jobs = [
    ...(
      [
        'diet_list',
        'occasion_list',
        'door_cards',
        'disembarkation_list',
        // D4
        'luggage_tags',
        'excursion_list',
        'table_plan',
        'muster_list',
        'feedback_forms',
      ] as const
    ).map((kind) => ({
      kind,
      entityId: first.leg_id,
      params: {},
    })),
    { kind: 'daily_programme', entityId: first.vessel_id, params: { from: first.depart, days: 3 } },
    { kind: 'predeparture', entityId: first.booking_id, params: {} },
    { kind: 'transfer_voucher', entityId: first.booking_id, params: {} },
    { kind: 'boarding_pass', entityId: first.booking_id, params: {} },
    { kind: 'housekeeping_sheet', entityId: first.vessel_id, params: { date: first.depart } },
    // E2: the folio most recently closed (else any), and today's shift report on its vessel.
    ...(folio
      ? [
          { kind: 'guest_folio', entityId: folio.id, params: {} },
          { kind: 'folio_shift_report', entityId: folio.vessel_id, params: { date: today } },
        ]
      : []),
  ];
  for (const job of jobs)
    for (const locale of ['en', 'ar'] as const) {
      const file = await renderDocument(worker, ctx, {
        id: 'sample',
        kind: job.kind,
        format: 'pdf',
        locale,
        variant: 'full',
        entityId: job.entityId,
        params: job.params,
      });
      writeFileSync(join(outDir, file.filename), file.content);
      console.log(join(outDir, file.filename));
    }
} finally {
  await closeRenderer();
  await worker.close();
}
