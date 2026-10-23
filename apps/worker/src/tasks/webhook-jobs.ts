import type { Task } from 'graphile-worker';
import {
  claimDueDeliveries,
  dispatchWebhooks,
  eventJson,
  listOperatorIds,
  pruneRateLimits,
  recordDeliveryAttempt,
  signWebhook,
  type DueDelivery,
  type EngineContext,
  type VsDatabase,
} from '@vs/engine';
import { systemActor, type Logger } from '@vs/shared';

const TIMEOUT_MS = 10_000;

/** One HTTP POST, signed; returns the status code or the error. */
export async function sendWebhook(delivery: DueDelivery, fetchImpl: typeof fetch = fetch) {
  const body = JSON.stringify(eventJson(delivery.event));
  const timestamp = Math.floor(Date.now() / 1000);
  const started = Date.now();
  try {
    const response = await fetchImpl(delivery.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'vessel-system-webhooks/1',
        'x-vs-signature': signWebhook(delivery.secret, body, timestamp),
        'x-vs-event-id': delivery.event.eventId,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    return {
      statusCode: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return { statusCode: null, error: (error as Error).message, durationMs: Date.now() - started };
  }
}

/** Fan out new events, then send what is due, for one operator. */
export async function runWebhooks(
  db: VsDatabase,
  ctx: EngineContext,
  fetchImpl: typeof fetch = fetch,
) {
  const { created } = await dispatchWebhooks(db, ctx);
  let sent = 0;
  let failed = 0;
  for (;;) {
    const due = await claimDueDeliveries(db, ctx, 50);
    if (due.length === 0) break;
    for (const delivery of due) {
      const result = await sendWebhook(delivery, fetchImpl);
      await recordDeliveryAttempt(db, ctx, {
        deliveryId: delivery.deliveryId,
        attempt: delivery.attempt,
        ...result,
      });
      if (result.error) failed += 1;
      else sent += 1;
    }
  }
  return { created, sent, failed };
}

/** Every minute: dispatch and deliver webhooks for every operator. */
export function webhooksTask(db: VsDatabase, logger: Logger): Task {
  return async () => {
    for (const operatorId of await listOperatorIds(db)) {
      try {
        const result = await runWebhooks(db, { operatorId, actor: systemActor('webhooks') });
        if (result.created + result.sent + result.failed > 0)
          logger.info({ operatorId, ...result }, 'webhooks');
      } catch (error) {
        logger.error({ err: error, operatorId }, 'webhooks failed for operator');
      }
    }
  };
}

/** Hourly housekeeping: old rate-limit windows. */
export function pruneRateLimitsTask(db: VsDatabase, logger: Logger): Task {
  return async () => {
    for (const operatorId of await listOperatorIds(db)) {
      await pruneRateLimits(db, { operatorId, actor: systemActor('prune_rate_limits') }).catch(
        (error: unknown) => logger.error({ err: error, operatorId }, 'prune failed'),
      );
    }
  };
}
