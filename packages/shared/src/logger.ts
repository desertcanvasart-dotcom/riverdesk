import { pino, type Logger, type LoggerOptions } from 'pino';
import { redactDeep } from './redaction';

export type { Logger };

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
      log: (object) => redactDeep(object),
    },
    serializers: { err: pino.stdSerializers.err },
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}
