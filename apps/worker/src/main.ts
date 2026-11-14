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
// Filled once the worker runs: a crash then gives its job locks back before the process exits.
const running: { worker?: Awaited<ReturnType<typeof startWorker>> } = {};
exitOnUnhandledErrors(logger, () => running.worker?.abandon());
const worker = await startWorker(config, { logger });
running.worker = worker;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'stopping worker');
    void worker
      .stop()
      .then(() => flushErrorTracking())
      .then(() => process.exit(0));
  });
}
