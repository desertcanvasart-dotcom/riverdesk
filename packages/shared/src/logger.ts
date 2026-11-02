import { pino, type Logger, type LoggerOptions } from 'pino';
import { isDatabaseError, redactDeep, scrubErrorText } from './redaction';

export type { Logger };

/** Postgres error fields that quote the values involved; the rest of the error is kept. */
const DATABASE_DETAIL = ['detail', 'where', 'internalQuery', 'parameters', 'hint'] as const;

/** pino's error serializer, without the values a Postgres error quotes back. */
function serializeError(error: unknown) {
  // Already serialized (see the log formatter), or not an error at all.
  if (!(error instanceof Error)) return error;
  const serialized = pino.stdSerializers.err(error as Error) as unknown as Record<string, unknown>;
  if (!serialized || typeof serialized !== 'object') return serialized;
  const fromDatabase = isDatabaseError(error);
  if (fromDatabase) for (const field of DATABASE_DETAIL) delete serialized[field];
  if (typeof serialized.message === 'string')
    serialized.message = scrubErrorText(serialized.message, fromDatabase);
  if (typeof serialized.stack === 'string')
    serialized.stack = scrubErrorText(serialized.stack, fromDatabase);
  return serialized;
}

/**
 * Structured JSON logger. Every log object is deep-redacted (passport numbers, dates of birth,
 * tokens, secrets) before it is written; request headers are covered by explicit paths too.
 */
export function createLogger(
  name: string,
  options: { level?: string; destination?: pino.DestinationStream } = {},
): Logger {
  const config: LoggerOptions = {
    name,
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization'],
      censor: '[REDACTED]',
    },
    formatters: {
      // Errors are serialized here, before redaction: redacting first would turn an Error into a
      // plain copy of its own fields (no message or stack, but Postgres's detail).
      log: (object) =>
        redactDeep(
          Object.fromEntries(
            Object.entries(object).map(([key, value]) => [
              key,
              value instanceof Error ? serializeError(value) : value,
            ]),
          ),
        ),
    },
    serializers: { err: serializeError },
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}
