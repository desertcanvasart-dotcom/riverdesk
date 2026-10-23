import 'server-only';
import { openDatabase, type VsDatabase } from '@vs/engine';
import { createLogger, loadConfig } from '@vs/shared';

let db: VsDatabase | undefined;

/** One pool per server process, as vs_backoffice. Opened lazily so builds need no database. */
export function backofficeDb(): VsDatabase {
  if (!db) {
    const config = loadConfig();
    db = openDatabase('vs_backoffice', {
      config,
      logger: createLogger('backoffice', { level: config.LOG_LEVEL }),
    });
  }
  return db;
}
