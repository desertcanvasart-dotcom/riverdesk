import {
  createLogger,
  exitOnUnhandledErrors,
  flushErrorTracking,
  initErrorTracking,
  loadConfig,
} from '@vs/shared';
import { startWorker } from './worker';

const config = loadConfig();
initErrorTracking(config, 'worker');
const logger = createLogger('worker', { level: config.LOG_LEVEL });
exitOnUnhandledErrors(logger);
const worker = await startWorker(config, { logger });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'stopping worker');
    void worker
      .stop()
      .then(() => flushErrorTracking())
      .then(() => process.exit(0));
  });
}
