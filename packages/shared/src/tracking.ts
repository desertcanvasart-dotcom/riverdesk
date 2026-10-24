import * as Sentry from '@sentry/node';
import type { Config } from './config';
import { redactDeep } from './redaction';

/**
 * Error tracking (Sentry), off unless SENTRY_DSN is set. Personal data never leaves: no default
 * PII, no request bodies, cookies or auth headers, no user, and every structure deep-redacted
 * (passport numbers, secrets, tokens) before it is sent.
 */
let enabled = false;

export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  delete event.user;
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.headers) {
      event.request.headers = Object.fromEntries(
        Object.entries(event.request.headers).filter(
          ([k]) => !/authorization|cookie|token|key/i.test(k),
        ),
      );
    }
  }
  if (event.extra) event.extra = redactDeep(event.extra);
  if (event.contexts) event.contexts = redactDeep(event.contexts);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) => ({
      ...b,
      data: b.data ? redactDeep(b.data) : undefined,
    }));
  }
  return event;
}

export function initErrorTracking(config: Config, service: string): void {
  if (!config.SENTRY_DSN || enabled) return;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.VS_ENV,
    serverName: service,
    // Collect nothing personal: no user, cookies, headers, query strings or bodies.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
  });
  Sentry.setTag('service', service);
  enabled = true;
}

export function captureError(error: unknown, context: Record<string, unknown> = {}): void {
  if (enabled) Sentry.captureException(error, { extra: redactDeep(context) });
}

/** Operational alerts (hold backlog, webhook failures …) go to Sentry as warnings to alert on. */
export function captureAlert(name: string, context: Record<string, unknown> = {}): void {
  if (enabled)
    Sentry.captureMessage(`alert:${name}`, {
      level: 'warning',
      extra: redactDeep(context),
      fingerprint: ['alert', name],
    });
}

export function flushErrorTracking(timeoutMs = 2000): Promise<boolean> {
  return enabled ? Sentry.flush(timeoutMs) : Promise.resolve(true);
}
