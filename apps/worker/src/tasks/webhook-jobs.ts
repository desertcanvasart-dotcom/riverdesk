import { lookup, type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import type { Task } from 'graphile-worker';
import { Agent, fetch as undiciFetch } from 'undici';
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
import {
  isPublicAddress,
  loadConfig,
  systemActor,
  webhookUrlProblem,
  type Logger,
} from '@vs/shared';

const TIMEOUT_MS = 10_000;

/**
 * Hosted: connects only to public addresses, checked on the DNS answer used for the connection
 * itself, so a name that resolves inside (or is switched to an inside address later) is refused.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, '', 0);
    if (addresses.some((a) => !isPublicAddress(a.address)))
      return callback(
        Object.assign(new Error(`${hostname} resolves to a private address`), {
          code: 'EPRIVATEADDR',
        }),
        '',
        0,
      );
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};
const publicOnly = new Agent({ connect: { lookup: publicLookup } });
const publicFetch = ((url: string, init: RequestInit) =>
  undiciFetch(url, { ...(init as object), dispatcher: publicOnly })) as unknown as typeof fetch;

/**
 * One HTTP POST, signed; returns the status code or the error. Redirects are never followed (a
 * 3xx is a failed attempt). Hosted: https to public addresses only.
 */
export async function sendWebhook(
  delivery: DueDelivery,
  options: { fetchImpl?: typeof fetch; hosted?: boolean } = {},
) {
  const hosted = options.hosted ?? loadConfig().VS_ENV === 'hosted';
  const fetchImpl = options.fetchImpl ?? (hosted ? publicFetch : fetch);
  const body = JSON.stringify(eventJson(delivery.event));
  const timestamp = Math.floor(Date.now() / 1000);
  const started = Date.now();
  const problem = webhookUrlProblem(delivery.url, hosted);
  if (problem) return { statusCode: null, error: problem, durationMs: 0 };
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
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    const redirected = response.status >= 300 && response.status < 400;
    return {
      statusCode: response.status,
      error: response.ok
        ? null
        : redirected
          ? `HTTP ${response.status} (redirects are not followed)`
          : `HTTP ${response.status}`,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    // fetch reports "fetch failed"; a refused private address is worth saying.
    const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
    const message = cause?.code === 'EPRIVATEADDR' ? cause.message! : (error as Error).message;
    return { statusCode: null, error: message, durationMs: Date.now() - started };
  }
}

/**
 * Deliveries sent at the same time. A batch holds at most one per endpoint and resource, so order
 * per resource holds; a batch (3 rounds of 10 s at worst) stays well inside the 2-minute lease.
 */
const PARALLEL = 5;
/** No new batch is claimed after this; the rest is sent on the next run (every minute). */
const RUN_BUDGET_MS = 20_000;

/**
 * Fan out new events, then send what is due, for one operator: in parallel, and only for about
 * RUN_BUDGET_MS, so a receiver that times out (10 s an attempt) cannot hold the job for long.
 */
export async function runWebhooks(
  db: VsDatabase,
  ctx: EngineContext,
  fetchImpl?: typeof fetch,
  budgetMs = RUN_BUDGET_MS,
) {
  const { created } = await dispatchWebhooks(db, ctx);
  const deadline = Date.now() + budgetMs;
  let sent = 0;
  let failed = 0;
  while (Date.now() < deadline) {
    const due = await claimDueDeliveries(db, ctx, PARALLEL * 3);
    if (due.length === 0) break;
    const queue = [...due];
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
        for (let delivery = queue.shift(); delivery; delivery = queue.shift()) {
          const result = await sendWebhook(delivery, { fetchImpl });
          await recordDeliveryAttempt(db, ctx, {
            deliveryId: delivery.deliveryId,
            attempt: delivery.attempt,
            ...result,
          });
          if (result.error) failed += 1;
          else sent += 1;
        }
      }),
    );
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
