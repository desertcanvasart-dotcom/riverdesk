import { afterAll } from 'vitest';
import { closeOwner } from './env';
import { checkInvariantsEverywhere } from './invariants';

// Registered as a Vitest setup file: runs after every integration test file (rule 6) and fails
// the file if vs.check_invariants() returns any row.
afterAll(async () => {
  try {
    const violations = await checkInvariantsEverywhere();
    if (violations.length > 0) {
      throw new Error(
        `check_invariants() returned ${violations.length} violation(s):\n${JSON.stringify(violations, null, 2)}`,
      );
    }
  } finally {
    await closeOwner();
  }
});
