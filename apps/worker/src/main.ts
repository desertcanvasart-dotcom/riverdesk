import { createLogger, loadConfig } from '@vs/shared';
import { startWorker } from './worker';

const config = loadConfig();
const logger = createLogger('worker', { level: config.LOG_LEVEL });
const worker = await startWorker(config, { logger });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'stopping worker');
    void worker.stop().then(() => process.exit(0));
  });
}
