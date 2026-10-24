import { openDatabase } from '@vs/engine';
import {
  createLogger,
  flushErrorTracking,
  initErrorTracking,
  loadConfig,
  required,
} from '@vs/shared';
import { buildApp } from './app';

const config = loadConfig();
initErrorTracking(config, 'api');
const logger = createLogger('api', { level: config.LOG_LEVEL });
const db = openDatabase('vs_api', { config, logger });
const app = buildApp({
  db,
  logger,
  tokenSecret: Buffer.from(required(config, 'API_TOKEN_SECRET'), 'base64'),
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => db.close())
      .then(() => flushErrorTracking())
      .then(() => process.exit(0));
  });
}
