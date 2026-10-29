import { sql } from 'kysely';
import { z } from 'zod';
import type { VsDatabase } from '@vs/db';
import { audit } from '../audit';
import { parseInput, type EngineContext } from '../internal';
import { analyticsFilterInput } from './breakdowns';
import { cashReportInput } from './money';
import { analyticsOverviewInput, occupancyReportInput } from './reports';

/**
 * Analytics A1.3: an Excel export of one Analytics tab, rendered by the worker like any document.
 * Whether money columns are included is decided by the caller from the person's role and stored
 * with the request, never taken from the browser.
 */
export const analyticsExportInput = z.discriminatedUnion('report', [
  z.object({
    report: z.literal('overview'),
    locale: z.enum(['ar', 'en', 'both']),
    filter: analyticsOverviewInput,
  }),
  z.object({
    report: z.literal('occupancy'),
    locale: z.enum(['ar', 'en', 'both']),
    filter: occupancyReportInput,
  }),
  z.object({
    report: z.literal('channels'),
    locale: z.enum(['ar', 'en', 'both']),
    filter: analyticsFilterInput,
  }),
  z.object({
    report: z.literal('behaviour'),
    locale: z.enum(['ar', 'en', 'both']),
    filter: analyticsFilterInput,
  }),
  /** A2.1: money only; the router refuses it to roles without analytics.money. */
  z.object({
    report: z.literal('cash'),
    locale: z.enum(['ar', 'en', 'both']),
    filter: cashReportInput,
  }),
]);
export type AnalyticsExportInput = z.input<typeof analyticsExportInput>;

export interface AnalyticsExportParams {
  report: 'overview' | 'occupancy' | 'channels' | 'behaviour' | 'cash';
  filter: Record<string, unknown>;
  withMoney: boolean;
}

export async function requestAnalyticsExport(
  db: VsDatabase,
  ctx: EngineContext,
  input: AnalyticsExportInput,
  options: { withMoney: boolean },
) {
  const data = parseInput(analyticsExportInput, input);
  const params: AnalyticsExportParams = {
    report: data.report,
    filter: data.filter as Record<string, unknown>,
    withMoney: options.withMoney,
  };
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{ id: string }>`
      insert into vs.document (operator_id, kind, format, locale, variant, entity, entity_id, params, requested_by, expires_at)
      values (${ctx.operatorId}, 'analytics_export', 'xlsx', ${data.locale}, ${options.withMoney ? 'full' : 'agent'},
              'operator', ${ctx.operatorId}, ${JSON.stringify(params)}::jsonb,
              ${ctx.actor.type === 'staff' ? ctx.actor.id : null}, now() + interval '7 days')
      returning id`.execute(tx);
    const id = rows[0]!.id;
    await sql`select vs.enqueue_document(${id})`.execute(tx);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'document.requested',
      entity: 'document',
      entityId: id,
      after: { kind: 'analytics_export', report: data.report, withMoney: options.withMoney },
    });
    return { documentId: id };
  });
}
