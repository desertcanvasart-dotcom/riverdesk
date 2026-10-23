import type { Task } from 'graphile-worker';
import { runInvariantChecks, type VsDatabase } from '@vs/engine';
import { systemActor, type Logger } from '@vs/shared';

/**
 * Rule 6: runs check_invariants() for every operator, each in its own tenant transaction, and
 * opens an exception for any violation. Scheduled nightly; also safe to run on demand.
 */
export function nightlyInvariants(db: VsDatabase, logger: Logger): Task {
  return async () => {
    const results = await runInvariantChecks(db, systemActor('nightly_invariants'));
    const violations = results.reduce((total, result) => total + result.violations, 0);
    const opened = results.reduce((total, result) => total + result.opened, 0);
    const log = violations > 0 ? logger.error.bind(logger) : logger.info.bind(logger);
    log({ operators: results.length, violations, opened }, 'nightly invariant check finished');
  };
}
