import { sql } from 'kysely';
import type { VsDatabase } from '@vs/db';
import type { EngineContext } from './internal';

export type AlertName =
  | 'invariant_violations'
  | 'hold_expiry_backlog'
  | 'allotment_release_failed'
  | 'webhook_failure_rate'
  | 'payment_exceptions';

export interface HealthAlert {
  name: AlertName;
  count: number;
  detail: Record<string, unknown>;
}

/**
 * The conditions the pilot is alerted on (spec Batch 7 § Observability), for one company. Read
 * only; the worker turns each into a log line at error level and a tracked alert.
 *   - invariant violations: open invariant exceptions;
 *   - hold-expiry backlog: active holds more than 5 minutes past their expiry;
 *   - failed allotment releases: unreleased allotment cabins whose release date has passed
 *     (a day of grace, since releases run every 15 minutes), or an open release exception;
 *   - webhook failure rate: over 10% of the last hour's attempts failed (at least 10 attempts);
 *   - new payment exceptions: late payments or paid-but-unavailable opened in the last window.
 */
export async function healthAlerts(
  db: VsDatabase,
  ctx: EngineContext,
  options: { windowMinutes?: number } = {},
): Promise<HealthAlert[]> {
  const window = options.windowMinutes ?? 5;
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
      invariants: number;
      backlog: number;
      oldest_backlog: Date | null;
      unreleased: number;
      release_exceptions: number;
      attempts: number;
      failed: number;
      payment_exceptions: number;
    }>`
      select
        (select count(*)::int from vs.exception where kind = 'invariant' and status in ('open', 'acknowledged')) as invariants,
        (select count(*)::int from vs.hold where status = 'active' and expires_at < now() - interval '5 minutes') as backlog,
        (select min(expires_at) from vs.hold where status = 'active' and expires_at < now() - interval '5 minutes') as oldest_backlog,
        (select count(*)::int from vs.inventory_bucket b join vs.allotment a on a.id = b.allotment_id join vs.leg l on l.id = b.leg_id
         where b.kind = 'allotment' and b.released_at is null and a.status = 'active'
           and l.depart_date - a.release_days < (now() at time zone 'Africa/Cairo')::date - 1) as unreleased,
        (select count(*)::int from vs.exception where kind = 'allotment_release_failure' and status = 'open') as release_exceptions,
        (select count(*)::int from vs.webhook_attempt where created_at > now() - interval '1 hour') as attempts,
        (select count(*)::int from vs.webhook_attempt where created_at > now() - interval '1 hour'
           and (status_code is null or status_code not between 200 and 299)) as failed,
        (select count(*)::int from vs.exception where kind in ('late_payment', 'paid_unavailable')
           and created_at > now() - make_interval(mins => ${window})) as payment_exceptions`.execute(
      tx,
    );
    const r = rows[0]!;
    const alerts: HealthAlert[] = [];
    if (r.invariants > 0)
      alerts.push({ name: 'invariant_violations', count: r.invariants, detail: {} });
    if (r.backlog > 0)
      alerts.push({
        name: 'hold_expiry_backlog',
        count: r.backlog,
        detail: { oldest_expired_at: r.oldest_backlog },
      });
    if (r.unreleased > 0 || r.release_exceptions > 0)
      alerts.push({
        name: 'allotment_release_failed',
        count: r.unreleased + r.release_exceptions,
        detail: { overdue_buckets: r.unreleased, open_exceptions: r.release_exceptions },
      });
    if (r.attempts >= 10 && r.failed / r.attempts > 0.1)
      alerts.push({
        name: 'webhook_failure_rate',
        count: r.failed,
        detail: { attempts: r.attempts, rate: Math.round((r.failed / r.attempts) * 100) / 100 },
      });
    if (r.payment_exceptions > 0)
      alerts.push({
        name: 'payment_exceptions',
        count: r.payment_exceptions,
        detail: { window_minutes: window },
      });
    return alerts;
  });
}
